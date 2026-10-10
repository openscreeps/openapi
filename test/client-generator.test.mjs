import assert from 'node:assert/strict';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import ts from 'typescript';
import { generateClient, generateClientFiles } from '../scripts/generate-clients.mjs';
import { fixtureDocument, generateFixture, root } from './fixtures/client-fixture.mjs';

const directories = [];
after(() => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));

async function fixture(label) {
  const directory = await generateFixture(label);
  directories.push(directory);
  return directory;
}

/** Same strictness the OpenScreeps server compiles generated sources with. */
const compilerOptions = {
  target: ts.ScriptTarget.ES2024,
  lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
  types: [],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  allowImportingTsExtensions: true,
  noEmit: true,
};

function diagnostics(files) {
  const program = ts.createProgram(files, compilerOptions);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${diagnostic.file.fileName}:${line + 1}: ${message}`;
  });
}

test('generated client and handler contracts type-check; misuse is rejected', async () => {
  const directory = await fixture('types');
  await copyFile(resolve(root, 'test/fixtures/client-usage.ts'), resolve(directory, 'usage.ts'));
  assert.deepEqual(
    diagnostics([resolve(directory, 'index.ts'), resolve(directory, 'usage.ts')]),
    [],
  );
});

test('generation is deterministic and --check reports stale files without writing', async () => {
  const options = { document: fixtureDocument, name: 'fixture', runtime: '../runtime.js' };
  const first = await generateClientFiles(options);
  const second = await generateClientFiles(structuredClone(options));
  assert.deepEqual(Object.keys(first), ['schema.ts', 'index.ts']);
  assert.deepEqual(second, first);

  const directory = await fixture('check');
  const output = { document: fixtureDocument, output: directory, name: 'fixture' };
  const runtime = '../../../clients/runtime.ts';
  assert.deepEqual((await generateClient({ ...output, runtime, check: true })).stale, []);

  const index = resolve(directory, 'index.ts');
  await writeFile(index, 'stale');
  const checked = await generateClient({ ...output, runtime, check: true });
  assert.deepEqual(checked.stale, [index]);
  assert.equal(await readFile(index, 'utf8'), 'stale');

  const changed = structuredClone(fixtureDocument);
  changed.paths['/api/badge'].get.summary = 'Changed summary';
  await generateClient({ ...output, document: changed, runtime });
  const regenerated = await generateClient({ ...output, runtime, check: true });
  assert.ok(regenerated.stale.includes(index), 'changed documentation makes the client stale');
});

function withOperation(mutate) {
  const document = structuredClone(fixtureDocument);
  mutate(document, document.paths['/api/thing/{id}'].get);
  return generateClientFiles({ document, name: 'fixture', runtime: './runtime.js' });
}

test('unsupported or ambiguous documents fail generation', async () => {
  const cases = [
    [(d) => (d.openapi = '3.0.3'), /OpenAPI 3\.1 required/],
    [(d, op) => delete op.operationId, /operationId must be a JavaScript identifier/],
    [(d, op) => (op.operationId = 'get-thing'), /operationId must be a JavaScript identifier/],
    [(d, op) => (op.operationId = 'postThing'), /duplicate operationId postThing/],
    [(d, op) => (op.operationId = 'send'), /operationId send is reserved/],
    [(d, op) => op.parameters.push({ name: 'c', in: 'cookie', schema: {} }), /only path, query/],
    [(d, op) => op.parameters.push({ name: 'Accept', in: 'header', schema: {} }), /reserved/],
    [
      (d, op) => op.parameters.push({ name: 'q', in: 'query', style: 'deepObject', schema: {} }),
      /style deepObject is unsupported/,
    ],
    [
      (d, op) =>
        op.parameters.push({ name: 'q', in: 'query', 'x-openscreeps-wildcard': true, schema: {} }),
      /path parameters only/,
    ],
    [(d, op) => op.parameters.push({ name: 'gone', in: 'path', required: true }), /templated/],
    [(d) => (d.paths['/api/thing/{id}'].parameters = []), /path parameter id/],
    [(d, op) => (op.security = [{ Unused: [] }]), /security scheme Unused is unsupported/],
    [(d, op) => (op.security = [{ Missing: [] }]), /unknown security scheme Missing/],
    [(d, op) => op.parameters.push({ $ref: 'other.json#/x' }), /external \$ref/],
    [(d, op) => (op.servers = [{ url: 'https://elsewhere.test' }]), /servers are unsupported/],
  ];
  for (const [mutate, expected] of cases) {
    await assert.rejects(withOperation(mutate), expected);
  }
  await assert.rejects(
    generateClientFiles({ document: fixtureDocument, name: 'Bad Name', runtime: './r.js' }),
    /name must match/,
  );
});

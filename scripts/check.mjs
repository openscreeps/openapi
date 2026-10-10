import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const spec = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
const coverage = JSON.parse(await readFile(new URL('../coverage.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
for (const name of ['binary', 'byte', 'int32', 'int64', 'float', 'double', 'password'])
  ajv.addFormat(name, true);
ajv.addSchema({ $id: 'urn:screeps:contract', components: spec.components });
let compiled = 0;
function compile(schema) {
  return ajv.compile({ components: spec.components, ...schema });
}
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  const validate = ajv.getSchema(`urn:screeps:contract#/components/schemas/${name}`);
  assert.ok(validate, `Schema ${name} must compile`);
  for (const example of schema.examples ?? [])
    assert.ok(validate(example), `${name} example: ${ajv.errorsText(validate.errors)}`);
  compiled++;
}
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const ids = new Set();
const operations = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    const key = `${method} ${path}`;
    assert.ok(
      operation.operationId && !ids.has(operation.operationId),
      `Unique operationId required: ${key}`,
    );
    ids.add(operation.operationId);
    assert.ok(Array.isArray(operation.security), `Explicit security required: ${key}`);
    assert.ok(operation.description?.length > 20, `Behavior description required: ${key}`);
    assert.ok(operation['x-sources']?.length, `Evidence required: ${key}`);
    for (const source of operation['x-sources']) {
      assert.match(
        source,
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\/.+#L\d+/,
        `Pinned source required: ${key}`,
      );
    }
    for (const target of ['screeps-com', 'openscreeps']) {
      assert.ok(
        ['supported', 'unsupported', 'unverified'].includes(operation['x-availability']?.[target]),
        `Availability required for ${target}: ${key}`,
      );
    }
    for (const parameter of operation.parameters ?? []) {
      if (parameter.schema) compile(parameter.schema);
    }
    for (const media of Object.values(operation.requestBody?.content ?? {}))
      if (media.schema) compile(media.schema);
    for (const response of Object.values(operation.responses)) {
      for (const media of Object.values(response.content ?? {})) {
        if (!media.schema) continue;
        const validate = compile(media.schema);
        if ('example' in media)
          assert.ok(
            validate(media.example),
            `${key} response example: ${ajv.errorsText(validate.errors)}`,
          );
      }
    }
    operations.push(key);
  }
}
const exclusions = new Map(
  coverage.exclusions.map((entry) => [`${entry.method} ${entry.path}`, entry.reason]),
);
for (const route of coverage.routes) {
  const key = `${route.method} ${route.path}`;
  if (exclusions.has(key)) continue;
  const operation = spec.paths[route.path]?.[route.method];
  assert.ok(operation, `Uncovered source operation: ${key} at ${route.source}:${route.line}`);
  if (route.source.startsWith('.sources/server/'))
    assert.equal(
      operation['x-availability'].openscreeps,
      'supported',
      `Implemented OpenScreeps route marked unavailable: ${key}`,
    );
}
function references(value) {
  if (!value || typeof value !== 'object') return;
  if ('$ref' in value) {
    assert.ok(value.$ref.startsWith('#/'), `Bundle must be self-contained: ${value.$ref}`);
    let target = spec;
    for (const part of value.$ref.slice(2).split('/'))
      target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    assert.notEqual(target, undefined, `Unresolved reference ${value.$ref}`);
  }
  for (const child of Object.values(value)) references(child);
}
references(spec);
console.log(
  `Validated ${operations.length} operations, ${compiled} component schemas, all references and ${coverage.routes.length} source declarations (${exclusions.size} documented exclusions).`,
);

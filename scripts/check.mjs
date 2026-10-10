// Offline contract validation of the built official document, the built profiles and the
// committed source inventory (coverage.json). Needs no .sources; run scripts/build.mjs first.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { composeProfile, listOperations } from '../lib/contracts.mjs';

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const spec = await readJson('openapi.json');
const coverage = await readJson('coverage.json');
const official = coverage.sources.officialClient;
const officialSource = new RegExp(
  `^${escapeRegExp(official.entry)}[\\w/.-]+\\.js\\?bust=${official.bust}#L\\d+C\\d+$`,
);
const pinnedRepositories = Object.values(coverage.sources)
  .filter((source) => source.repository)
  .map((source) => `${source.repository.replace('https://github.com/', '')}@${source.commit}`);
const pinnedSource = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([0-9a-f]{40})\/.+#L\d+/;
const officialRepositories = new Set(
  ['client', 'backend'].map(
    (key) =>
      `${coverage.sources[key].repository.replace('https://github.com/', '')}@${coverage.sources[key].commit}`,
  ),
);

function ajvFor(document) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const name of ['binary', 'byte', 'int32', 'int64', 'float', 'double', 'password'])
    ajv.addFormat(name, true);
  ajv.addSchema({ $id: 'urn:screeps:contract', components: document.components });
  return ajv;
}

/** Schema, example, reference and operation hygiene shared by official and composed documents. */
function validateDocument(document, label, { evidence }) {
  const ajv = ajvFor(document);
  const compile = (schema) => ajv.compile({ components: document.components, ...schema });
  let schemas = 0;
  for (const [name, schema] of Object.entries(document.components.schemas ?? {})) {
    const validate = ajv.getSchema(`urn:screeps:contract#/components/schemas/${name}`);
    assert.ok(validate, `${label}: schema ${name} must compile`);
    for (const example of schema.examples ?? [])
      assert.ok(validate(example), `${label} ${name} example: ${ajv.errorsText(validate.errors)}`);
    schemas++;
  }
  const ids = new Set();
  const operations = listOperations(document);
  for (const { method, path, operationId, operation } of operations) {
    const key = `${label} ${method} ${path}`;
    assert.ok(operationId && !ids.has(operationId), `Unique operationId required: ${key}`);
    ids.add(operationId);
    assert.ok(Array.isArray(operation.security), `Explicit security required: ${key}`);
    assert.ok(operation.description?.length > 20, `Behavior description required: ${key}`);
    assert.ok(operation['x-sources']?.length, `Evidence required: ${key}`);
    for (const source of operation['x-sources']) evidence(key, source);
    for (const parameter of operation.parameters ?? [])
      if (parameter.schema) compile(parameter.schema);
    for (const media of Object.values(operation.requestBody?.content ?? {}))
      if (media.schema) compile(media.schema);
    for (const response of Object.values(operation.responses ?? {})) {
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
  }
  const references = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      assert.ok(value.$ref.startsWith('#/'), `${label} must be self-contained: ${value.$ref}`);
      let target = document;
      for (const part of value.$ref.slice(2).split('/'))
        target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
      assert.notEqual(target, undefined, `${label}: unresolved reference ${value.$ref}`);
    }
    for (const child of Object.values(value)) references(child);
  };
  references(document);
  return { operations, schemas };
}

// Official document: official-only scope, availability and evidence.
const officialResult = validateDocument(spec, 'official', {
  evidence(key, source) {
    if (officialSource.test(source)) return;
    const match = pinnedSource.exec(source);
    assert.ok(match, `Pinned source required: ${key}: ${source}`);
    assert.ok(
      officialRepositories.has(`${match[1]}@${match[2]}`),
      `Official evidence must come from the official client, node-screeps-api or backend-local pins: ${key}: ${source}`,
    );
  },
});
assert.deepEqual(
  Object.keys(spec.components.securitySchemes),
  ['Token'],
  'The official document declares only the Token security scheme',
);
for (const { method, path, operation } of officialResult.operations) {
  const key = `${method} ${path}`;
  assert.deepEqual(
    Object.keys(operation['x-availability'] ?? {}),
    ['screeps-com'],
    `Official availability must be keyed by screeps-com only: ${key}`,
  );
  assert.ok(
    ['supported', 'unverified'].includes(operation['x-availability']['screeps-com']),
    `Official availability must be supported or unverified: ${key}`,
  );
  for (const target of Object.keys(operation['x-compatibility'] ?? {}))
    assert.equal(
      target,
      'screeps-com',
      `Official compatibility notes are screeps-com only: ${key}`,
    );
  for (const requirement of operation.security)
    for (const scheme of Object.keys(requirement))
      assert.equal(scheme, 'Token', `Official operations use only Token security: ${key}`);
  if (operation['x-unverified'] !== undefined)
    assert.ok(operation['x-unverified'].length > 10, `x-unverified must explain the gap: ${key}`);
}
const strings = (value, path, found) => {
  if (typeof value === 'string') found.push([path, value]);
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value))
      if (key !== 'x-sources') strings(child, `${path}/${key}`, found);
  return found;
};
for (const [path, text] of strings({ paths: spec.paths, components: spec.components }, '#', []))
  assert.doesNotMatch(
    text,
    /openscreeps|standalone/i,
    `Official document must not describe standalone servers: ${path}`,
  );

// Source coverage: every discovered official request and reference route is accounted for.
const shape = (path) => path.replace(/\{[^}]+\}/g, '{}');
const officialByRoute = new Map(
  officialResult.operations.map((entry) => [`${entry.method} ${shape(entry.path)}`, entry]),
);
const exclusions = new Map(
  coverage.exclusions.map((entry) => [`${entry.method} ${shape(entry.path)}`, entry.reason]),
);
const evidenced = new Set();

// Profiles: rebuild-free composition of each committed profile with empty extensions.
const profiles = {};
for (const name of (await readdir(new URL('../profiles/', import.meta.url))).sort()) {
  if (!name.endsWith('.json')) continue;
  const profile = await readJson(`profiles/${name}`);
  const composed = composeProfile(spec, profile);
  validateDocument(composed, `profile ${profile.name}`, {
    evidence(key, source) {
      assert.ok(
        officialSource.test(source) ||
          (pinnedSource.test(source) &&
            pinnedRepositories.includes(
              `${pinnedSource.exec(source)[1]}@${pinnedSource.exec(source)[2]}`,
            )),
        `Pinned source required: ${key}: ${source}`,
      );
    },
  });
  profiles[profile.name] = { profile, composed };
}
const standalone = profiles.standalone;
assert.ok(standalone, 'profiles/standalone.json is required');
const additionsByRoute = new Map(
  listOperations(standalone.composed)
    .filter((entry) => entry.operation['x-profile'].status === 'addition')
    .map((entry) => [`${entry.method} ${shape(entry.path)}`, entry]),
);
const standaloneByRoute = new Map(
  listOperations(standalone.composed).map((entry) => [
    `${entry.method} ${shape(entry.path)}`,
    entry,
  ]),
);

let officialRequests = 0;
for (const request of coverage.officialRequests) {
  const key = `${request.method} ${shape(request.path)}`;
  const target =
    request.branch === 'private-server'
      ? (additionsByRoute.get(key) ?? officialByRoute.get(key))
      : officialByRoute.get(key);
  assert.ok(target, `Official web client request not in the contract: ${key} at ${request.source}`);
  assert.ok(
    target.operation['x-sources'].includes(request.source),
    `${target.operationId} must cite official client call site ${request.source}`,
  );
  evidenced.add(target.operationId);
  officialRequests++;
}
for (const route of coverage.routes) {
  const key = `${route.method} ${shape(route.path)}`;
  if (exclusions.has(key)) continue;
  const where = `${route.source}:${route.line}`;
  if (route.origin === 'openscreeps') {
    const target = standaloneByRoute.get(key);
    assert.ok(
      target,
      `OpenScreeps route ${key} at ${where} is neither in the standalone profile nor a documented extension`,
    );
    continue;
  }
  const target = officialByRoute.get(key) ?? additionsByRoute.get(key);
  assert.ok(target, `Uncovered ${route.origin} route: ${key} at ${where}`);
  evidenced.add(target.operationId);
}
for (const { operationId, method, path } of officialResult.operations)
  assert.ok(
    evidenced.has(operationId),
    `Official operation ${operationId} (${method} ${path}) has no inventoried source declaration`,
  );

console.log(
  `Validated ${officialResult.operations.length} official operations, ${officialResult.schemas} component schemas, ${officialRequests} official client request sites (bust ${official.bust}), ${coverage.routes.length} reference routes (${exclusions.size} documented exclusions) and profiles: ${Object.entries(
    profiles,
  )
    .map(([name, { composed }]) => `${name} (${listOperations(composed).length} operations)`)
    .join(', ')}.`,
);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Offline contract validation of the built official HTTP and socket documents, the built
// profiles and the committed source inventory (coverage.json). Needs no .sources; run
// scripts/build.mjs first.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  composePlugin,
  composePlugins,
  composeProfile,
  composeSocketProfile,
  listOperations,
} from '../lib/contracts.mjs';

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

// Official evidence: the official client, node-screeps-api or backend-local pins.
function officialEvidence(key, source) {
  if (officialSource.test(source)) return;
  const match = pinnedSource.exec(source);
  assert.ok(match, `Pinned source required: ${key}: ${source}`);
  assert.ok(
    officialRepositories.has(`${match[1]}@${match[2]}`),
    `Official evidence must come from the official client, node-screeps-api or backend-local pins: ${key}: ${source}`,
  );
}

// Profile evidence: the official client or any pinned reference repository.
function pinnedEvidence(key, source) {
  const match = pinnedSource.exec(source);
  assert.ok(
    officialSource.test(source) ||
      (match && pinnedRepositories.includes(`${match[1]}@${match[2]}`)),
    `Pinned source required: ${key}: ${source}`,
  );
}

// Official document: official-only scope, availability and evidence.
const officialResult = validateDocument(spec, 'official', { evidence: officialEvidence });
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
const excluded = (route) =>
  coverage.exclusions.some(
    (entry) =>
      `${entry.method} ${shape(entry.path)}` === `${route.method} ${shape(route.path)}` &&
      (entry.origin === undefined || entry.origin === route.origin),
  );
const evidenced = new Set();
const byRoute = (operations) =>
  new Map(operations.map((entry) => [`${entry.method} ${shape(entry.path)}`, entry]));
const additionsOf = (document, status) =>
  byRoute(
    listOperations(document).filter(
      (entry) =>
        entry.operation['x-profile'].status === status ||
        entry.operation['x-plugins']?.some((plugin) => plugin.status === status),
    ),
  );

// Profiles: rebuild-free composition of each committed profile with empty extensions.
const profiles = {};
for (const name of (await readdir(new URL('../profiles/', import.meta.url))).sort()) {
  if (!name.endsWith('.json')) continue;
  const profile = await readJson(`profiles/${name}`);
  const composed = composeProfile(spec, profile);
  validateDocument(composed, `profile ${profile.name}`, { evidence: pinnedEvidence });
  profiles[profile.name] = { profile, composed };
}
const { standalone, community } = profiles;
assert.ok(standalone, 'profiles/standalone.json is required');
assert.ok(community, 'profiles/community.json is required');
const additionsByRoute = additionsOf(standalone.composed, 'addition');
const standaloneByRoute = byRoute(listOperations(standalone.composed));
const communityAdditionsByRoute = additionsOf(community.composed, 'addition');

// Plugins: each composes on its base profile alone, and every plugin of a base composes in
// file order; their evidence is the plugin's own pinned repository, backend-local,
// node-screeps-api or the official client.
const plugins = [];
for (const name of (await readdir(new URL('../plugins/', import.meta.url))).sort()) {
  if (!name.endsWith('.json')) continue;
  const plugin = await readJson(`plugins/${name}`);
  assert.equal(`${plugin.name}.json`, name, `plugins/${name} must be named after its plugin`);
  const source = coverage.sources[plugin.source];
  assert.ok(source?.repository, `plugins/${name}: source ${plugin.source} must be pinned`);
  const own = `${source.repository.replace('https://github.com/', '')}@${source.commit}`;
  const evidence = (key, url) => {
    if (officialSource.test(url)) return;
    const match = pinnedSource.exec(url);
    assert.ok(match, `Pinned source required: ${key}: ${url}`);
    const pin = `${match[1]}@${match[2]}`;
    assert.ok(
      pin === own || officialRepositories.has(pin),
      `Plugin evidence must come from ${own}, backend-local, node-screeps-api or the official client: ${key}: ${url}`,
    );
  };
  for (const [index, entry] of (plugin.behaviour ?? []).entries())
    for (const url of entry.evidence) evidence(`plugin ${plugin.name} behaviour[${index}]`, url);
  const base = profiles[plugin.base];
  assert.ok(base, `plugins/${name}: base profile ${plugin.base} is not built`);
  const composed = composePlugin(spec, base.composed, plugin);
  validateDocument(composed, `plugin ${plugin.name}`, { evidence });
  plugins.push({ plugin, composed, evidence });
}
const pluginStacks = {};
for (const { plugin } of plugins) (pluginStacks[plugin.base] ??= []).push(plugin);
const stacked = Object.entries(pluginStacks).map(([base, stack]) => {
  const composed = composePlugins(spec, profiles[base].composed, stack);
  validateDocument(composed, `profile ${base} with ${stack.map((p) => p.name).join(' + ')}`, {
    evidence: pinnedEvidence,
  });
  return { base, stack, composed };
});
const pluginAdditionsByRoute = new Map(
  stacked.flatMap(({ composed }) => [...additionsOf(composed, 'addition')]),
);

// The community profile describes stock backend-local exactly: it requires the official
// operations backend-local routes, no others, and adds every non-official backend-local route.
const backendRoutes = coverage.routes.filter((route) => route.origin === 'backend-local');
const backendOfficial = new Set(
  backendRoutes
    .map((route) => officialByRoute.get(`${route.method} ${shape(route.path)}`)?.operationId)
    .filter(Boolean),
);
assert.deepEqual(
  [...community.profile.required].sort(),
  [...backendOfficial].sort(),
  'The community profile must require exactly the official operations backend-local routes',
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
  if (excluded(route)) continue;
  const key = `${route.method} ${shape(route.path)}`;
  const where = `${route.source}:${route.line}`;
  if (route.origin === 'openscreeps') {
    const target = standaloneByRoute.get(key);
    assert.ok(
      target,
      `OpenScreeps route ${key} at ${where} is neither in the standalone profile nor a documented extension`,
    );
    continue;
  }
  if (route.origin === 'backend-local') {
    const target = officialByRoute.get(key) ?? communityAdditionsByRoute.get(key);
    assert.ok(
      target,
      `backend-local route ${key} at ${where} is neither official nor a community addition`,
    );
    evidenced.add(target.operationId);
    continue;
  }
  const target =
    officialByRoute.get(key) ??
    additionsByRoute.get(key) ??
    communityAdditionsByRoute.get(key) ??
    pluginAdditionsByRoute.get(key);
  assert.ok(target, `Uncovered ${route.origin} route: ${key} at ${where}`);
  evidenced.add(target.operationId);
}
for (const { operationId, method, path } of officialResult.operations)
  assert.ok(
    evidenced.has(operationId),
    `Official operation ${operationId} (${method} ${path}) has no inventoried source declaration`,
  );

// Socket contract (AsyncAPI 3.0; payload schemas are draft-07 AsyncAPI schemas).
const socket = await readJson('asyncapi.json');

function validateSocket(document, label, { evidence }) {
  assert.equal(document.asyncapi, '3.0.0', `${label}: AsyncAPI 3.0.0 required`);
  const messages = document.components?.messages ?? {};
  const schemas = document.components?.schemas ?? {};
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema({
    $id: 'urn:screeps:socket',
    components: { schemas },
    payloads: Object.fromEntries(
      Object.entries(messages).map(([name, message]) => [name, message.payload]),
    ),
  });
  const compiled = (pointer) => {
    const validate = ajv.getSchema(`urn:screeps:socket#${pointer}`);
    assert.ok(validate, `${label}: ${pointer} must compile`);
    return validate;
  };
  for (const [name, schema] of Object.entries(schemas)) {
    const validate = compiled(`/components/schemas/${name}`);
    for (const example of schema.examples ?? [])
      assert.ok(validate(example), `${label} ${name} example: ${ajv.errorsText(validate.errors)}`);
  }
  for (const [name, message] of Object.entries(messages)) {
    const key = `${label} message ${name}`;
    assert.equal(message.name, name, `Message name must match its key: ${key}`);
    assert.ok(message.summary?.length > 10, `Summary required: ${key}`);
    assert.ok(message.description?.length > 20, `Behavior description required: ${key}`);
    assert.ok(
      ['text/plain', 'application/json'].includes(message.contentType),
      `Explicit text/plain or application/json content type required: ${key}`,
    );
    assert.ok(message['x-sources']?.length, `Evidence required: ${key}`);
    for (const source of message['x-sources']) evidence(key, source);
    if (message['x-unverified'] !== undefined)
      assert.ok(message['x-unverified'].length > 10, `x-unverified must explain the gap: ${key}`);
    const validate = compiled(`/payloads/${name}`);
    assert.ok(message.examples?.length, `Example required: ${key}`);
    for (const example of message.examples)
      assert.ok(
        validate(example.payload),
        `${key} example ${example.name}: ${ajv.errorsText(validate.errors)}`,
      );
  }
  const [channelName, ...otherChannels] = Object.keys(document.channels ?? {});
  assert.ok(channelName && !otherChannels.length, `${label}: exactly one channel required`);
  const channel = document.channels[channelName];
  assert.deepEqual(
    Object.keys(channel.messages).sort(),
    Object.keys(messages).sort(),
    `${label}: the channel must offer every message exactly once`,
  );
  for (const [name, reference] of Object.entries(channel.messages))
    assert.equal(reference.$ref, `#/components/messages/${name}`, `${label}: channel ${name}`);
  const offered = new Set();
  for (const [name, operation] of Object.entries(document.operations ?? {})) {
    const key = `${label} operation ${name}`;
    assert.ok(['send', 'receive'].includes(operation.action), `send or receive required: ${key}`);
    assert.equal(operation.channel?.$ref, `#/channels/${channelName}`, `Channel required: ${key}`);
    assert.ok(operation.description?.length > 10, `Behavior description required: ${key}`);
    assert.ok(operation.messages?.length, `Messages required: ${key}`);
    for (const reference of [...operation.messages, ...(operation.reply?.messages ?? [])]) {
      const match = /^#\/channels\/[^/]+\/messages\/(.+)$/.exec(reference.$ref);
      assert.ok(match && channel.messages[match[1]], `${key} references ${reference.$ref}`);
      offered.add(match[1]);
    }
  }
  for (const name of Object.keys(messages))
    assert.ok(offered.has(name), `${label}: message ${name} belongs to no operation`);
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
  return { messages: Object.keys(messages).length, schemas: Object.keys(schemas).length };
}

const socketResult = validateSocket(socket, 'official socket', { evidence: officialEvidence });
for (const [name, message] of Object.entries(socket.components.messages)) {
  assert.deepEqual(
    Object.keys(message['x-availability'] ?? {}),
    ['screeps-com'],
    `Official socket availability must be keyed by screeps-com only: ${name}`,
  );
  assert.ok(
    ['supported', 'unverified'].includes(message['x-availability']['screeps-com']),
    `Official socket availability must be supported or unverified: ${name}`,
  );
}
for (const [path, text] of strings(
  { channels: socket.channels, operations: socket.operations, components: socket.components },
  '#',
  [],
))
  assert.doesNotMatch(
    text,
    /openscreeps|standalone/i,
    `Official socket document must not describe standalone servers: ${path}`,
  );

// Socket payloads that deliberately differ from the HTTP schema of the same name.
const socketOnlyShapes = {
  UserMessage: 'complete when sent, only `_id` and `unread` when marked read',
};

/**
 * Socket room objects and the HTTP room objects are one contract under two names: every socket
 * `RoomObject*` schema (except patches) must equal its HTTP `GameRoomObject*` schema, and other
 * socket schemas named like an HTTP schema must equal it, ignoring documentation keywords.
 */
function assertSharedSchemas(http, socketDocument, label) {
  const documentation = new Set(['description', 'examples', 'title']);
  const shape = (value) => {
    if (typeof value === 'string')
      return value.replace(
        /^#\/components\/schemas\/RoomObject/,
        '#/components/schemas/GameRoomObject',
      );
    if (Array.isArray(value)) return value.map(shape);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !documentation.has(key) && !key.startsWith('x-'))
        .map(([key, child]) => [key, shape(child)]),
    );
  };
  const httpSchemas = http.components.schemas;
  const socketSchemas = socketDocument.components.schemas;
  for (const [name, schema] of Object.entries(socketSchemas)) {
    const counterpart = /^RoomObject(?!.*Patch$)/.test(name) ? `Game${name}` : name;
    if (!httpSchemas[counterpart] || Object.hasOwn(socketOnlyShapes, name)) continue;
    assert.deepEqual(
      shape(schema),
      shape(httpSchemas[counterpart]),
      `${label}: socket schema ${name} must match HTTP schema ${counterpart}`,
    );
  }
  for (const name of Object.keys(httpSchemas).filter((key) =>
    /^GameRoomObject(?!sResponse$)/.test(key),
  ))
    assert.ok(socketSchemas[name.slice(4)], `${label}: socket schema ${name.slice(4)} is missing`);
}

assertSharedSchemas(spec, socket, 'official');
const socketProfiles = {};
for (const { profile, composed: http } of Object.values(profiles)) {
  const composed = composeSocketProfile(socket, profile);
  validateSocket(composed, `profile ${profile.name} socket`, { evidence: pinnedEvidence });
  for (const [name, message] of Object.entries(composed.components.messages))
    assert.ok(message['x-profile']?.status, `profile ${profile.name} socket ${name}: x-profile`);
  // Payload overrides may rename the channel (first tuple item) but must keep the official data
  // schema; a real data difference belongs in a component schema override with a reason.
  for (const [name, message] of Object.entries(composed.components.messages)) {
    const official = socket.components.messages[name]?.payload?.items;
    if (!Array.isArray(official) || !Array.isArray(message.payload?.items)) continue;
    assert.deepEqual(
      message.payload.items.slice(1),
      official.slice(1),
      `profile ${profile.name} socket ${name}: payload data must match the official message`,
    );
  }
  assertSharedSchemas(http, composed, `profile ${profile.name}`);
  socketProfiles[profile.name] = Object.keys(composed.components.messages).length;
}

console.log(
  `Validated ${officialResult.operations.length} official operations, ${officialResult.schemas} component schemas, ${officialRequests} official client request sites (bust ${official.bust}), ${coverage.routes.length} reference routes (${coverage.exclusions.length} documented exclusions), ${socketResult.messages} official socket messages (${socketResult.schemas} schemas), profiles: ${Object.entries(
    profiles,
  )
    .map(
      ([name, { composed }]) =>
        `${name} (${listOperations(composed).length} operations, ${socketProfiles[name]} socket messages)`,
    )
    .join(', ')} and plugins: ${stacked
    .map(
      ({ base, stack, composed }) =>
        `${base} + ${stack.map((plugin) => plugin.name).join(' + ')} (${listOperations(composed).length} operations)`,
    )
    .join(', ')}.`,
);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

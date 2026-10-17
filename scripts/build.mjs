// Offline build: bundles spec/ fragments into the official openapi.json/.yaml, socket/ fragments
// into the official asyncapi.json/.yaml and profile fragments into profiles/<name>.json, then
// proves every profile composes with both contracts and every plugin with its base profile.
// Needs no .sources.
//
//   node scripts/build.mjs           write outputs
//   node scripts/build.mjs --check   fail when any output is stale (no writes)
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  assembleProfile,
  composePlugin,
  composePlugins,
  composeProfile,
  composeSocketProfile,
  listOperations,
} from '../lib/contracts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => compare(a, b)));

const spec = await readJson('spec/base.json');
for (const name of (await readdir(resolve(root, 'spec'))).sort(compare)) {
  if (name === 'base.json' || !name.endsWith('.json')) continue;
  const fragment = await readJson(`spec/${name}`);
  for (const key of Object.keys(fragment))
    if (!['paths', 'components'].includes(key))
      throw new Error(`spec/${name}: unexpected top-level key ${key}`);
  for (const [path, item] of Object.entries(fragment.paths ?? {})) {
    const target = (spec.paths[path] ??= {});
    for (const [method, operation] of Object.entries(item)) {
      if (target[method]) throw new Error(`Duplicate operation ${method} ${path} in ${name}`);
      target[method] = operation;
    }
  }
  for (const [category, entries] of Object.entries(fragment.components ?? {})) {
    const target = (spec.components[category] ??= {});
    for (const [key, value] of Object.entries(entries)) {
      if (Object.hasOwn(target, key))
        throw new Error(`Duplicate component ${category}/${key} in ${name}`);
      target[key] = value;
    }
  }
}

// Official web client transport conventions (Auth interceptor): signed-in requests also send the
// token as X-Username, and an X-Token response header replaces the stored token. Authenticated
// responses also report the per-endpoint request limit (node-screeps-api rate limit tracker).
const tags = new Set();
const operations = listOperations(spec);
for (const { path, operation } of operations) {
  for (const tag of operation.tags ?? []) tags.add(tag);
  const tokenAuthenticated = operation.security?.some((requirement) =>
    Object.hasOwn(requirement, 'Token'),
  );
  if (!tokenAuthenticated || !path.startsWith('/api/')) continue;
  operation.parameters ??= [];
  if (
    !operation.parameters.some(
      (parameter) =>
        parameter.$ref === '#/components/parameters/LegacyUsername' ||
        parameter.name === 'X-Username',
    )
  )
    operation.parameters.push({ $ref: '#/components/parameters/LegacyUsername' });
  const success = operation.responses?.['200'];
  if (success && !success.$ref) {
    success.headers ??= {};
    success.headers['X-Token'] ??= {
      description:
        'Rotated session token when issued by the server; store it for subsequent authenticated requests.',
      schema: { type: 'string' },
    };
    for (const name of ['Limit', 'Remaining', 'Reset'])
      success.headers[`X-RateLimit-${name}`] ??= {
        $ref: `#/components/headers/RateLimit${name}`,
      };
  }
}
spec.tags = [...tags].sort(compare).map((name) => ({
  name,
  description: `${name} operations of the official Screeps World HTTP API.`,
}));
spec.paths = sortKeys(spec.paths);
for (const [name, entries] of Object.entries(spec.components))
  spec.components[name] = sortKeys(entries);

// Socket contract: socket/base.json + fragments of messages, schemas and operations. Every
// message is offered on the single connection channel; operations reference channel messages.
const socket = await readJson('socket/base.json');
const [channelName, ...otherChannels] = Object.keys(socket.channels);
if (!channelName || otherChannels.length)
  throw new Error('socket/base.json must declare exactly one channel');
for (const name of (await readdir(resolve(root, 'socket'))).sort(compare)) {
  if (name === 'base.json' || !name.endsWith('.json')) continue;
  const fragment = await readJson(`socket/${name}`);
  for (const key of Object.keys(fragment))
    if (!['messages', 'schemas', 'operations'].includes(key))
      throw new Error(`socket/${name}: unexpected top-level key ${key}`);
  for (const [target, entries] of [
    [socket.components.messages, fragment.messages],
    [socket.components.schemas, fragment.schemas],
    [socket.operations, fragment.operations],
  ]) {
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (Object.hasOwn(target, key)) throw new Error(`Duplicate socket entry ${key} in ${name}`);
      target[key] = value;
    }
  }
}
socket.channels[channelName].messages = Object.fromEntries(
  Object.keys(socket.components.messages)
    .sort(compare)
    .map((name) => [name, { $ref: `#/components/messages/${name}` }]),
);
socket.operations = sortKeys(socket.operations);
socket.components.messages = sortKeys(socket.components.messages);
socket.components.schemas = sortKeys(socket.components.schemas);

const outputs = {
  'openapi.json': JSON.stringify(spec, null, 2) + '\n',
  'openapi.yaml': stringify(spec, { lineWidth: 100, aliasDuplicateObjects: false }),
  'asyncapi.json': JSON.stringify(socket, null, 2) + '\n',
  'asyncapi.yaml': stringify(socket, { lineWidth: 100, aliasDuplicateObjects: false }),
};

// Profiles: profiles/<name>/index.json + per-domain fragments -> profiles/<name>.json.
const profileSummaries = [];
const composedProfiles = {};
for (const entry of (await readdir(resolve(root, 'profiles'), { withFileTypes: true })).sort(
  (a, b) => compare(a.name, b.name),
)) {
  if (!entry.isDirectory()) continue;
  const directory = `profiles/${entry.name}`;
  const index = await readJson(`${directory}/index.json`);
  if (index.name !== entry.name)
    throw new Error(`${directory}/index.json name must be ${entry.name}`);
  const fragments = [];
  for (const name of (await readdir(resolve(root, directory))).sort(compare)) {
    if (name === 'index.json' || !name.endsWith('.json')) continue;
    fragments.push([`${directory}/${name}`, await readJson(`${directory}/${name}`)]);
  }
  const profile = assembleProfile(index, fragments);
  // Throws with every partition/override problem; extensions are server-owned and empty here.
  const composed = composeProfile(spec, profile);
  const composedSocket = composeSocketProfile(socket, profile);
  composedProfiles[entry.name] = composed;
  outputs[`${directory}.json`] = JSON.stringify(profile, null, 2) + '\n';
  profileSummaries.push(
    `${entry.name}: ${profile.required.length} required, ${Object.keys(profile.excluded).length} excluded, ${Object.keys(profile.additions).length} additions -> ${listOperations(composed).length} operations, ${Object.keys(composedSocket.components.messages).length} socket messages`,
  );
}

// Plugins: plugins/<name>.json are published as written; each must compose on its base profile,
// and all plugins of one base must compose together in file order.
const sources = await readJson('sources.json');
const pluginSummaries = [];
const stacks = {};
for (const name of (await readdir(resolve(root, 'plugins'))).sort(compare)) {
  if (!name.endsWith('.json')) continue;
  const plugin = await readJson(`plugins/${name}`);
  if (`${plugin.name}.json` !== name)
    throw new Error(`plugins/${name} must be named after its plugin (${plugin.name}.json)`);
  if (!sources[plugin.source])
    throw new Error(`plugins/${name}: source ${plugin.source} is not pinned in sources.json`);
  const base = composedProfiles[plugin.base];
  if (!base) throw new Error(`plugins/${name}: base profile ${plugin.base} does not exist`);
  composePlugin(spec, base, plugin);
  (stacks[plugin.base] ??= []).push(plugin);
  pluginSummaries.push(
    `${plugin.name} on ${plugin.base}: ${Object.keys(plugin.provides ?? {}).length} provided, ${Object.keys(plugin.adaptations ?? {}).length} adapted, ${Object.keys(plugin.additions ?? {}).length} additions`,
  );
}
for (const [base, stack] of Object.entries(stacks)) {
  const composed = composePlugins(spec, composedProfiles[base], stack);
  pluginSummaries.push(
    `${base} + ${stack.map((plugin) => plugin.name).join(' + ')} -> ${listOperations(composed).length} operations`,
  );
}

const stale = [];
for (const [name, content] of Object.entries(outputs)) {
  if (check) {
    let current;
    try {
      current = await readFile(resolve(root, name), 'utf8');
    } catch {
      current = undefined;
    }
    if (current !== content) stale.push(name);
  } else {
    await writeFile(resolve(root, name), content);
  }
}
if (stale.length) throw new Error(`Stale build outputs: ${stale.join(', ')}; run npm run build`);
console.log(
  `${check ? 'Verified' : 'Built'} official contract (${Object.keys(spec.paths).length} paths, ${operations.length} operations), socket contract (${Object.keys(socket.components.messages).length} messages, ${Object.keys(socket.operations).length} operations), profiles (${profileSummaries.join('; ')}) and plugins (${pluginSummaries.join('; ')}).`,
);

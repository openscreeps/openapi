// Offline build: bundles spec/ fragments into the official openapi.json/.yaml and profile
// fragments into profiles/<name>.json, then proves every profile composes. Needs no .sources.
//
//   node scripts/build.mjs           write outputs
//   node scripts/build.mjs --check   fail when any output is stale (no writes)
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { assembleProfile, composeProfile, listOperations } from '../lib/contracts.mjs';

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
// token as X-Username, and an X-Token response header replaces the stored token.
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
  }
}
spec.tags = [...tags].sort(compare).map((name) => ({
  name,
  description: `${name} operations of the official Screeps World HTTP API.`,
}));
spec.paths = sortKeys(spec.paths);
for (const [name, entries] of Object.entries(spec.components))
  spec.components[name] = sortKeys(entries);

const outputs = {
  'openapi.json': JSON.stringify(spec, null, 2) + '\n',
  'openapi.yaml': stringify(spec, { lineWidth: 100, aliasDuplicateObjects: false }),
};

// Profiles: profiles/<name>/index.json + per-domain fragments -> profiles/<name>.json.
const profileSummaries = [];
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
  outputs[`${directory}.json`] = JSON.stringify(profile, null, 2) + '\n';
  profileSummaries.push(
    `${entry.name}: ${profile.required.length} required, ${Object.keys(profile.excluded).length} excluded, ${Object.keys(profile.additions).length} additions -> ${listOperations(composed).length} operations`,
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
  `${check ? 'Verified' : 'Built'} official contract (${Object.keys(spec.paths).length} paths, ${operations.length} operations) and profiles (${profileSummaries.join('; ')}).`,
);

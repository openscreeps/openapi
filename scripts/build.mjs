import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stringify } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = JSON.parse(await readFile(resolve(root, 'spec/base.json'), 'utf8'));
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
for (const name of (await readdir(resolve(root, 'spec'))).sort()) {
  if (name === 'base.json' || !name.endsWith('.json')) continue;
  const fragment = JSON.parse(await readFile(resolve(root, 'spec', name), 'utf8'));
  for (const [path, item] of Object.entries(fragment.paths)) {
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
const tags = new Set();
let operations = 0;
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    operations++;
    for (const tag of operation.tags) tags.add(tag);
    // These are transport guarantees, not speculative fields copied into domain schemas.
    if (
      operation['x-availability']?.openscreeps === 'supported' &&
      (path.startsWith('/api/') || path === '/room-history')
    ) {
      operation.parameters ??= [];
      if (
        !operation.parameters.some(
          (parameter) =>
            parameter.$ref === '#/components/parameters/ServerPassword' ||
            parameter.name === 'X-Server-Password',
        )
      ) {
        operation.parameters.push({ $ref: '#/components/parameters/ServerPassword' });
      }
    }
    const playerAuthenticated = operation.security?.some((requirement) =>
      Object.hasOwn(requirement, 'Token'),
    );
    if (playerAuthenticated && path.startsWith('/api/')) {
      operation.parameters ??= [];
      if (
        !operation.parameters.some(
          (parameter) =>
            parameter.$ref === '#/components/parameters/LegacyUsername' ||
            parameter.name === 'X-Username',
        )
      ) {
        operation.parameters.push({ $ref: '#/components/parameters/LegacyUsername' });
      }
      const success = operation.responses['200'];
      if (success && !success.$ref) {
        success.headers ??= {};
        success.headers['X-Token'] ??= {
          description:
            'Refreshed session token when issued by the server. Retain it for subsequent authenticated requests.',
          schema: { type: 'string' },
        };
      }
    }
  }
}
spec.tags = [...tags].sort().map((name) => ({
  name,
  description: `${name} HTTP operations; availability and server-specific differences are documented per operation.`,
}));
spec.paths = Object.fromEntries(Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b)));
for (const [name, entries] of Object.entries(spec.components)) {
  spec.components[name] = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
}
const outputs = {
  'openapi.json': JSON.stringify(spec, null, 2) + '\n',
  'openapi.yaml': stringify(spec, { lineWidth: 100, aliasDuplicateObjects: false }),
};
for (const [name, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if ((await readFile(resolve(root, name), 'utf8')) !== content)
      throw new Error(`${name} is stale; run npm run build`);
  } else {
    await writeFile(resolve(root, name), content);
  }
}
console.log(
  `${process.argv.includes('--check') ? 'Verified' : 'Built'} JSON/YAML bundles: ${Object.keys(spec.paths).length} paths, ${operations} operations.`,
);

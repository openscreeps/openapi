import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const spec = JSON.parse(
  await readFile(process.env.SCREEPS_SPEC ?? new URL('../openapi.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const name of ['binary', 'byte', 'int32', 'int64', 'float', 'double', 'password'])
  ajv.addFormat(name, true);
function dereference(value) {
  while (value?.$ref)
    value = value.$ref
      .slice(2)
      .split('/')
      .reduce((node, key) => node[key], spec);
  return value;
}
export function validateResponse(path, method, status, data) {
  const operation = spec.paths[path]?.[method];
  if (!operation) throw new Error(`Missing contract: ${method} ${path}`);
  const response = dereference(operation.responses[String(status)] ?? operation.responses.default);
  const schema = response?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`No JSON contract for ${method} ${path} HTTP ${status}`);
  const validate = ajv.compile({ components: spec.components, ...schema });
  if (!validate(data)) {
    // Do not log response data: authenticated replies can contain private Memory or tokens.
    throw new Error(
      `${method} ${path} HTTP ${status}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
    );
  }
}
export async function smoke({
  base,
  target,
  token,
  room = 'W1N1',
  shard = 'shard3',
  serverPassword,
}) {
  let count = 0;
  const failures = [];
  async function get(path, query = {}, authenticated = true) {
    const operation = spec.paths[path]?.get;
    if (!operation) throw new Error(`Smoke requires a documented operation: GET ${path}`);
    if (operation['x-availability']?.[target] === 'unsupported') return undefined;
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(name, value);
    const headers = {};
    if (authenticated && token) {
      headers['X-Token'] = token;
      headers['X-Username'] = token;
    }
    if (serverPassword) headers['X-Server-Password'] = serverPassword;
    const response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    token = response.headers.get('X-Token') ?? token;
    try {
      validateResponse(path, 'get', response.status, data);
      if (!response.ok || data.error)
        throw new Error(
          `Read-only smoke call failed: ${path} HTTP ${response.status} (body withheld)`,
        );
      count++;
      console.log(`PASS ${target} GET ${path} HTTP ${response.status}`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${target} GET ${path} HTTP ${response.status}`);
    }
    return data;
  }
  const routed = target === 'screeps-com' ? { shard } : {};
  await get('/api/version');
  if (target === 'openscreeps') await get('/health');
  if (target === 'screeps-com') await get('/api/game/shards/info');
  await get('/api/game/room-status', { ...routed, room });
  await get('/api/game/room-terrain', { ...routed, room, encoded: '1' });
  await get('/api/game/room-terrain', { ...routed, room });
  await get('/api/game/room-decorations', { ...routed, room });
  await get('/api/xsolla/active-promotion');
  if (token) {
    const me = await get('/api/auth/me');
    await get('/api/user/branches');
    await get('/api/user/world-status', routed);
    await get('/api/user/world-start-room', routed);
    await get('/api/user/rooms', { id: me?._id });
    await get('/api/game/room-objects', { ...routed, room });
    await get('/api/user/memory', routed);
  }
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} HTTP contract smoke failures`);
  console.log(
    `Validated ${count} real read-only ${target} HTTP responses. No response bodies or credentials recorded.`,
  );
  return count;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.env.SCREEPS_TARGET ?? 'screeps-com';
  if (!['screeps-com', 'openscreeps'].includes(target))
    throw new Error('SCREEPS_TARGET must be screeps-com or openscreeps');
  if (target === 'openscreeps' && !process.env.SCREEPS_SPEC)
    throw new Error(
      'SCREEPS_SPEC must point to the server-generated OpenAPI document for OpenScreeps',
    );
  await smoke({
    base:
      process.env.SCREEPS_API_URL ??
      (target === 'screeps-com' ? 'https://screeps.com' : 'http://127.0.0.1:21025'),
    target,
    token: process.env.SCREEPS_TOKEN,
    room: process.env.SCREEPS_ROOM,
    shard: process.env.SCREEPS_SHARD,
    serverPassword: process.env.SCREEPS_SERVER_PASSWORD,
  });
}

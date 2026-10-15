import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const parsed: unknown = JSON.parse(
  await readFile(process.env.SCREEPS_SPEC ?? new URL('../openapi.json', import.meta.url), 'utf8'),
);
const document = object(parsed);
assert.ok(document, 'OpenAPI document must be an object');
const spec = document;

export interface SmokeOptions {
  base: string | URL;
  target: 'screeps-com' | 'openscreeps';
  token?: string | undefined;
  room?: string | undefined;
  shard?: string | undefined;
  serverPassword?: string | undefined;
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
for (const name of ['binary', 'byte', 'int32', 'int64', 'float', 'double', 'password'])
  ajv.addFormat(name, true);
function dereference(value: unknown): Record<string, unknown> | undefined {
  let current = object(value);
  while (typeof current?.$ref === 'string') {
    let resolved: unknown = spec;
    for (const key of current.$ref.slice(2).split('/')) resolved = object(resolved)?.[key];
    current = object(resolved);
  }
  return current;
}
export function validateResponse(
  path: string,
  method: string,
  status: number,
  data: unknown,
): void {
  const operation = object(object(object(spec.paths)?.[path])?.[method]);
  if (!operation) throw new Error(`Missing contract: ${method} ${path}`);
  const responses = object(operation.responses);
  const response = dereference(responses?.[String(status)] ?? responses?.default);
  const schema = object(object(response?.content)?.['application/json'])?.schema;
  if (!schema) throw new Error(`No JSON contract for ${method} ${path} HTTP ${status}`);
  const validate = ajv.compile<unknown>({ components: spec.components, ...object(schema) });
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
}: SmokeOptions): Promise<number> {
  let count = 0;
  const failures: unknown[] = [];
  async function get(
    path: string,
    query: Record<string, unknown> = {},
    authenticated = true,
  ): Promise<unknown> {
    const operation = object(object(object(spec.paths)?.[path])?.get);
    if (!operation) throw new Error(`Smoke requires a documented operation: GET ${path}`);
    if (object(operation['x-availability'])?.[target] === 'unsupported') return undefined;
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = {};
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
    const data: unknown = await response.json();
    token = response.headers.get('X-Token') ?? token;
    try {
      validateResponse(path, 'get', response.status, data);
      if (!response.ok || object(data)?.error)
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
    await get('/api/user/rooms', { id: object(me)?._id });
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
  if (target !== 'screeps-com' && target !== 'openscreeps')
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

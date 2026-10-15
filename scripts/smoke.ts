import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { unzipSync } from 'node:zlib';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { composeSocketProfile, type JsonObject } from '../lib/contracts.mjs';

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

type Validator = ((data: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};
/** Schema path and message of each validation error; never the validated values. */
function errorText(validate: Validator): string {
  return (validate.errors ?? [])
    .map(
      (error) =>
        `${error.instancePath.replace(/\/[0-9a-f]{24}(?=\/|$)/g, '/<id>')} ${error.message ?? ''}`,
    )
    .join('; ');
}

/**
 * Checks complete room objects against a room object union (`GameRoomObject` or `RoomObject`):
 * each must match the union and the variant its `type` maps to, so a described type never passes
 * only as the fallback for unknown types. Counts objects per type; failures name the type and
 * schema path only.
 */
export function checkRoomObjects(
  objects: unknown,
  schemas: Record<string, unknown>,
  union: string,
  compile: (name: string) => Validator,
  counts: Map<string, number>,
  failures: string[],
): void {
  const mapping = object(object(object(schemas[union])?.discriminator)?.mapping) ?? {};
  const list = Array.isArray(objects) ? objects : Object.values(object(objects) ?? {});
  for (const item of list) {
    const type = object(item)?.type;
    const kind = typeof type === 'string' ? type : '<no type>';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const reference = typeof type === 'string' ? mapping[type] : undefined;
    const variant =
      typeof reference === 'string'
        ? reference.slice(reference.lastIndexOf('/') + 1)
        : `${union}Other`;
    for (const name of [union, schemas[variant] ? variant : union]) {
      const validate = compile(name);
      if (!validate(item)) failures.push(`${kind} object fails ${name}: ${errorText(validate)}`);
    }
  }
}

/** Checks every line of a room or map visual string against its item union; counts per kind. */
export function checkVisualLines(
  text: unknown,
  validate: Validator,
  counts: Map<string, number>,
  failures: string[],
): void {
  if (typeof text !== 'string') return;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let item: unknown;
    try {
      item = JSON.parse(line);
    } catch {
      failures.push('visual line is not JSON');
      continue;
    }
    const kind = String(object(item)?.t);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (!validate(item)) failures.push(`visual item ${kind}: ${errorText(validate)}`);
  }
}

const compiled = new Map<string, Validator>();
function compileComponent(name: string): Validator {
  let validate = compiled.get(name);
  if (!validate) {
    validate = ajv.compile<unknown>({
      components: spec.components,
      $ref: `#/components/schemas/${name}`,
    }) as Validator;
    compiled.set(name, validate);
  }
  return validate;
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
  await get('/api/game/time', routed);
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
    const roomObjects = await get('/api/game/room-objects', { ...routed, room });
    const counts = new Map<string, number>();
    const objectFailures: string[] = [];
    checkRoomObjects(
      object(roomObjects)?.objects,
      object(object(spec.components)?.schemas) ?? {},
      'GameRoomObject',
      compileComponent,
      counts,
      objectFailures,
    );
    for (const failure of objectFailures) failures.push(new Error(failure));
    console.log(
      `${objectFailures.length ? 'FAIL' : 'PASS'} ${target} room objects by type: ${[...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, total]) => `${type} x${total}`)
        .join(', ')}`,
    );
    await get('/api/user/memory', routed);
  }
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} HTTP contract smoke failures`);
  console.log(
    `Validated ${count} real read-only ${target} HTTP responses. No response bodies or credentials recorded.`,
  );
  return count;
}

const socketContract = object(
  JSON.parse(await readFile(new URL('../asyncapi.json', import.meta.url), 'utf8')),
);
assert.ok(socketContract, 'AsyncAPI document must be an object');
const standaloneProfile = object(
  JSON.parse(await readFile(new URL('../profiles/standalone.json', import.meta.url), 'utf8')),
);
assert.ok(standaloneProfile, 'Standalone profile must be an object');

/**
 * Read-only socket smoke: every frame must match a message of the target's socket contract.
 * Signed in, it subscribes to one room, its map view, map visuals and passive account channels
 * and waits for room, map and visual events. Complete room objects of first room events and
 * visual items are checked against their unions. Only message names, object types and visual
 * kinds are printed.
 */
export async function socketSmoke({
  base,
  target,
  token,
  room = 'W1N1',
  shard = 'shard3',
  timeout = 20000,
  observe = 8000,
}: SmokeOptions & { timeout?: number; observe?: number }): Promise<number> {
  const document: JsonObject =
    target === 'screeps-com'
      ? (socketContract as JsonObject)
      : composeSocketProfile(socketContract as JsonObject, standaloneProfile as JsonObject);
  const components = object(document.components) ?? {};
  const messages = object(components.messages) ?? {};
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({
    $id: 'urn:screeps:socket-smoke',
    components: { schemas: components.schemas ?? {} },
    payloads: Object.fromEntries(
      Object.entries(messages).map(([name, message]) => [name, object(message)?.payload]),
    ),
  });
  const validators = Object.keys(messages).map((name) => {
    const validate = ajv.getSchema(`urn:screeps:socket-smoke#/payloads/${name}`);
    assert.ok(validate, `Socket payload ${name} must compile`);
    return [name, validate] as const;
  });
  const schemas = object(components.schemas) ?? {};
  const compileSocket = (name: string): Validator => {
    const validate = ajv.getSchema(`urn:screeps:socket-smoke#/components/schemas/${name}`);
    assert.ok(validate, `Socket schema ${name} must compile`);
    return validate as Validator;
  };
  const objectCounts = new Map<string, number>();
  const visualCounts = new Map<string, number>();

  let userId: string | undefined;
  if (token) {
    const response = await fetch(new URL('/api/auth/me', base), {
      headers: { 'X-Token': token, 'X-Username': token },
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    const id = object(await response.json())?._id;
    assert.ok(typeof id === 'string', 'GET /api/auth/me must identify the token user');
    userId = id;
  }
  const sharded = target === 'screeps-com' ? `${shard}/` : '';
  const required = new Set<string>();
  const subscriptions = ['server-message'];
  if (userId) {
    required.add(`room:${sharded}${room}`);
    required.add(`roomMap2:${sharded}${room}`);
    required.add(`mapVisual:${userId}${target === 'screeps-com' ? `/${shard}` : ''}`);
    subscriptions.push(
      ...required,
      `user:${userId}/cpu`,
      `user:${userId}/console`,
      `user:${userId}/resources`,
      `user:${userId}/memory/${sharded}__smoke_probe__`,
    );
  }
  const greeting = ['time', 'protocol', 'package'].filter((name) => name in messages);
  const seen = new Map<string, number>();
  const failures: string[] = [];
  const url = new URL('socket/websocket', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => socket.close(), timeout);
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Socket connection to ${url.host} failed`));
    };
    socket.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onopen = () => {
      socket.send('gzip on');
      if (token) socket.send(`auth ${token}`);
      else for (const channel of subscriptions) socket.send(`subscribe ${channel}`);
    };
    socket.onmessage = (event: MessageEvent) => {
      let text = String(event.data);
      if (text.startsWith('gz:')) {
        const frame = text;
        if (validators.find(([, validate]) => validate(frame))?.[0] !== 'compressedFrame')
          failures.push('malformed gz: frame');
        seen.set('compressedFrame', (seen.get('compressedFrame') ?? 0) + 1);
        text = unzipSync(Buffer.from(text.slice(3), 'base64')).toString('utf8');
      }
      const payload: unknown = text.startsWith('[') ? JSON.parse(text) : text;
      const name = validators.find(([, validate]) => validate(payload))?.[0];
      const channel = Array.isArray(payload) && typeof payload[0] === 'string' ? payload[0] : '';
      if (!name) {
        // Never log data: name only the frame kind, with the user id redacted.
        const kind = channel
          ? `event ${userId ? channel.replaceAll(userId, '<user>') : channel}`
          : `line ${text.split(' ', 1)[0] ?? ''}`;
        failures.push(`frame matches no ${target} socket message: ${kind}`);
        return;
      }
      seen.set(name, (seen.get(name) ?? 0) + 1);
      const data = Array.isArray(payload) ? payload[1] : undefined;
      // The first room event holds every object complete; later events hold patches.
      if (name === 'roomEvent' && object(data)?.gameTime === undefined)
        checkRoomObjects(
          object(data)?.objects,
          schemas,
          'RoomObject',
          compileSocket,
          objectCounts,
          failures,
        );
      if (name === 'roomEvent')
        checkVisualLines(
          object(data)?.visual,
          compileSocket('RoomVisualItem'),
          visualCounts,
          failures,
        );
      if (name === 'mapVisualEvent')
        checkVisualLines(data, compileSocket('MapVisualItem'), visualCounts, failures);
      if (name === 'authOk') for (const item of subscriptions) socket.send(`subscribe ${item}`);
      if (name === 'authFailed') failures.push('auth failed');
      required.delete(channel.replace(/^err@/, ''));
      // Keep listening for `observe` ms so passive channels (cpu, console, resources, memory,
      // room limit errors) are validated too.
      if (
        Date.now() - started >= observe &&
        greeting.every((item) => seen.has(item)) &&
        (!token || seen.has('authOk') || seen.has('authFailed')) &&
        required.size === 0
      )
        socket.close();
    };
  });
  for (const name of greeting) if (!seen.has(name)) failures.push(`no ${name} greeting`);
  if (token && !seen.has('authOk')) failures.push('no auth ok reply');
  for (const channel of required)
    failures.push(`no event for ${userId ? channel.replaceAll(userId, '<user>') : channel}`);
  for (const [name, total] of [...seen].sort(([a], [b]) => a.localeCompare(b)))
    console.log(`PASS ${target} socket ${name} x${total}`);
  if (objectCounts.size)
    console.log(
      `PASS ${target} socket first-event room objects by type: ${[...objectCounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, total]) => `${type} x${total}`)
        .join(', ')}`,
    );
  if (visualCounts.size)
    console.log(
      `PASS ${target} socket visual items by kind: ${[...visualCounts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, total]) => `${kind} x${total}`)
        .join(', ')}`,
    );
  if (failures.length)
    throw new Error(`Socket contract smoke failures:\n- ${failures.join('\n- ')}`);
  const total = [...seen.values()].reduce((sum, value) => sum + value, 0);
  console.log(
    `Validated ${total} real ${target} socket frames (${seen.size} message kinds). No payloads or credentials recorded.`,
  );
  return total;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.env.SCREEPS_TARGET ?? 'screeps-com';
  if (target !== 'screeps-com' && target !== 'openscreeps')
    throw new Error('SCREEPS_TARGET must be screeps-com or openscreeps');
  if (target === 'openscreeps' && !process.env.SCREEPS_SPEC)
    throw new Error(
      'SCREEPS_SPEC must point to the server-generated OpenAPI document for OpenScreeps',
    );
  const options = {
    base:
      process.env.SCREEPS_API_URL ??
      (target === 'screeps-com' ? 'https://screeps.com' : 'http://127.0.0.1:21025'),
    target,
    token: process.env.SCREEPS_TOKEN,
    room: process.env.SCREEPS_ROOM,
    shard: process.env.SCREEPS_SHARD,
    serverPassword: process.env.SCREEPS_SERVER_PASSWORD,
  } as const;
  await smoke(options);
  await socketSmoke(options);
}

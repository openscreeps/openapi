import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import { composeSocketProfile, type JsonObject } from '../lib/contracts.mjs';

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;

function record(value: unknown): JsonObject {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as JsonObject;
}
const official = record(
  JSON.parse(await readFile(new URL('../asyncapi.json', import.meta.url), 'utf8')),
);
const standalone = record(
  JSON.parse(await readFile(new URL('../profiles/standalone.json', import.meta.url), 'utf8')),
);

/** Validates a wire payload against the payload schema of the named message. */
function payloads(document: JsonObject): (name: string, payload: unknown) => boolean {
  const components = record(document.components);
  const messages = record(components.messages);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({
    $id: 'urn:screeps:socket-test',
    components: { schemas: components.schemas },
    payloads: Object.fromEntries(
      Object.entries(messages).map(([name, message]) => [name, record(message).payload]),
    ),
  });
  return (name, payload) => {
    const validate = ajv.getSchema(`urn:screeps:socket-test#/payloads/${name}`);
    assert.ok(validate, `missing payload ${name}`);
    return validate(payload) as boolean;
  };
}

const compose = (socket: JsonObject) => composeSocketProfile(official, { name: 'test', socket });

test('official channels are shard-qualified and standalone channels are not', () => {
  const screeps = payloads(official);
  const single = payloads(composeSocketProfile(official, standalone));
  const cases = [
    ['roomEvent', ['room:shard3/W1N1', { objects: {} }], ['room:W1N1', { objects: {} }]],
    ['roomErrorEvent', ['err@room:shard3/W1N1', 'x'], ['err@room:W1N1', 'x']],
    ['roomMapEvent', ['roomMap2:shard3/W1N1', {}], ['roomMap2:W1N1', {}]],
    ['mapVisualEvent', ['mapVisual:u1/shard3', null], ['mapVisual:u1', null]],
  ] as const;
  for (const [name, sharded, shardless] of cases) {
    assert.equal(screeps(name, sharded), true, `${name}: screeps.com form`);
    assert.equal(screeps(name, shardless), false, `${name}: screeps.com rejects shardless`);
    assert.equal(single(name, shardless), true, `${name}: standalone form`);
    assert.equal(single(name, sharded), false, `${name}: standalone rejects shards`);
  }
  assert.equal(screeps('userMemoryEvent', ['user:u1/memory/a.b', '1']), false);
  assert.equal(single('userMemoryEvent', ['user:u1/memory/a.b', '1']), true);
  assert.equal(
    screeps('userConsoleEvent', ['user:u1/console', { messages: { log: [], results: [] } }]),
    false,
  );
  assert.equal(
    single('userConsoleEvent', ['user:u1/console', { messages: { log: [], results: [] } }]),
    true,
  );
});

/** Validates a value against the named component schema. */
function schemas(document: JsonObject): (name: string, value: unknown) => boolean {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'urn:screeps:socket-schemas', components: record(document.components) });
  return (name, value) => {
    const validate = ajv.getSchema(`urn:screeps:socket-schemas#/components/schemas/${name}`);
    assert.ok(validate, `missing schema ${name}`);
    return validate(value) as boolean;
  };
}

const creep = {
  _id: 'c',
  type: 'creep',
  room: 'W1N1',
  x: 1,
  y: 1,
  user: 'u1',
  name: 'harvester1',
  body: [{ type: 'tough', hits: 100, boost: 'XGHO2' }],
  hits: 100,
  hitsMax: 100,
  fatigue: 0,
  store: { energy: 0 },
  effects: { 0: { effect: 13, power: 13, level: 1, endTime: 10 } },
};

test('room diffs carry complete objects, index-keyed partial patches and null markers', () => {
  const composed = composeSocketProfile(official, standalone);
  assert.ok(record(record(composed.components).schemas).RoomObject, 'standalone keeps RoomObject');
  const patch = {
    body: { 0: { hits: 40, boost: null } },
    effects: { 0: { endTime: 11 } },
    store: { H: null, energy: 20 },
    reservation: { endTime: 6 },
    sign: null,
  };
  for (const [label, valid, room, schema] of [
    ['screeps.com', payloads(official), 'room:shard3/W1N1', schemas(official)],
    ['standalone', payloads(composed), 'room:W1N1', schemas(composed)],
  ] as const) {
    const event = (objects: JsonObject) => valid('roomEvent', [room, { objects }]);
    assert.equal(schema('RoomObject', creep), true, `${label}: complete creep`);
    assert.equal(event({ c: creep, d: null }), true, `${label}: complete object and removal`);
    assert.equal(event({ c: patch }), true, `${label}: partial patch`);
    assert.equal(schema('RoomObject', patch), false, `${label}: a patch is not a complete object`);
    assert.equal(event({ c: { hits: '40' } }), false, `${label}: patch values stay typed`);
    assert.equal(event({ c: { body: { 0: { hits: '40' } } } }), false, `${label}: nested`);
    assert.equal(event({ c: { effects: 'none' } }), false, `${label}: effects collection`);
  }
});

test('socket room objects mirror the HTTP union, including unknown types and dropped piles', () => {
  const valid = schemas(official);
  assert.equal(valid('RoomObjectCreep', creep), true);
  assert.equal(valid('RoomObject', { ...creep, type: 'spawn' }), false, 'discriminated by type');
  const other = { _id: 'o', type: 'scoreContainer', room: 'W1N1', x: 4, y: 4, store: {} };
  assert.equal(valid('RoomObject', other), true, 'unknown types fall back to RoomObjectOther');
  const pile = { _id: 'd', type: 'energy', room: 'W1N1', x: 2, y: 2, resourceType: 'O', O: 7 };
  assert.equal(valid('RoomObject', pile), true);
  assert.equal(valid('RoomObject', { ...pile, O: 7.5 }), false, 'amounts are integers');
});

test('visual strings are newline-terminated JSON lines of typed visual items', () => {
  const valid = schemas(official);
  const lines = (text: string) =>
    text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  const messages = record(record(official.components).messages);
  const mapExample = (record(messages.mapVisualEvent).examples as JsonObject[]).find(
    (example) => example.name === 'items',
  );
  const mapText = (mapExample?.payload as [string, string])[1];
  assert.ok(mapText.endsWith('\n'), 'every item is newline-terminated');
  assert.deepEqual(
    lines(mapText).map((item) => record(item).t),
    ['c', 'l', 'r', 'p', 't'],
  );
  for (const item of lines(mapText)) assert.equal(valid('MapVisualItem', item), true);
  const roomEvent = record(record(record(official.components).schemas).RoomEvent);
  const roomText = String(record((roomEvent.examples as JsonObject[])[1]).visual);
  for (const item of lines(roomText)) assert.equal(valid('RoomVisualItem', item), true);
  const roomText2 = { t: 't', text: 'x', x: 1, y: 2, s: { font: '0.7 serif', align: 'left' } };
  assert.equal(valid('RoomVisualItem', roomText2), true, 'font may be a CSS shorthand');
  assert.equal(valid('RoomVisualItem', { t: 't', text: 'x', x: 1, y: 2, s: { font: 0.5 } }), true);
  assert.equal(valid('RoomVisualItem', { t: 'c', x: 1, y: 1 }), true, 'room styles are optional');
  assert.equal(valid('RoomVisualItem', { t: 'l', x1: 1, y1: 1, x2: 2 }), false, 'needs y2');
  assert.equal(valid('RoomVisualItem', { t: 'p', points: [[1, 2, 3]] }), false, 'points are pairs');
  assert.equal(valid('RoomVisualItem', { t: 'x', x: 1, y: 1 }), false, 'unknown kind');
  assert.equal(
    valid('MapVisualItem', { t: 'c', x: 1, y: 1, s: {} }),
    false,
    'map items name rooms',
  );
  assert.equal(valid('MapVisualItem', { t: 'c', x: 1, y: 1, n: 'W1N1' }), false, 'map style set');
  assert.equal(
    valid('MapVisualItem', { t: 'p', points: [{ x: 1, y: 1, n: 'W1N1' }, [2, 2]], s: {} }),
    false,
    'map polygon points are positions',
  );
});

test('excluded messages leave components, channel and operations; emptied operations go', () => {
  const composed = compose({
    excluded: { serverDown: 'not sent', cannotSubscribe: 'not sent', package: 'not sent' },
  });
  const messages = record(record(composed.components).messages);
  const channel = record(record(record(composed.channels).socket).messages);
  const operations = record(composed.operations);
  for (const name of ['serverDown', 'cannotSubscribe', 'package']) {
    assert.equal(messages[name], undefined, `${name} component`);
    assert.equal(channel[name], undefined, `${name} channel entry`);
  }
  assert.equal(operations.sendServerStatus, undefined, 'operation without messages is removed');
  assert.deepEqual(record(operations.sendGreeting).messages, [
    { $ref: '#/channels/socket/messages/time' },
    { $ref: '#/channels/socket/messages/protocol' },
  ]);
  assert.deepEqual(record(record(operations.receiveAuth).reply).messages, [
    { $ref: '#/channels/socket/messages/authOk' },
    { $ref: '#/channels/socket/messages/authFailed' },
  ]);
  assert.equal(record(messages.time)['x-observations'], undefined, 'official observations dropped');
  assert.deepEqual(record(messages.time)['x-profile'], { status: 'required' });
});

test('socket differences must be justified and target official messages', () => {
  const failures: Array<[JsonObject, RegExp]> = [
    [
      { overrides: { messages: { time: { summary: 'changed summary' } } } },
      /without an adaptation reason/,
    ],
    [{ adaptations: { time: 'differs' } }, /has no message or schema override/],
    [
      { overrides: { schemas: { RoomEvent: { description: 'changed' } } } },
      /needs x-profile-reason/,
    ],
    [
      {
        overrides: { schemas: { RoomEvent: { 'x-profile-reason': 'differs', description: 'x' } } },
      },
      /roomEvent uses overridden #\/components\/schemas\/RoomEvent but has no adaptation reason/,
    ],
    [{ excluded: { nope: 'missing' } }, /excluded nope is not an official message/],
    [{ excluded: { time: 'gone' }, adaptations: { time: 'differs' } }, /both adapted and excluded/],
    [{ evidence: { time: [] } }, /evidence.time must be a non-empty array/],
  ];
  for (const [socket, expected] of failures) assert.throws(() => compose(socket), expected);
  const adapted = compose({
    adaptations: { roomEvent: 'differs' },
    overrides: { schemas: { RoomEvent: { 'x-profile-reason': 'differs', description: 'x' } } },
  });
  assert.deepEqual(record(record(record(adapted.components).messages).roomEvent)['x-profile'], {
    status: 'adapted',
    reason: 'differs',
    overriddenComponents: ['#/components/schemas/RoomEvent'],
  });
});

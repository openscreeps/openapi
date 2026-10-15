import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { FormatsPlugin } from 'ajv-formats';

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;
const spec: unknown = JSON.parse(
  await readFile(new URL('../openapi.json', import.meta.url), 'utf8'),
);
assert.ok(typeof spec === 'object' && spec !== null && 'components' in spec);
assert.ok(typeof spec.components === 'object' && spec.components !== null);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'urn:screeps:test', components: spec.components });
const schema = (name: string) => {
  const validate = ajv.getSchema<unknown>(`urn:screeps:test#/components/schemas/${name}`);
  assert.ok(validate, `missing schema ${name}`);
  return validate;
};

test('official capabilities admit optional menuData on feature entries', () => {
  const validate = schema('PlatformVersion');
  const shared = {
    ok: 1,
    protocol: 14,
    users: 0,
    serverData: {
      customObjectTypes: {},
      historyChunkSize: 100,
      renderer: { resources: {}, metadata: {} },
    },
  };
  assert.equal(validate(shared), true, ajv.errorsText(validate.errors));
  const official = {
    ...shared,
    serverData: {
      ...shared.serverData,
      features: [
        { name: 'auth', version: 1 },
        { name: 'market', version: 1, menuData: [{ section: 0, item: { label: 'Market' } }] },
      ],
    },
  };
  assert.equal(validate(official), true, ajv.errorsText(validate.errors));
});

test('official Steam ownership contains application IDs, not standalone flags', () => {
  const validate = schema('AuthSteamAccount');
  assert.equal(validate({ ownership: false }), false);
  assert.equal(validate({ ownership: [464350] }), true);
  assert.equal(validate({ ownership: { app: 464350 } }), false);
});

test('history diffs preserve null deletion markers and partial object updates', () => {
  const history = schema('PlatformHistory');
  assert.equal(
    history({
      timestamp: 0,
      room: 'W1N1',
      base: 100,
      ticks: { 100: { removed: null, changed: { hits: 10 } } },
    }),
    true,
  );
});

interface JsonSchema {
  discriminator?: unknown;
  properties?: Record<string, Record<string, unknown> | undefined>;
}

const source = {
  _id: 's',
  type: 'source',
  room: 'W1N1',
  x: 20,
  y: 30,
  energy: 3000,
  energyCapacity: 3000,
  ticksToRegeneration: 300,
};
const creep = {
  _id: 'c',
  type: 'creep',
  room: 'W1N1',
  x: 1,
  y: 1,
  user: 'u1',
  name: 'harvester1',
  body: [{ type: 'move', hits: 100, boost: null }],
  hits: 100,
  hitsMax: 100,
  fatigue: 0,
  store: {},
};

test('room objects accept both persisted effect forms and stay typed', () => {
  const validate = schema('GameRoomObject');
  const effect = { effect: 13, power: 13, level: 5, endTime: 120 };
  for (const effects of [[effect], { 0: effect }, null]) {
    assert.equal(validate({ ...source, effects }), true, ajv.errorsText(validate.errors));
  }
  assert.equal(validate({ ...source, effects: [{ effect: 13 }] }), false, 'effect needs endTime');
  assert.equal(validate({ ...source, energy: '3000' }), false, 'amounts are integers');
  assert.equal(validate({ ...creep, spawning: true }), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...creep, body: [{ type: 'move', hits: '100' }] }), false);
  const portal = { _id: 'p', type: 'portal', room: 'W10N10', x: 25, y: 25 };
  assert.equal(validate({ ...portal, destination: { shard: 'shard1', room: 'W10N10' } }), true);
  assert.equal(validate({ ...portal, destination: { x: 1, y: 1 } }), false, 'room is required');
});

test('room objects are discriminated by type; a described type never falls back', () => {
  const validate = schema('GameRoomObject');
  const { body: _body, ...bodiless } = creep;
  assert.equal(validate(bodiless), false, 'a creep without body is not an unknown object');
  assert.equal(schema('GameRoomObjectCreep')(creep), true);
  assert.equal(schema('GameRoomObjectSpawn')(creep), false, 'variants reject other types');
  const { ticksToRegeneration: _legacy, ...modern } = source;
  assert.equal(validate(modern), false, 'sources always carry ticksToRegeneration');
  const controller = { _id: 'k', type: 'controller', room: 'W1N1', x: 9, y: 9, level: 0 };
  assert.equal(validate(controller), true, 'world-generated controllers hold only level');
  assert.equal(validate({ ...controller, user: null, reservation: null }), true);
  assert.equal(validate({ ...controller, level: -1 }), false, 'levels are non-negative');
  const { schemas } = spec.components as { schemas: Record<string, JsonSchema | undefined> };
  const discriminator = schemas.GameRoomObject?.discriminator as {
    propertyName: string;
    mapping: Record<string, string>;
  };
  assert.equal(discriminator.propertyName, 'type');
  for (const [type, target] of Object.entries(discriminator.mapping)) {
    const property = schemas[target.slice(target.lastIndexOf('/') + 1)]?.properties?.type;
    assert.ok(
      property && (property.const === type || '$ref' in property),
      `mapping ${type} -> ${target} must name its own variant`,
    );
  }
});

test('unknown room object types validate as GameRoomObjectOther with base fields', () => {
  const validate = schema('GameRoomObject');
  const other = { _id: 'o', type: 'scoreCollector', room: 'W1N1', x: 3, y: 3, score: 5 };
  assert.equal(validate(other), true, ajv.errorsText(validate.errors));
  assert.equal(schema('GameRoomObjectOther')(other), true);
  assert.equal(schema('GameRoomObjectOther')(creep), false, 'described types are excluded');
  const { _id: _missing, ...anonymous } = other;
  assert.equal(validate(anonymous), false, 'base fields stay required');
  assert.equal(validate({ ...other, x: 50 }), false, 'positions stay in the room');
});

test('dropped resources keep integer amounts under the resource type key', () => {
  const validate = schema('GameRoomObject');
  const dropped = { _id: 'd', type: 'energy', room: 'W1N1', x: 2, y: 2, resourceType: 'H', H: 20 };
  assert.equal(validate(dropped), true, ajv.errorsText(validate.errors));
  assert.equal(validate({ ...dropped, type: 'H' }), true, 'any resource type may name a pile');
  assert.equal(validate({ ...dropped, H: '20' }), false, 'amounts are integers');
  assert.equal(validate({ ...dropped, H: -5 }), false, 'amounts are non-negative');
  assert.equal(validate({ ...dropped, resourceType: 'unobtainium' }), false);
  assert.equal(validate({ ...dropped, owner: 'u1' }), false, 'extra keys are amounts');
  const legacy = { _id: 'e', type: 'energy', room: 'W1N1', x: 2, y: 3, energy: 300 };
  assert.equal(validate(legacy), true, 'piles without resourceType hold energy');
});

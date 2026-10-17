import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';
import type { FormatsPlugin } from 'ajv-formats';
import {
  composePlugin,
  composePlugins,
  composeProfile,
  listOperations,
  type JsonObject,
} from '../lib/contracts.mjs';

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

const readJson = async (path: string): Promise<JsonObject> =>
  JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')) as JsonObject;
const official = spec as JsonObject;
const community = composeProfile(official, await readJson('profiles/community.json'));
const standalone = composeProfile(official, await readJson('profiles/standalone.json'));
const adminUtils = await readJson('plugins/screepsmod-admin-utils.json');
const auth = await readJson('plugins/screepsmod-auth.json');
const versionSchema = (document: JsonObject) => {
  const composed = new Ajv2020({ strict: false, allErrors: true });
  addFormats(composed);
  composed.addSchema({ $id: 'urn:screeps:composed', components: document.components });
  const validate = composed.getSchema<unknown>(
    'urn:screeps:composed#/components/schemas/PlatformVersion',
  );
  assert.ok(validate);
  return validate;
};
const fallbackFeatures = [
  {
    name: 'market',
    version: 1,
    menuData: [
      {
        section: 0,
        after: 'World',
        item: { label: 'Market', routerLink: '/market', svg: 'market' },
      },
    ],
  },
  { name: 'auth', version: 1 },
];
const serverData = {
  customObjectTypes: {},
  historyChunkSize: 20,
  socketUpdateThrottle: 1000,
  renderer: { resources: {}, metadata: {} },
};

test('community + screepsmod-admin-utils admits the admin-utils version reply; official and plain community do not', () => {
  const withPlugin = composePlugin(official, community, adminUtils);
  // GET /api/version of backend-local with screepsmod-auth and screepsmod-admin-utils.
  const reply = (shard: string | null) => ({
    ok: 1,
    protocol: 14,
    useNativeAuth: false,
    users: 1,
    serverData: {
      ...serverData,
      shards: [shard],
      features: [
        { name: 'auth', version: 1 },
        { name: 'auth-tokens' },
        {
          name: 'screepsmod-auth',
          version: '2.10.1',
          authTypes: ['password'],
          menuData: [{ section: 2, start: 1, item: { label: 'Change Password' } }],
        },
        { name: 'screepsmod-admin-utils', version: '1.37.1' },
      ],
    },
  });
  const plugin = versionSchema(withPlugin);
  for (const shard of [null, 'shard0']) {
    assert.equal(plugin(reply(shard)), true, JSON.stringify(plugin.errors));
    assert.equal(schema('PlatformVersion')(reply(shard)), false);
    assert.equal(versionSchema(community)(reply(shard)), false);
  }
  const operation = listOperations(withPlugin).find(
    (entry) => entry.operationId === 'platformVersion',
  );
  assert.equal((operation?.operation['x-profile'] as JsonObject).status, 'required');
  assert.deepEqual(
    (operation?.operation['x-plugins'] as JsonObject[]).map(({ name, status }) => [name, status]),
    [['screepsmod-admin-utils', 'adapted']],
  );
});

test('standalone capabilities require the openscreeps marker after the official fallback features', () => {
  const validate = versionSchema(standalone);
  const reply = (features: unknown[]) => ({
    ok: 1,
    protocol: 14,
    users: 0,
    serverData: { ...serverData, features },
  });
  const openscreeps = reply([...fallbackFeatures, { name: 'openscreeps', version: 1 }]);
  assert.equal(validate(openscreeps), true, JSON.stringify(validate.errors));
  assert.equal(schema('PlatformVersion')(openscreeps), true, 'the official contract admits it');
  assert.equal(
    validate(reply(fallbackFeatures)),
    false,
    'servers without the marker are not OpenScreeps',
  );
  assert.equal(
    validate({ ok: 1, protocol: 14, users: 0, serverData }),
    false,
    'features are required',
  );
});

test('plugins compose in order onto the community profile and mark what they provide, adapt and add', () => {
  const stacked = composePlugins(official, community, [auth, adminUtils]);
  const byId = new Map(
    listOperations(stacked).map((entry) => [entry.operationId, entry.operation]),
  );
  const plugins = (id: string) => byId.get(id)?.['x-plugins'] as JsonObject[] | undefined;
  assert.equal(byId.has('authSignin'), true);
  assert.equal((byId.get('authSignin')?.['x-profile'] as JsonObject).status, 'plugin');
  assert.equal(plugins('authSignin')?.[0]?.status, 'provided');
  assert.equal(plugins('registerCheckUsername')?.[0]?.status, 'adapted');
  assert.equal(plugins('platformServerStats')?.[0]?.status, 'addition');
  assert.equal(byId.get('gameTime')?.['x-plugins'], undefined, 'untouched base operations');
  const info = stacked.info as JsonObject;
  assert.deepEqual(
    (info['x-plugins'] as JsonObject[]).map((entry) => entry.name),
    ['screepsmod-auth', 'screepsmod-admin-utils'],
  );
  assert.equal(info['x-profile'], 'community');
  assert.equal(
    listOperations(stacked).length,
    listOperations(composePlugins(official, community, [adminUtils, auth])).length,
  );
});

test('plugin composition rejects unknown ids, unjustified overrides, collisions and the wrong base', () => {
  const plugin = (extra: JsonObject): JsonObject => ({
    name: 'test-plugin',
    description: 'Plugin used by the composition tests.',
    package: { name: 'test-plugin', version: '1.0.0' },
    source: 'auth',
    base: 'community',
    ...extra,
  });
  const evidence = [
    'https://github.com/screepsmods/screepsmod-auth/blob/9195e87424475139d749df6d8063df677c4f9917/lib/backend.js#L1',
  ];
  const fails = (extra: JsonObject, expected: RegExp, base: JsonObject = community) =>
    assert.throws(() => composePlugin(official, base, plugin(extra)), expected);
  assert.doesNotThrow(() => composePlugin(official, community, plugin({})));
  fails(
    { provides: { notAnOperation: 'x' }, evidence: { notAnOperation: evidence } },
    /provided notAnOperation is not an official operation/,
  );
  fails(
    { adaptations: { notAnOperation: 'x' } },
    /adaptation notAnOperation is neither a base operation nor provided/,
  );
  fails(
    { notes: { gameTime: 'x' } },
    /notes\.gameTime targets no provided, adapted or added operation/,
  );
  fails(
    { provides: { gameTime: 'x' }, evidence: { gameTime: evidence } },
    /provides gameTime, which the base already serves; adapt it instead/,
  );
  fails({ provides: { authSignin: 'x' } }, /authSignin needs evidence/);
  fails(
    { overrides: { paths: { '/api/game/time': { get: { description: 'Changed.' } } } } },
    /override get \/api\/game\/time patches gameTime without an adaptation reason/,
  );
  fails(
    {
      adaptations: { gameTime: 'x' },
      evidence: { gameTime: evidence },
      overrides: { components: { schemas: { GameTimeResponse: { description: 'Changed.' } } } },
    },
    /component override schemas\/GameTimeResponse needs x-plugin-reason/,
  );
  fails(
    {
      overrides: {
        components: { schemas: { ApiError: { description: 'Changed.', 'x-plugin-reason': 'x' } } },
      },
    },
    /uses overridden #\/components\/schemas\/ApiError but has no adaptation reason/,
  );
  fails(
    { adaptations: { gameTime: 'x' }, evidence: { gameTime: evidence } },
    /adaptation gameTime changes nothing/,
  );
  fails({ additions: { gameTime: 'x' } }, /addition gameTime reuses an official operationId/);
  fails({ base: 'standalone' }, /applies to profile standalone, but the base is profile community/);
  fails({}, /applies to profile community, but the base is profile standalone/, standalone);
  fails(
    { name: 'screepsmod-auth' },
    /screepsmod-auth is already applied/,
    composePlugin(official, community, auth),
  );
  fails({ unknown: true }, /unknown key unknown/);
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

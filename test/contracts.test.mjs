import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const spec = JSON.parse(await readFile(new URL('../openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'urn:screeps:test', components: spec.components });
const schema = (name) => ajv.getSchema(`urn:screeps:test#/components/schemas/${name}`);

test('capabilities admit official optional menuData and standalone omission of features', () => {
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
  const official = structuredClone(shared);
  official.serverData.features = [
    { name: 'auth', version: 1 },
    { name: 'market', version: 1, menuData: [{ section: 0, item: { label: 'Market' } }] },
  ];
  assert.equal(validate(official), true, ajv.errorsText(validate.errors));
});

test('Steam ownership accepts both real server representations, not arbitrary objects', () => {
  const validate = schema('AuthSteamAccount');
  assert.equal(validate({ ownership: false }), true);
  assert.equal(validate({ ownership: [464350] }), true);
  assert.equal(validate({ ownership: { app: 464350 } }), false);
});

test('administrator mutations require one identity, real changes and whitelisted fields', () => {
  const validate = schema('AdminCommand');
  assert.equal(validate({ action: 'user-update', username: 'ContractPlayer', cpu: 20 }), true);
  assert.equal(validate({ action: 'user-update', username: 'ContractPlayer' }), false);
  assert.equal(
    validate({ action: 'user-update', username: 'ContractPlayer', userId: 'id', cpu: 20 }),
    false,
  );
  assert.equal(validate({ action: 'user-remove' }), false);
  assert.equal(validate({ action: 'user-remove', username: 'ContractPlayer', force: true }), false);
  assert.equal(
    validate({ action: 'user-update', username: 'ContractPlayer', resources: { energy: 100 } }),
    false,
  );
  assert.equal(
    validate({ action: 'user-update', username: 'ContractPlayer', resources: { pixel: 0 } }),
    true,
  );
  assert.equal(validate({ action: 'tick', count: 1001 }), false);
});

test('bot modules require main and history diffs preserve null deletion markers', () => {
  const modules = schema('AdminModules');
  assert.equal(modules({ main: 'module.exports.loop = () => {}' }), true);
  assert.equal(modules({ library: 'module.exports = {}' }), false);
  assert.equal(modules({ main: '', '../escape': '' }), false);
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

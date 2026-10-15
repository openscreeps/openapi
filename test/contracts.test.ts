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

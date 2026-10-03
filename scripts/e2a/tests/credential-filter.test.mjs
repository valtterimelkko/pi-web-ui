// E2a-3 correction 01 — RED tests for the fail-closed credential filter.
// Luna major: the old filter failed open (kept nested non-zai keys and unknown
// top-level fields). The rebuilt builders must validate and REJECT unknown
// credential-bearing shapes, and never spread unknown fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthJson, buildModelsJson } from '../lib/agentdir.mjs';

test('buildAuthJson: the real flat store shape rebuilds to exactly the zai entry', () => {
  const input = {
    'github-copilot': { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
    zai: { type: 'api', key: 'z-cred' },
    deepseek: { type: 'api', key: 'd' },
  };
  const out = buildAuthJson(input);
  assert.deepEqual(out, { zai: { type: 'api', key: 'z-cred' } });
  assert.equal(JSON.stringify(out).includes('github-copilot'), false);
  assert.equal(JSON.stringify(out).includes('deepseek'), false);
});

test("buildAuthJson: rejects the reviewer's nested provider map (legacy.openrouter.apiKey)", () => {
  assert.throws(
    () => buildAuthJson({ legacy: { openrouter: { apiKey: 'x' } }, zai: { type: 'api', key: 'z' } }),
    /apiKey-named key|nested providers/i,
  );
});

test('buildAuthJson: rejects a top-level apiKey', () => {
  assert.throws(() => buildAuthJson({ apiKey: 'top-level', zai: { type: 'api', key: 'z' } }), /top-level apiKey/i);
});

test('buildAuthJson: rejects any apiKey-named key anywhere (foreign schema)', () => {
  assert.throws(
    () => buildAuthJson({ zai: { type: 'api', key: 'z', apiKey: 'smuggled' } }),
    /apiKey-named key/i,
  );
});

test('buildAuthJson: rejects a nested providers map below the root', () => {
  assert.throws(
    () => buildAuthJson({ wrapped: { providers: { zai: { type: 'api', key: 'k' } } } }),
    /nested providers/i,
  );
});

test('buildAuthJson: rejects a shape with no zai credential at all', () => {
  assert.throws(() => buildAuthJson({ deepseek: { type: 'api', key: 'd' } }), /no zai entry/i);
  assert.throws(() => buildAuthJson({}), /no zai entry/i);
  assert.throws(() => buildAuthJson(null), /no zai entry/i);
});

test('buildAuthJson: rejects unknown or missing fields inside the zai entry', () => {
  assert.throws(() => buildAuthJson({ zai: { type: 'api', key: 'z', mystery: 1 } }), /unknown field in zai entry: mystery/i);
  assert.throws(() => buildAuthJson({ zai: { type: 'api' } }), /zai.key missing/i);
  assert.throws(() => buildAuthJson({ zai: { key: 'z' } }), /zai.type missing/i);
  assert.throws(() => buildAuthJson({ zai: { type: 'api', key: '' } }), /non-empty string/i);
});

test('buildAuthJson: non-credential siblings without a providers key are dropped, not kept', () => {
  const out = buildAuthJson({ misc: { a: 1 }, zai: { type: 'api', key: 'z' } });
  assert.deepEqual(out, { zai: { type: 'api', key: 'z' } });
});

test('buildModelsJson: sibling providers with apiKeys are dropped; output is zai-only with no apiKey', () => {
  const input = {
    providers: {
      zai: { name: 'zai', apiKey: 'strip-me', models: [{ id: 'zai/glm-5.3-flash' }] },
      openai: { apiKey: 'other' },
      'glm-coding': { apiKey: 'gc', baseUrl: 'x' },
    },
    unknownTopLevel: { a: 1 },
  };
  const out = buildModelsJson(input);
  assert.deepEqual(Object.keys(out), ['providers']);
  assert.deepEqual(Object.keys(out.providers), ['zai']);
  assert.equal(out.providers.zai.models.length, 1);
  assert.equal(JSON.stringify(out).match(/api[_-]?key/i), null);
  assert.equal(JSON.stringify(out).includes('glm-coding'), false);
});

test('buildModelsJson: a clean input rebuilds to providers.zai without apiKey fields', () => {
  const input = { providers: { zai: { name: 'zai', apiKey: 'strip-me', models: [{ id: 'zai/glm-5.3-flash' }] } } };
  const out = buildModelsJson(input);
  assert.deepEqual(Object.keys(out), ['providers']);
  assert.deepEqual(Object.keys(out.providers), ['zai']);
  assert.equal(out.providers.zai.models.length, 1);
  assert.equal(JSON.stringify(out).match(/api[_-]?key/i), null);
});

test('buildModelsJson: rejects a top-level apiKey and nested provider maps', () => {
  assert.throws(() => buildModelsJson({ apiKey: 'top', providers: { zai: { name: 'zai' } } }), /top-level apiKey/i);
  assert.throws(
    () => buildModelsJson({ providers: { zai: { name: 'zai' } }, legacy: { providers: { openrouter: { apiKey: 'x' } } } }),
    /nested providers/i,
  );
});

// Parent FINAL correction 02 (Luna r2, R1-4 partly closed): an apiKey-named key in
// any top-level field other than `providers` is an unknown credential-bearing shape
// and must be REJECTED, not silently dropped. Sibling providers inside `providers`
// (the real file carries apiKeys for glm-coding, kimi-subscription, clinepass) are
// still dropped, so the real store keeps working.
test("buildModelsJson: rejects an apiKey in a non-providers top-level field (reviewer r2 legacy.apiKey)", () => {
  assert.throws(() => buildModelsJson({ providers: { zai: { baseUrl: 'x' } }, legacy: { apiKey: 'k' } }), /rejected/);
  assert.throws(() => buildModelsJson({ providers: { zai: { baseUrl: 'x' } }, extra: { deep: { api_key: 'k' } } }), /rejected/);
});

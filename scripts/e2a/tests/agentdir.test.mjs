// E2a-3 harness tests — isolated agent dir with a zai-only credential filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterModelsJson, assertIsolatedAgentDir } from '../lib/agentdir.mjs';

test('filterModelsJson keeps only the zai provider and strips apiKey entries', () => {
  const input = {
    providers: {
      zai: { name: 'zai', apiKey: 'sk-SHOULD-NOT-SURVIVE', baseUrl: 'https://api.z.ai/api/anthropic', models: [{ id: 'zai/glm-5.3-flash' }] },
      openai: { name: 'openai', apiKey: 'sk-OPENAI-SECRET', models: [{ id: 'gpt-x' }] },
      openaiCodex: { name: 'openai-codex', models: [{ id: 'openai-codex/gpt-6-luna' }] },
    },
  };
  const out = filterModelsJson(input);
  assert.deepEqual(Object.keys(out.providers), ['zai']);
  assert.equal(out.providers.zai.apiKey, undefined);
  assert.equal(JSON.stringify(out).includes('sk-SHOULD-NOT-SURVIVE'), false);
  assert.equal(JSON.stringify(out).includes('sk-OPENAI-SECRET'), false);
  assert.equal(out.providers.zai.models.length, 1);
});

test('filterModelsJson tolerates a providers-array shape and unknown shapes', () => {
  assert.deepEqual(filterModelsJson({ providers: [] }).providers, {});
  assert.deepEqual(filterModelsJson({}).providers, {});
});

test('assertIsolatedAgentDir refuses a destination inside the production agent dir or home', () => {
  assert.doesNotThrow(() => assertIsolatedAgentDir('/root/e2a-runs/a3/x/agent', '/root/.pi/agent'));
  assert.throws(() => assertIsolatedAgentDir('/root/.pi/agent', '/root/.pi/agent'), Error);
  assert.throws(() => assertIsolatedAgentDir('/root/.pi/agent-copy/sub', '/root/.pi/agent'), Error);
});

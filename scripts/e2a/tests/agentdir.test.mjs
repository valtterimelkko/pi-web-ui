// E2a-3 harness tests — isolated agent dir guard. The credential builders themselves
// are pinned in credential-filter.test.mjs (correction 01) and agentdir tests below
// only cover the path-overlap guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedAgentDir } from '../lib/agentdir.mjs';

test('assertIsolatedAgentDir refuses a destination that overlaps the production agent dir', () => {
  assert.doesNotThrow(() => assertIsolatedAgentDir('/root/e2a-runs/a3/x/agent', '/root/.pi/agent'));
  assert.throws(() => assertIsolatedAgentDir('/root/.pi/agent', '/root/.pi/agent'), Error);
  assert.throws(() => assertIsolatedAgentDir('/root/.pi/agent-copy/sub', '/root/.pi/agent'), Error);
});

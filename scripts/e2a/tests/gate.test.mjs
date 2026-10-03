// E2a-3 harness tests — STRESS-GATE pre-flight evaluator (pure logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, GiB } from '../lib/gate.mjs';

const healthy = {
  guardLiveFileExists: true,
  guardActive: true,
  lastSampleAgeSec: 5,
  memAvailableBytes: 13 * GiB,
  diskFreeBytes: 16 * GiB,
  softFlagExists: false,
  trippedFlagExists: false,
  lockHeld: false,
};

test('all-healthy input is allowed with no reasons', () => {
  const v = evaluateGate(healthy);
  assert.equal(v.allowed, true);
  assert.deepEqual(v.reasons, []);
});

test('missing GUARD-LIVE file blocks', () => {
  const v = evaluateGate({ ...healthy, guardLiveFileExists: false });
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.some((r) => /GUARD-LIVE/.test(r)));
});

test('inactive guard unit blocks', () => {
  const v = evaluateGate({ ...healthy, guardActive: false });
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.some((r) => /guard unit/i.test(r)));
});

test('stale sample (>=15s) blocks', () => {
  const v = evaluateGate({ ...healthy, lastSampleAgeSec: 15 });
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.some((r) => /sample/.test(r)));
  assert.equal(evaluateGate({ ...healthy, lastSampleAgeSec: 14.9 }).allowed, true);
});

test('low MemAvailable (<12 GiB) blocks', () => {
  const v = evaluateGate({ ...healthy, memAvailableBytes: 12 * GiB - 1 });
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.some((r) => /MemAvailable/.test(r)));
  assert.equal(evaluateGate({ ...healthy, memAvailableBytes: 12 * GiB }).allowed, true);
});

test('low disk free (<15 GiB) blocks', () => {
  const v = evaluateGate({ ...healthy, diskFreeBytes: 15 * GiB - 1 });
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.some((r) => /disk/.test(r)));
  assert.equal(evaluateGate({ ...healthy, diskFreeBytes: 15 * GiB }).allowed, true);
});

test('tripped flag blocks; soft flag blocks; lock held blocks', () => {
  assert.ok(evaluateGate({ ...healthy, trippedFlagExists: true }).reasons.some((r) => /TRIPPED/.test(r)));
  assert.ok(evaluateGate({ ...healthy, softFlagExists: true }).reasons.some((r) => /SOFT/.test(r)));
  assert.ok(evaluateGate({ ...healthy, lockHeld: true }).reasons.some((r) => /stress lock/i.test(r)));
});

test('all reasons collected, not fail-first', () => {
  const v = evaluateGate({ ...healthy, guardActive: false, trippedFlagExists: true, lockHeld: true });
  assert.equal(v.reasons.length, 3);
});

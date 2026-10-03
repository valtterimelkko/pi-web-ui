// E2a-3 correction 01 — RED tests for the arm-3 hog: it must stop on the PSI cap
// during allocation AND during the hold, free its buffers, and exit at once
// (10-note/Luna major: the old hog retained its buffers and slept 20 s blind).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHogCore } from '../arm3-memlow.mjs';

const GiB = 1024 ** 3;
const step = 256 * 1024 * 1024;
const CAP_FULL = 5;
const low = () => ({ fullAvg10: 0, someAvg10: 0 });
const high = () => ({ fullAvg10: 12.61, someAvg10: 3 });

test('hog stops at once when the cap trips during allocation', async () => {
  const result = await runHogCore({
    targetBytes: 4 * GiB, stepBytes: step, capFull: CAP_FULL, capSome: 20,
    readPsi: high, delay: () => Promise.resolve(), holdMs: 20_000, holdCheckMs: 100,
  });
  assert.equal(result.capped.phase, 'allocation');
  assert.equal(result.allocatedBytes, 0);
  assert.equal(result.buffersHeld, 0);
  assert.equal(result.capped.psi.fullAvg10, 12.61);
});

test('hog stops at once when the cap trips during the hold', async () => {
  const readings = [low(), low(), low(), low(), low(), high()]; // alloc steps then hold checks
  let calls = 0;
  let delays = 0;
  const result = await runHogCore({
    targetBytes: 1 * GiB, stepBytes: step, capFull: CAP_FULL, capSome: 20,
    readPsi: () => readings[Math.min(calls++, readings.length - 1)],
    delay: () => { delays += 1; return Promise.resolve(); },
    holdMs: 20_000, holdCheckMs: 100,
  });
  assert.equal(result.allocatedBytes, 1 * GiB);
  assert.equal(result.capped.phase, 'hold');
  assert.equal(result.capped.psi.fullAvg10, 12.61);
  assert.equal(result.buffersHeld, 0);
  // it must NOT sit through the full 20 s hold: only a few hold checks before the trip
  assert.ok(delays < 15, `expected an early exit, saw ${delays} delay calls`);
});

test('hog without a cap trip runs to target and holds for the full window, then frees', async () => {
  let delays = 0;
  const result = await runHogCore({
    targetBytes: 2 * step, stepBytes: step, capFull: CAP_FULL, capSome: 20,
    readPsi: low,
    delay: () => { delays += 1; return Promise.resolve(); },
    holdMs: 20_000, holdCheckMs: 100,
  });
  assert.equal(result.allocatedBytes, 2 * step);
  assert.equal(result.capped, null);
  assert.equal(result.buffersHeld, 0);
  // 2 alloc delays + 200 hold checks (20s / 100ms)
  assert.ok(delays >= 200, `expected the full hold, saw ${delays} delay calls`);
});

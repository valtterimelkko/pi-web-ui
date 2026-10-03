/**
 * E2a-5 harness unit tests — the pure logic the arms depend on, tested with
 * node:test (no repo test-config coupling: this lane adds no product code).
 *
 * Run: node --test scripts/e2a-rerun/harness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentile, windowStats, replayLatch, doubledFirstChunkVerdict, hb4VerdictOk, parseArgs,
} from './lib.mjs';

const rd = (atMs, lagP99Ms, extra = {}) => ({ atMs, at: new Date(atMs).toISOString(), lagP99Ms, lagP50Ms: Math.round(lagP99Ms / 2), lagMaxMs: lagP99Ms, activeTurns: 0, lagSampleCount: 100, ...extra });

test('percentile is nearest-rank ceil', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4], 0.99), 4);
  assert.equal(percentile([10], 0.5), 10);
  assert.equal(percentile([], 0.5), null);
});

test('windowStats filters by window and reports lag + activeTurns', () => {
  const readings = [
    rd(1000, 50, { activeTurns: 0 }),
    rd(2000, 200, { activeTurns: 2 }),
    rd(3000, 400, { activeTurns: 2 }),
    rd(4000, 100, { activeTurns: 1 }),
    rd(90_000, 999, { activeTurns: 0 }), // outside the window
  ];
  const s = windowStats(readings, 1500, 5000);
  assert.equal(s.readingCount, 3);
  assert.equal(s.lagP50.n, 3);
  assert.deepEqual(s.lagP50, { p50: 100, p99: 200, max: 200, n: 3 });
  assert.deepEqual(s.lagP99, { p50: 200, p99: 400, max: 400, n: 3 });
  assert.equal(s.peakActiveTurns, 2);
  assert.equal(s.activeTurnsSamples.length, 3);
});

test('replayLatch: 2 consecutive readings at/above 300 latch; recovery below 150', () => {
  const readings = [rd(1000, 100), rd(2000, 310), rd(3000, 320), rd(4000, 140), rd(5000, 100)];
  const r = replayLatch(readings);
  assert.equal(r.latched, false, 'latched must clear after recovery');
  assert.ok(r.trace[2].latched, 'latched at the second ≥300 reading');
  assert.ok(!r.trace[4].latched, 'recovered below 150');
});

test('replayLatch: a single ≥300 reading does not latch', () => {
  const r = replayLatch([rd(1000, 100), rd(2000, 450), rd(3000, 100)]);
  assert.equal(r.latched, false);
  assert.equal(r.trace[1].latched, false);
});

test('replayLatch: stale gap resets the sustained counter', () => {
  const r = replayLatch([rd(1000, 310), rd(200_000, 310)]);
  assert.equal(r.trace[1].consecutive, 1, 'gap > 75 s resets the counter');
});

test('doubledFirstChunkVerdict: clean render passes, doubled prefix fails', () => {
  const clean = doubledFirstChunkVerdict({ renderedText: 'prefix A5HB2-LIVE-1 suffix', transcriptText: 'A5HB2-LIVE-1' });
  assert.equal(clean.ok, true);
  const doubled = doubledFirstChunkVerdict({ renderedText: 'AA5HB2-LIVE-1 more', transcriptText: 'A5HB2-LIVE-1' });
  assert.equal(doubled.ok, false);
  assert.equal(doubled.doubledFound, true);
  const missing = doubledFirstChunkVerdict({ renderedText: 'unrelated', transcriptText: 'A5HB2-LIVE-1' });
  assert.equal(missing.ok, false);
});

test('hb4VerdictOk encodes the two claims', () => {
  assert.equal(hb4VerdictOk('1-page-cache', { verdict: 'admitted' }), true);
  assert.equal(hb4VerdictOk('1-page-cache', { verdict: 'refused(memory_pressure)' }), false);
  assert.equal(hb4VerdictOk('2-anon', { verdict: 'refused(memory_pressure)', reason: 'memory_pressure' }), true);
  assert.equal(hb4VerdictOk('2-anon', { verdict: 'refused(turn_slots)', reason: 'turn_slots' }), false);
  assert.equal(hb4VerdictOk('2-anon', { verdict: 'admitted' }), false);
});

test('parseArgs handles --key=value and bare flags', () => {
  const a = parseArgs(['--run-dir=/tmp/x', '--smoke', '--count=66']);
  assert.deepEqual(a, { 'run-dir': '/tmp/x', smoke: 'true', count: '66' });
});

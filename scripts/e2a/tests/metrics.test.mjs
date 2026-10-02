// E2a-3 harness tests — health-metrics parsing, window slicing, summaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHealthJsonl,
  sliceWindow,
  percentileNearestRank,
  summariseField,
  summarisePhases,
} from '../lib/metrics.mjs';

const row = (atMs, lagP99Ms, lagMaxMs, lagP50Ms, cpu) => ({
  atMs, lagP99Ms, lagMaxMs, lagP50Ms, mainThreadCpuPercentOfCore: cpu,
});

test('parseHealthJsonl keeps valid lines, skips malformed ones', () => {
  const text = [
    JSON.stringify(row(100, 7, 11, 0, 7.3)),
    'not json at all',
    JSON.stringify(row(200, 9, 16, 1, 6.1)),
    '',
  ].join('\n');
  const rows = parseHealthJsonl(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].atMs, 100);
  assert.equal(rows[1].lagP99Ms, 9);
});

test('sliceWindow is inclusive of t0, exclusive of t1', () => {
  const rows = [row(90, 1, 1, 1, 1), row(100, 2, 2, 2, 2), row(150, 3, 3, 3, 3), row(200, 4, 4, 4, 4)];
  assert.deepEqual(sliceWindow(rows, 100, 200).map((r) => r.atMs), [100, 150]);
});

test('percentileNearestRank matches the nearest-rank definition', () => {
  assert.equal(percentileNearestRank([1, 2, 3, 4], 50), 2);
  assert.equal(percentileNearestRank([1, 2, 3, 4], 100), 4);
  assert.equal(percentileNearestRank([1, 2, 3, 4], 1), 1);
  assert.equal(percentileNearestRank([5], 99), 5);
  assert.equal(percentileNearestRank([10, 2, 8, 4, 6], 50), 6); // sorted [2,4,6,8,10], ceil(0.5*5)=3rd
});

test('summariseField reports n, p50, p99, max from raw rows', () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(1000 + i, i, i * 2, 0, 5));
  const s = summariseField(rows, 'lagP99Ms');
  assert.equal(s.n, 100);
  assert.equal(s.p50, 49); // ceil(0.5*100)=50th of 0..99 → 49
  assert.equal(s.p99, 98); // ceil(0.99*100)=99th → 98
  assert.equal(s.max, 99);
});

test('summarisePhases slices per phase and summarises the lag fields', () => {
  const rows = [row(0, 1, 1, 0, 5), row(10, 2, 3, 1, 6), row(20, 3, 5, 1, 7), row(30, 9, 12, 2, 8)];
  const phases = { before: [0, 20], during: [20, 40] };
  const out = summarisePhases(rows, phases);
  assert.equal(out.before.n, 2);
  assert.equal(out.before.lagP99.max, 2);
  assert.equal(out.during.n, 2);
  assert.equal(out.during.lagP99.max, 9);
  assert.equal(out.during.lagMax.max, 12);
});

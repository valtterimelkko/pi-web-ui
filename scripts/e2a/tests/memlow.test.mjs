// E2a-3 harness tests — memory cgroup file parsing and the MemoryLow contrast summariser (arm 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemoryCurrent,
  parseMemoryStat,
  summariseMemoryLowContrast,
} from '../lib/memlow.mjs';

test('parseMemoryCurrent reads a byte count', () => {
  assert.equal(parseMemoryCurrent('1234567\n'), 1234567);
  assert.throws(() => parseMemoryCurrent('max'), Error);
});

test('parseMemoryStat extracts file/anon byte counts', () => {
  const stat = parseMemoryStat('anon 1000\nfile 2000\nfile_writeback 300\nslab 50\n');
  assert.equal(stat.anon, 1000);
  assert.equal(stat.file, 2000);
  assert.equal(stat.file_writeback, 300);
  assert.equal(stat.slab, 50);
  assert.equal(stat.nonexistent, undefined);
});

test('summariseMemoryLowContrast: crisp protection contrast', () => {
  const out = summariseMemoryLowContrast({
    low: { currentBytes: 1_500_000_000, fileBytes: 1_480_000_000, anonBytes: 20_000_000, lowEvents: 0, rereadMs: 900, rereadBaselineMs: 850 },
    free: { currentBytes: 400_000_000, fileBytes: 380_000_000, anonBytes: 20_000_000, lowEvents: 5, rereadMs: 4200, rereadBaselineMs: 860 },
  });
  assert.equal(out.crispContrast, true);
  assert.ok(out.notes.some((n) => /protected/i.test(n)));
  assert.ok(out.notes.some((n) => /evicted/i.test(n)));
});

test('summariseMemoryLowContrast: no contrast is reported as null result, with the numbers', () => {
  const out = summariseMemoryLowContrast({
    low: { currentBytes: 500_000_000, fileBytes: 480_000_000, anonBytes: 20_000_000, lowEvents: 3, rereadMs: 4000, rereadBaselineMs: 850 },
    free: { currentBytes: 500_000_000, fileBytes: 480_000_000, anonBytes: 20_000_000, lowEvents: 3, rereadMs: 4100, rereadBaselineMs: 860 },
  });
  assert.equal(out.crispContrast, false);
  assert.ok(out.notes.some((n) => /no contrast/i.test(n)));
});

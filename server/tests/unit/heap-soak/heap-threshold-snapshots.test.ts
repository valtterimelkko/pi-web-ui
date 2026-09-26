import { describe, expect, it } from 'vitest';
import { HEAP_SNAPSHOT_THRESHOLDS_MB, nextHeapThresholdSnapshot } from '../../../src/live-validation/heap-soak/heap-threshold-snapshots.js';

const MB = 1024 * 1024;

describe('nextHeapThresholdSnapshot', () => {
  it('returns nothing below the first threshold', () => {
    expect(nextHeapThresholdSnapshot(900 * MB, [])).toBeUndefined();
  });

  it('returns the highest unfired threshold that has been crossed', () => {
    expect(nextHeapThresholdSnapshot(1100 * MB, [])).toBe(1024);
    expect(nextHeapThresholdSnapshot(2100 * MB, [])).toBe(2048);
  });

  it('never fires a threshold twice (fired list survives a supervisor restart via run-state)', () => {
    expect(nextHeapThresholdSnapshot(1100 * MB, [1024])).toBeUndefined();
    expect(nextHeapThresholdSnapshot(2100 * MB, [2048])).toBeUndefined();
  });

  it('keeps thresholds well below the 4 GiB cap so a snapshot itself cannot push the heap over', () => {
    expect(Math.max(...HEAP_SNAPSHOT_THRESHOLDS_MB)).toBeLessThanOrEqual(2048);
  });
});

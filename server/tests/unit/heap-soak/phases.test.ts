import { describe, expect, it } from 'vitest';
import {
  checkpointOffsetsMs,
  FULL_SCHEDULE,
  isRunComplete,
  MICRO_SCHEDULE,
  nextDueOffset,
  phaseAt,
  snapshotOffsetsMs,
} from '../../../src/live-validation/heap-soak/phases.js';

describe('phaseAt', () => {
  it('classifies wave vs idle for the micro schedule', () => {
    expect(phaseAt(0, MICRO_SCHEDULE)).toBe('wave');
    expect(phaseAt(MICRO_SCHEDULE.waveMs - 1, MICRO_SCHEDULE)).toBe('wave');
    expect(phaseAt(MICRO_SCHEDULE.waveMs, MICRO_SCHEDULE)).toBe('idle');
    expect(phaseAt(MICRO_SCHEDULE.waveMs + MICRO_SCHEDULE.idleMs, MICRO_SCHEDULE)).toBe('wave'); // next cycle
  });
});

describe('checkpointOffsetsMs / snapshotOffsetsMs', () => {
  it('produces 4 checkpoint offsets at +1h/+6h/+12h/+18h for the full 24h schedule', () => {
    const offsets = checkpointOffsetsMs(FULL_SCHEDULE);
    expect(offsets).toEqual([1, 6, 12, 18].map((h) => h * 3_600_000));
  });

  it('produces evenly spaced snapshot offsets including start and end', () => {
    const offsets = snapshotOffsetsMs(FULL_SCHEDULE);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(FULL_SCHEDULE.totalMs);
    expect(offsets.length).toBe(FULL_SCHEDULE.snapshotCount);
  });

  it('a single-snapshot config returns just the start', () => {
    expect(snapshotOffsetsMs({ ...FULL_SCHEDULE, snapshotCount: 1 })).toEqual([0]);
  });
});

describe('nextDueOffset', () => {
  it('returns the earliest due, not-yet-fired offset', () => {
    const offsets = [100, 200, 300];
    expect(nextDueOffset(250, offsets, new Set())).toBe(100);
    expect(nextDueOffset(250, offsets, new Set([100]))).toBe(200);
    expect(nextDueOffset(250, offsets, new Set([100, 200]))).toBeUndefined();
  });

  it('is tolerant of a restart: already-fired offsets (persisted in run-state) are skipped', () => {
    expect(nextDueOffset(1000, [100, 200], new Set([100, 200]))).toBeUndefined();
  });
});

describe('isRunComplete', () => {
  it('flags completion at or past totalMs', () => {
    expect(isRunComplete(MICRO_SCHEDULE.totalMs - 1, MICRO_SCHEDULE)).toBe(false);
    expect(isRunComplete(MICRO_SCHEDULE.totalMs, MICRO_SCHEDULE)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FULL_RUN_HOURS,
  FULL_SCHEDULE,
  MAX_FULL_RUN_HOURS,
  MIN_FULL_RUN_HOURS,
  MICRO_SCHEDULE,
  checkpointOffsetsMs,
  endSnapshotOffsetMs,
  fullScheduleForHours,
  interimSnapshotOffsetsMs,
  parseFullRunHours,
  snapshotOffsetsMs,
} from '../../../src/live-validation/heap-soak/phases.js';

describe('parseFullRunHours (B0.1 defect 5)', () => {
  it('accepts a positive whole number of hours', () => {
    expect(parseFullRunHours('6')).toEqual({ ok: true, hours: 6 });
    expect(parseFullRunHours(24)).toEqual({ ok: true, hours: 24 });
    expect(parseFullRunHours(' 3 ')).toEqual({ ok: true, hours: 3 });
  });

  it('accepts the documented minimum', () => {
    expect(parseFullRunHours(String(MIN_FULL_RUN_HOURS))).toEqual({ ok: true, hours: MIN_FULL_RUN_HOURS });
  });

  it('rejects a missing value', () => {
    const result = parseFullRunHours(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--hours/);
  });

  it('rejects zero, negatives and non-integers', () => {
    for (const raw of ['0', '-3', '1.5', 'abc', '']) {
      expect(parseFullRunHours(raw).ok).toBe(false);
    }
  });

  it('rejects below the minimum and above the maximum', () => {
    const tooSmall = parseFullRunHours(String(MIN_FULL_RUN_HOURS - 1));
    expect(tooSmall.ok).toBe(false);
    if (!tooSmall.ok) expect(tooSmall.error).toMatch(/at least/);
    const tooBig = parseFullRunHours(String(MAX_FULL_RUN_HOURS + 1));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toMatch(/at most/);
  });

  it('defaults to 24 h when the caller omits --hours', () => {
    expect(DEFAULT_FULL_RUN_HOURS).toBe(24);
    expect(FULL_SCHEDULE.totalMs).toBe(24 * 3_600_000);
  });
});

describe('fullScheduleForHours (B0.1 defect 5)', () => {
  it('scales the window and every checkpoint/snapshot offset with the window', () => {
    const schedule = fullScheduleForHours(6);
    expect(schedule.totalMs).toBe(6 * 3_600_000);
    expect(checkpointOffsetsMs(schedule)).toEqual([1, 6, 12, 18].map((h) => Math.round((h / 24) * 6 * 3_600_000)));
    expect(snapshotOffsetsMs(schedule)).toEqual([0, 3 * 3_600_000, 6 * 3_600_000]);
  });

  it('keeps the 24 h default identical to FULL_SCHEDULE', () => {
    expect(fullScheduleForHours(DEFAULT_FULL_RUN_HOURS)).toEqual(FULL_SCHEDULE);
  });

  it('refuses an out-of-range window rather than silently truncating', () => {
    expect(() => fullScheduleForHours(0)).toThrow(/hours/);
    expect(() => fullScheduleForHours(MAX_FULL_RUN_HOURS + 1)).toThrow(/hours/);
    expect(() => fullScheduleForHours(1.5)).toThrow(/hours/);
  });
});

describe('interimSnapshotOffsetsMs / endSnapshotOffsetMs (B0.1 defect 2)', () => {
  it('splits the declared offsets into in-window snapshots and the post-window end snapshot', () => {
    expect(interimSnapshotOffsetsMs(FULL_SCHEDULE)).toEqual([0, 12 * 3_600_000]);
    expect(endSnapshotOffsetMs(FULL_SCHEDULE)).toBe(24 * 3_600_000);
  });

  it('leaves only the start snapshot in-window for the two-snapshot micro schedule', () => {
    expect(interimSnapshotOffsetsMs(MICRO_SCHEDULE)).toEqual([0]);
    expect(endSnapshotOffsetMs(MICRO_SCHEDULE)).toBe(MICRO_SCHEDULE.totalMs);
  });

  it('never reports the end offset as an interim offset (the sampler cannot reach it)', () => {
    for (const schedule of [FULL_SCHEDULE, MICRO_SCHEDULE, fullScheduleForHours(1)]) {
      expect(interimSnapshotOffsetsMs(schedule)).not.toContain(schedule.totalMs);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { MemoryJournalPolicy } from '../../../src/observability/memory-journal-policy.js';

/** The pre-A2 gate: log whenever heap is high or many sessions are resident. */
function legacyGate(sample: { heapUsedMb: number; sessionCount: number }): boolean {
  return sample.heapUsedMb > 500 || sample.sessionCount > 5;
}

describe('MemoryJournalPolicy', () => {
  it('always logs the first sample so the journal has a baseline', () => {
    const now = 0;
    const policy = new MemoryJournalPolicy({ now: () => now });
    expect(policy.shouldLog({ heapUsedMb: 120, sessionCount: 0 })).toBe(true);
    expect(policy.shouldLog({ heapUsedMb: 120, sessionCount: 0 })).toBe(false);
  });

  it('logs on a significant heap change and not on small drift', () => {
    let now = 0;
    const policy = new MemoryJournalPolicy({ minDeltaMb: 100, heartbeatMs: 1_800_000, now: () => now });
    expect(policy.shouldLog({ heapUsedMb: 1_000, sessionCount: 0 })).toBe(true);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 1_040, sessionCount: 0 })).toBe(false);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 1_100, sessionCount: 0 })).toBe(true);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 1_150, sessionCount: 0 })).toBe(false);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 1_200, sessionCount: 0 })).toBe(true);
  });

  it('heartbeats low-frequency while the server is worth reporting on', () => {
    let now = 0;
    const policy = new MemoryJournalPolicy({ heartbeatMs: 1_800_000, heartbeatHeapMb: 500, now: () => now });
    expect(policy.shouldLog({ heapUsedMb: 1_500, sessionCount: 2 })).toBe(true);
    now += 1_800_000;
    expect(policy.shouldLog({ heapUsedMb: 1_500, sessionCount: 2 })).toBe(true);
    now += 1_800_000;
    expect(policy.shouldLog({ heapUsedMb: 1_500, sessionCount: 2 })).toBe(true);
  });

  it('stays silent on an idle server instead of inventing heartbeat traffic', () => {
    let now = 0;
    const policy = new MemoryJournalPolicy({ heartbeatMs: 1_800_000, heartbeatHeapMb: 500, heartbeatSessions: 5, now: () => now });
    expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 0 })).toBe(true);
    for (let index = 0; index < 240; index++) {
      now += 30_000;
      expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 0 })).toBe(false);
    }
  });

  it('logs when the resident-session regime changes, not on small drift', () => {
    let now = 0;
    const policy = new MemoryJournalPolicy({ heartbeatMs: 1_800_000, heartbeatSessions: 5, now: () => now });
    expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 1 })).toBe(true);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 2 })).toBe(false);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 6 })).toBe(true);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 7 })).toBe(false);
    now += 30_000;
    expect(policy.shouldLog({ heapUsedMb: 200, sessionCount: 5 })).toBe(true);
  });

  it('reduces journal volume by an order of magnitude on a production-like heap', () => {
    let now = 0;
    const policy = new MemoryJournalPolicy({ heartbeatMs: 1_800_000, now: () => now });
    const sample = { heapUsedMb: 1_500, sessionCount: 1 };
    let legacyLines = 0;
    let policyLines = 0;
    // One hour at the memory-check cadence (30 s).
    for (let index = 0; index < 120; index++) {
      now += 30_000;
      if (legacyGate(sample)) legacyLines += 1;
      if (policy.shouldLog(sample)) policyLines += 1;
    }
    expect(legacyLines).toBe(120);
    expect(policyLines).toBeLessThanOrEqual(3);
    expect(policyLines).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Phase 4b (contract 1.45.0) — ownership status reader decisions.
 *
 * Covers the owner correction C1: liveness is NOT process.kill(pid, 0) alone —
 * the lease's recorded process-start identity must match, a recycled pid is a
 * DEAD owner, and uncertain evidence fails CLOSED.
 */
import { describe, it, expect } from 'vitest';
import {
  decidePiOwnershipAction,
  evaluateOwnerLiveness,
  readPiOwnershipStatus,
  OWNERSHIP_STATUS_SYMBOL,
  defaultOwnershipProbes,
  type PiOwnershipSnapshot,
  type PiLeaseRecord,
  type OwnershipProbes,
} from '../../../src/pi/session-ownership-status.js';

const probes: OwnershipProbes = {
  processIsAlive: (pid) => pid === 100 || pid === 300,
  // Live pids report their (deterministic) start identity; the test asserts
  // mismatches against the lease's recorded identity.
  processStartIdentity: (pid) => (pid === 100 ? 'start-100' : pid === 300 ? null : `start-${pid}`),
};

function snapshot(overrides: Partial<PiOwnershipSnapshot> = {}): PiOwnershipSnapshot {
  return { status: 'conflict', reason: 'session is owned by another live runtime (pid 100)', ...overrides };
}

function lease(overrides: Partial<PiLeaseRecord> = {}): PiLeaseRecord {
  return { pid: 100, pidStartIdentity: 'start-100', state: 'owned', mode: 'tui', ...overrides };
}

describe('evaluateOwnerLiveness (Phase 4b, correction C1)', () => {
  it('alive: pid live AND recorded start identity matches', () => {
    expect(evaluateOwnerLiveness(lease(), probes)).toBe('alive');
  });

  it('dead: process gone', () => {
    expect(evaluateOwnerLiveness(lease({ pid: 200, pidStartIdentity: 'start-200' }), probes)).toBe('dead');
  });

  it('pid_reused: process alive but start identity differs — counts as DEAD for gating', () => {
    // pid 100 is alive with current identity start-100; a lease recorded by a
    // PREVIOUS process that recycled the same pid no longer matches.
    expect(evaluateOwnerLiveness(lease({ pid: 100, pidStartIdentity: 'start-old' }), probes)).toBe('pid_reused');
  });

  it('uncertain: live pid with unreadable identity, or lease without a recorded identity', () => {
    expect(evaluateOwnerLiveness(lease({ pid: 300, pidStartIdentity: 'start-300' }), probes)).toBe('uncertain');
    expect(evaluateOwnerLiveness(lease({ pid: 100, pidStartIdentity: undefined }), probes)).toBe('uncertain');
  });

  it('absent: no usable owner pid', () => {
    expect(evaluateOwnerLiveness(null, probes)).toBe('absent');
    expect(evaluateOwnerLiveness(lease({ pid: undefined }), probes)).toBe('absent');
    expect(evaluateOwnerLiveness(lease({ pid: -5 }), probes)).toBe('absent');
  });
});

describe('decidePiOwnershipAction (Phase 4b)', () => {
  it('proceeds for unknown, unmanaged and owned snapshots (unknown never gates)', () => {
    for (const status of ['unknown', 'unmanaged', 'owned'] as const) {
      const decision = decidePiOwnershipAction(snapshot({ status }), lease(), probes);
      expect(decision).toMatchObject({ action: 'proceed', status });
    }
  });

  it('refuses a fenced session with a live foreign owner (S6)', () => {
    const decision = decidePiOwnershipAction(snapshot(), lease(), probes);
    expect(decision).toMatchObject({ action: 'refuse_live', status: 'conflict', ownerPid: 100, ownerMode: 'tui' });
    expect(decision.uncertain).toBeUndefined();
  });

  it('refuses a handing-off lease regardless of owner liveness, flagging the handoff', () => {
    const decision = decidePiOwnershipAction(snapshot({ status: 'uncertain' }), lease({ state: 'handing_off', pid: 200 }), probes);
    expect(decision).toMatchObject({ action: 'refuse_live', handoffAvailable: true });
  });

  it('recovers a fenced session whose recorded owner is dead', () => {
    const decision = decidePiOwnershipAction(snapshot(), lease({ pid: 200, pidStartIdentity: 'start-200' }), probes);
    expect(decision).toMatchObject({ action: 'recover', status: 'conflict' });
  });

  it('RED (correction C1): recovers when the pid was RECYCLED by another process', () => {
    // pid 100 is alive, but its start ticks no longer match the lease record.
    const decision = decidePiOwnershipAction(snapshot(), lease({ pid: 100, pidStartIdentity: 'start-stale' }), probes);
    expect(decision.action).toBe('recover');
  });

  it('RED (correction C1): fails CLOSED with a refusal when liveness is uncertain', () => {
    // Live-looking pid whose identity cannot be read.
    const decision = decidePiOwnershipAction(snapshot(), lease({ pid: 300, pidStartIdentity: 'start-300' }), probes);
    expect(decision).toMatchObject({ action: 'refuse_live', uncertain: true });
    // Lease without a recorded identity at all.
    const noIdentity = decidePiOwnershipAction(snapshot(), lease({ pidStartIdentity: undefined }), probes);
    expect(noIdentity).toMatchObject({ action: 'refuse_live', uncertain: true });
  });

  it('recovers when the lease file is absent (dead/absent owner)', () => {
    const decision = decidePiOwnershipAction(snapshot({ status: 'uncertain' }), null, probes);
    expect(decision).toMatchObject({ action: 'recover', status: 'uncertain' });
  });
});

describe('readPiOwnershipStatus (Phase 4b)', () => {
  it('answers unknown when nothing is published', () => {
    // This test process never published for a unique path — and the symbol is
    // absent entirely in a fresh process.
    const host = globalThis as typeof globalThis & Record<symbol, unknown>;
    const previous = host[OWNERSHIP_STATUS_SYMBOL];
    delete host[OWNERSHIP_STATUS_SYMBOL];
    try {
      expect(readPiOwnershipStatus('/tmp/never-published.jsonl')).toMatchObject({ status: 'unknown' });

      const map = new Map();
      host[OWNERSHIP_STATUS_SYMBOL] = map;
      expect(readPiOwnershipStatus('/tmp/never-published.jsonl')).toMatchObject({ status: 'unknown' });
    } finally {
      if (previous === undefined) delete host[OWNERSHIP_STATUS_SYMBOL];
      else host[OWNERSHIP_STATUS_SYMBOL] = previous;
    }
  });

  it('reads a published snapshot back by canonical path', () => {
    const host = globalThis as typeof globalThis & Record<symbol, unknown>;
    const previous = host[OWNERSHIP_STATUS_SYMBOL];
    const map = new Map();
    host[OWNERSHIP_STATUS_SYMBOL] = map;
    try {
      map.set('/tmp/some-session.jsonl', { status: 'owned', reason: 'r', ownerPid: 7, ownerMode: 'rpc', updatedAt: 5 });
      expect(readPiOwnershipStatus('/tmp/some-session.jsonl')).toMatchObject({ status: 'owned', ownerPid: 7, ownerMode: 'rpc' });
    } finally {
      if (previous === undefined) delete host[OWNERSHIP_STATUS_SYMBOL];
      else host[OWNERSHIP_STATUS_SYMBOL] = previous;
    }
  });

  it('the default probes read real /proc data (sanity)', () => {
    expect(defaultOwnershipProbes.processIsAlive(process.pid)).toBe(true);
    expect(defaultOwnershipProbes.processStartIdentity(process.pid)).toEqual(expect.any(String));
    expect(defaultOwnershipProbes.processIsAlive(999_999_999)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  KNOWN_BOUNDED_RETAINED_SLOTS,
  computeRetainedDeletedChildren,
  countKnownSlotRetentions,
  endDrainTimeoutMs,
  evaluateDrain,
  renderRetentionVerdict,
} from '../../../src/live-validation/heap-soak/end-drain.js';
import { MICRO_SCHEDULE, fullScheduleForHours } from '../../../src/live-validation/heap-soak/phases.js';

describe('evaluateDrain (B0.1 correction 02/03)', () => {
  it('is drained only when nothing is in flight, every created child is terminal, and no create is pending', () => {
    expect(evaluateDrain({ inFlight: new Set(), openSessionIds: [] })).toMatchObject({ drained: true, inFlightCount: 0, openCount: 0, pendingCreateCount: 0, liveChildren: [] });
  });

  it('is not drained while a child is still in flight', () => {
    const status = evaluateDrain({ inFlight: new Set(['a']), openSessionIds: ['a'] });
    expect(status.drained).toBe(false);
    expect(status.liveChildren).toEqual(['a']);
  });

  it('is not drained while a created child still lacks a child_deleted/orphan_swept event', () => {
    expect(evaluateDrain({ inFlight: new Set(), openSessionIds: ['b'] }).drained).toBe(false);
  });

  it('is not drained while a session creation is dispatched but unresolved (correction 03 item 1)', () => {
    const status = evaluateDrain({ inFlight: new Set(), openSessionIds: [], pendingCreateCount: 2 });
    expect(status.drained).toBe(false);
    expect(status.pendingCreateCount).toBe(2);
    // The session ids are unknown until createSession resolves, so the live list cannot include them.
    expect(status.liveChildren).toEqual([]);
  });

  it('unions in-flight and open children without duplicating', () => {
    expect(evaluateDrain({ inFlight: new Set(['a', 'b']), openSessionIds: ['a', 'b', 'c'] }).liveChildren).toEqual(['a', 'b', 'c']);
  });
});

describe('endDrainTimeoutMs', () => {
  it('allows at least one wave and at least two minutes to drain', () => {
    expect(endDrainTimeoutMs(MICRO_SCHEDULE)).toBe(120_000);
    expect(endDrainTimeoutMs(fullScheduleForHours(1))).toBe(600_000);
  });
});

describe('countKnownSlotRetentions (correction 03 item 3)', () => {
  const slot = KNOWN_BOUNDED_RETAINED_SLOTS[0];

  it('counts instances only when the retainer chain actually goes through the slot', () => {
    expect(countKnownSlotRetentions([{ instances: 1, chain: `object:global\n  --context:${slot.chainMarker}-->` }])).toBe(1);
  });

  it('returns zero when the slot is absent from the chains (absent-slot regression)', () => {
    expect(countKnownSlotRetentions([{ instances: 1, chain: 'object:global\n  --property:someOtherHolder-->' }])).toBe(0);
    expect(countKnownSlotRetentions([])).toBe(0);
  });

  it('never excludes more instances than the declared bounded slot', () => {
    expect(countKnownSlotRetentions([{ instances: 5, chain: `--context:${slot.chainMarker}-->` }])).toBe(slot.instances);
  });
});

describe('computeRetainedDeletedChildren (correction 03 item 3)', () => {
  const base = { analysisIsEndSnapshot: true, drainDrained: true } as const;

  it('reports zero when the snapshot holds exactly the live children', () => {
    expect(computeRetainedDeletedChildren({ ...base, agentSessionCount: 5, liveChildrenAtSnapshot: 5, verifiedKnownSlotInstances: 0 }).retainedDeletedChildren).toBe(0);
  });

  it('excludes the known slot only when it was actually verified in this snapshot', () => {
    expect(computeRetainedDeletedChildren({ ...base, agentSessionCount: 1, liveChildrenAtSnapshot: 0, verifiedKnownSlotInstances: 1 }).retainedDeletedChildren).toBe(0);
  });

  it('reports an unverified extra AgentSession as unclassified retained (absent-slot regression)', () => {
    const verdict = computeRetainedDeletedChildren({ ...base, agentSessionCount: 1, liveChildrenAtSnapshot: 0, verifiedKnownSlotInstances: 0 });
    expect(verdict.retainedDeletedChildren).toBe(1);
  });

  it('counts AgentSessions beyond live children and the verified slot', () => {
    expect(computeRetainedDeletedChildren({ ...base, agentSessionCount: 6, liveChildrenAtSnapshot: 0, verifiedKnownSlotInstances: 1 }).retainedDeletedChildren).toBe(5);
  });

  it('never goes negative', () => {
    expect(computeRetainedDeletedChildren({ ...base, agentSessionCount: 2, liveChildrenAtSnapshot: 5, verifiedKnownSlotInstances: 0 }).retainedDeletedChildren).toBe(0);
  });

  it('refuses the verdict when the analysed snapshot is not the recorded end snapshot (correction 03 item 4)', () => {
    const verdict = computeRetainedDeletedChildren({ ...base, analysisIsEndSnapshot: false, agentSessionCount: 3, liveChildrenAtSnapshot: 0, verifiedKnownSlotInstances: 1 });
    expect(verdict.retainedDeletedChildren).toBeUndefined();
    expect(verdict.notComputedReason).toMatch(/not the recorded end snapshot/);
  });

  it('refuses the verdict when the drain was incomplete or creates were pending (correction 03 items 1/2)', () => {
    const incomplete = computeRetainedDeletedChildren({ ...base, drainDrained: false, agentSessionCount: 3, liveChildrenAtSnapshot: 2, verifiedKnownSlotInstances: 0 });
    expect(incomplete.retainedDeletedChildren).toBeUndefined();
    expect(incomplete.notComputedReason).toMatch(/drain was incomplete/);
    const pending = computeRetainedDeletedChildren({ ...base, agentSessionCount: 3, liveChildrenAtSnapshot: 0, pendingCreatesAtSnapshot: 1, verifiedKnownSlotInstances: 0 });
    expect(pending.retainedDeletedChildren).toBeUndefined();
    expect(pending.notComputedReason).toMatch(/pending creates/);
  });

  it('subtracts untracked server-side orphans from retained, so a live undeleted orphan is never called retained (correction 04)', () => {
    // Run 4's case: AgentSession=2, verified known slot=1, and the second
    // instance is an untracked orphan still registered on the server.
    const withOrphan = computeRetainedDeletedChildren({ ...base, agentSessionCount: 2, liveChildrenAtSnapshot: 0, untrackedServerSessions: 1, verifiedKnownSlotInstances: 1 });
    expect(withOrphan.liveOnServerAtSnapshot).toBe(1);
    expect(withOrphan.retainedDeletedChildren).toBe(0);
    // Without the orphan figure the same snapshot looks like retention — which
    // is exactly why the reconciliation and this input exist.
    expect(computeRetainedDeletedChildren({ ...base, agentSessionCount: 2, liveChildrenAtSnapshot: 0, verifiedKnownSlotInstances: 1 }).retainedDeletedChildren).toBe(1);
  });

  it('still reports genuine retention when the snapshot outnumbers live-on-server and the verified slot', () => {
    const verdict = computeRetainedDeletedChildren({ ...base, agentSessionCount: 4, liveChildrenAtSnapshot: 0, untrackedServerSessions: 1, verifiedKnownSlotInstances: 1 });
    expect(verdict.liveOnServerAtSnapshot).toBe(1);
    expect(verdict.retainedDeletedChildren).toBe(2);
  });
});

describe('renderRetentionVerdict', () => {
  const base = { analysisIsEndSnapshot: true, drainDrained: true, verifiedKnownSlotInstances: 1 } as const;

  it('prints the snapshot AgentSession count next to the live count and the verdict', () => {
    const text = renderRetentionVerdict({ ...base, agentSessionCount: 1, liveChildrenAtSnapshot: 0 }).join('\n');
    expect(text).toMatch(/AgentSession instances in the end snapshot: 1/);
    expect(text).toMatch(/Live children at the moment of the snapshot[^:]*: 0/);
    expect(text).toMatch(/Retained deleted children: 0/);
  });

  it('prints the three figures: live on the server (harness-known + untracked), verified slot, retained deleted (correction 04)', () => {
    const text = renderRetentionVerdict({
      ...base,
      agentSessionCount: 2,
      liveChildrenAtSnapshot: 0,
      untrackedServerSessions: 1,
      serverChildrenSessionCount: 1,
      verifiedKnownSlotInstances: 1,
    }).join('\n');
    expect(text).toMatch(/Live on the server \(harness-known live \+ untracked\): 1/);
    expect(text).toMatch(/Sessions still registered on the server under this run's children cwd: 1/);
    expect(text).toMatch(/Retained deleted children: 0/);
  });

  it('flags retention when an extra AgentSession is not the verified known slot', () => {
    expect(renderRetentionVerdict({ ...base, agentSessionCount: 6, liveChildrenAtSnapshot: 0 }).join('\n')).toMatch(/Retained deleted children: 5/);
  });

  it('says no verdict is possible when the analysed snapshot is not the recorded end snapshot', () => {
    const text = renderRetentionVerdict({
      ...base,
      analysisIsEndSnapshot: false,
      analysedSnapshotName: 'snapshot-600000ms.heapsnapshot',
      expectedEndSnapshotName: 'snapshot-1200000ms.heapsnapshot',
      agentSessionCount: 3,
      liveChildrenAtSnapshot: 0,
    }).join('\n');
    expect(text).toMatch(/not the recorded end snapshot/);
    expect(text).toMatch(/snapshot-600000ms\.heapsnapshot/);
    expect(text).toMatch(/snapshot-1200000ms\.heapsnapshot/);
    expect(text).not.toMatch(/Retained deleted children: \d/);
  });

  it('says the verdict was not computed for a pre-correction run without a live count', () => {
    const text = renderRetentionVerdict({ analysisIsEndSnapshot: true, agentSessionCount: 3, liveChildrenAtSnapshot: undefined, verifiedKnownSlotInstances: 0 }).join('\n');
    expect(text).toMatch(/not computed/i);
  });
});

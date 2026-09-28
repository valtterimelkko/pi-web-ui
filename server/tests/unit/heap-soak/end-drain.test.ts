import { describe, expect, it } from 'vitest';
import {
  KNOWN_BOUNDED_RETAINED_SLOTS,
  computeRetainedDeletedChildren,
  endDrainTimeoutMs,
  evaluateDrain,
  renderRetentionVerdict,
} from '../../../src/live-validation/heap-soak/end-drain.js';
import { MICRO_SCHEDULE, fullScheduleForHours } from '../../../src/live-validation/heap-soak/phases.js';

describe('evaluateDrain (B0.1 correction)', () => {
  it('is drained only when nothing is in flight and every created child has a terminal delete', () => {
    expect(evaluateDrain({ inFlight: new Set(), openSessionIds: [] })).toMatchObject({ drained: true, inFlightCount: 0, openCount: 0, liveChildren: [] });
  });

  it('is not drained while a child is still in flight', () => {
    const status = evaluateDrain({ inFlight: new Set(['a']), openSessionIds: ['a'] });
    expect(status.drained).toBe(false);
    expect(status.inFlightCount).toBe(1);
    expect(status.openCount).toBe(1);
    expect(status.liveChildren).toEqual(['a']);
  });

  it('is not drained while a created child still lacks a child_deleted/orphan_swept event', () => {
    // The driver removes a session from inFlight BEFORE its delete is logged,
    // so a session can be untracked but still open for a moment.
    const status = evaluateDrain({ inFlight: new Set(), openSessionIds: ['b'] });
    expect(status.drained).toBe(false);
    expect(status.liveChildren).toEqual(['b']);
  });

  it('unions in-flight and open children without duplicating', () => {
    const status = evaluateDrain({ inFlight: new Set(['a', 'b']), openSessionIds: ['a', 'b', 'c'] });
    expect(status.liveChildren).toEqual(['a', 'b', 'c']);
  });
});

describe('endDrainTimeoutMs (B0.1 correction)', () => {
  it('allows at least one wave and at least two minutes to drain', () => {
    expect(endDrainTimeoutMs(MICRO_SCHEDULE)).toBe(120_000);
    expect(endDrainTimeoutMs(fullScheduleForHours(1))).toBe(600_000);
  });
});

describe('computeRetainedDeletedChildren (B0.1 correction)', () => {
  it('reports zero when the snapshot holds exactly the live children', () => {
    expect(computeRetainedDeletedChildren({ agentSessionCount: 5, liveChildrenAtSnapshot: 5 }).retainedDeletedChildren).toBe(0);
  });

  it('reports zero when the only extra AgentSession is the known bounded extension slot', () => {
    const result = computeRetainedDeletedChildren({ agentSessionCount: 1, liveChildrenAtSnapshot: 0 });
    expect(result.knownBoundedSlots).toBe(1);
    expect(result.retainedDeletedChildren).toBe(0);
  });

  it('counts AgentSessions beyond live children and the known slot as retained deleted children', () => {
    const result = computeRetainedDeletedChildren({ agentSessionCount: 6, liveChildrenAtSnapshot: 0 });
    expect(result.retainedDeletedChildren).toBe(5);
  });

  it('never goes negative when there are more live children than AgentSessions', () => {
    expect(computeRetainedDeletedChildren({ agentSessionCount: 2, liveChildrenAtSnapshot: 5 }).retainedDeletedChildren).toBe(0);
  });

  it('names the known bounded slot rather than hiding it', () => {
    expect(KNOWN_BOUNDED_RETAINED_SLOTS.length).toBeGreaterThan(0);
    expect(KNOWN_BOUNDED_RETAINED_SLOTS.map((s) => s.name).join(' ')).toMatch(/backgroundStatusCtx/);
  });
});

describe('renderRetentionVerdict (B0.1 correction)', () => {
  it('prints the snapshot AgentSession count next to the recorded live count and the verdict', () => {
    const lines = renderRetentionVerdict({ agentSessionCount: 5, liveChildrenAtSnapshot: 5 });
    const text = lines.join('\n');
    expect(text).toMatch(/AgentSession instances in the end snapshot: 5/);
    expect(text).toMatch(/Live children at the moment of the snapshot[^:]*: 5/);
    expect(text).toMatch(/Retained deleted children: 0/);
  });

  it('flags retention when the snapshot outnumbers the live children beyond the known slot', () => {
    const lines = renderRetentionVerdict({ agentSessionCount: 6, liveChildrenAtSnapshot: 0 });
    expect(lines.join('\n')).toMatch(/Retained deleted children: 5/);
  });

  it('says the verdict was not computed when the live count was not recorded', () => {
    const text = renderRetentionVerdict({ agentSessionCount: 3, liveChildrenAtSnapshot: undefined }).join('\n');
    expect(text).toMatch(/not computed/i);
  });
});

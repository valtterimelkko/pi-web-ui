import { describe, expect, it } from 'vitest';
import {
  classifyChildFailure,
  classifyDeleteError,
  computeOpenSessionIds,
  partitionSweepCandidates,
  sweptChildFailures,
} from '../../../src/live-validation/heap-soak/orphans.js';
import type { LaneEvent } from '../../../src/live-validation/heap-soak/types.js';

function ev(kind: LaneEvent['kind'], sessionId?: string, detail?: string): LaneEvent {
  return { ts: '', elapsedMs: 0, lane: 'A', kind, sessionId, detail };
}

describe('partitionSweepCandidates (B0.1 defect 4)', () => {
  it('sweeps only open sessions no in-flight driver cycle still tracks', () => {
    const { sweepable, skippedInFlight } = partitionSweepCandidates(['s1', 's2', 's3'], new Set(['s2']));
    expect(sweepable).toEqual(['s1', 's3']);
    expect(skippedInFlight).toEqual(['s2']);
  });

  it('skips every candidate when the whole wave is still in flight (no sweep at all)', () => {
    expect(partitionSweepCandidates(['s1'], new Set(['s1'])).sweepable).toEqual([]);
  });

  it('preserves input order and is a no-op with no in-flight children', () => {
    expect(partitionSweepCandidates(['b', 'a'], new Set()).sweepable).toEqual(['b', 'a']);
  });
});

describe('classifyChildFailure (B0.1 defect 4)', () => {
  it('counts a failure for a session the harness itself swept as orphan_swept, not child_failed', () => {
    expect(classifyChildFailure({ sessionId: 's1', sweptByHarness: true })).toBe('orphan_swept');
  });

  it('counts a genuine child failure as child_failed', () => {
    expect(classifyChildFailure({ sessionId: 's1', sweptByHarness: false })).toBe('child_failed');
  });

  it('treats a failure with no session id as a genuine child failure', () => {
    expect(classifyChildFailure({ sweptByHarness: false })).toBe('child_failed');
  });
});

describe('sweptChildFailures', () => {
  it('reports zero when every swept session was accounted as orphan_swept (the fixed harness)', () => {
    const events = [
      ev('child_created', 's1'), ev('child_tool_call_seen', 's1'),
      ev('orphan_swept', 's1', 'harness sweep removed this child before it finished'),
      ev('child_created', 's2'), ev('child_deleted', 's2'),
    ];
    expect(sweptChildFailures(events)).toEqual([]);
  });

  it('flags the confirmation-soak pattern: a child_failed for a session the sweep deleted', () => {
    const events = [
      ev('child_created', 's1'), ev('child_tool_call_seen', 's1'),
      ev('orphan_swept', 's1', 'deleted'),
      ev('child_failed', 's1', 'SESSION_NOT_FOUND'),
    ];
    expect(sweptChildFailures(events)).toEqual(['s1']);
  });

  it('does not flag a genuine failure of a session that was never swept', () => {
    const events = [ev('child_created', 's1'), ev('child_failed', 's1', 'model error')];
    expect(sweptChildFailures(events)).toEqual([]);
  });

  it('agrees with computeOpenSessionIds that the sweep only ever reports real orphans', () => {
    const events = [ev('child_created', 's1'), ev('child_created', 's2'), ev('child_deleted', 's2')];
    const open = computeOpenSessionIds(events);
    expect(partitionSweepCandidates(open, new Set(['s2'])).sweepable).toEqual(['s1']);
  });
});

describe('classifyDeleteError (correction 03 item 2)', () => {
  it('terminalises only a confirmed not-found (404 / SESSION_NOT_FOUND)', () => {
    expect(classifyDeleteError({ statusCode: 404, code: 'SESSION_NOT_FOUND', message: 'Session not found' })).toBe('already-gone');
    expect(classifyDeleteError({ statusCode: 404, message: 'not found' })).toBe('already-gone');
  });

  it('treats a request timeout as transient, so the session stays open', () => {
    expect(classifyDeleteError(new Error('Internal API DELETE /api/v1/sessions/x timed out after 30000ms'))).toBe('transient');
  });

  it('treats a 5xx as transient', () => {
    expect(classifyDeleteError({ statusCode: 503, message: 'Service Unavailable' })).toBe('transient');
    expect(classifyDeleteError({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'boom' })).toBe('transient');
  });

  it('treats any unknown error shape as transient (never silently terminalises)', () => {
    expect(classifyDeleteError(undefined)).toBe('transient');
    expect(classifyDeleteError('ECONNRESET')).toBe('transient');
    expect(classifyDeleteError({})).toBe('transient');
  });
});

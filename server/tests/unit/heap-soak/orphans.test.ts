import { describe, expect, it } from 'vitest';
import { computeOpenSessionIds } from '../../../src/live-validation/heap-soak/orphans.js';
import type { LaneEvent } from '../../../src/live-validation/heap-soak/types.js';

function ev(kind: LaneEvent['kind'], sessionId?: string): LaneEvent {
  return { ts: '', elapsedMs: 0, lane: 'A', kind, sessionId };
}

describe('computeOpenSessionIds', () => {
  it('returns nothing when every created session was later deleted', () => {
    const events = [ev('child_created', 's1'), ev('child_deleted', 's1'), ev('child_created', 's2'), ev('child_deleted', 's2')];
    expect(computeOpenSessionIds(events)).toEqual([]);
  });

  it('flags a session created but never deleted (the leaked-child scenario)', () => {
    const events = [ev('child_created', 's1'), ev('child_created', 's2'), ev('child_deleted', 's1')];
    expect(computeOpenSessionIds(events)).toEqual(['s2']);
  });

  it('ignores events without a sessionId and ignores unrelated kinds', () => {
    const events = [ev('checkpoint'), ev('child_created', 's1'), ev('circuit_open', 's1')];
    expect(computeOpenSessionIds(events)).toEqual(['s1']);
  });

  it('preserves creation order for determinism', () => {
    const events = [ev('child_created', 'b'), ev('child_created', 'a'), ev('child_created', 'c'), ev('child_deleted', 'a')];
    expect(computeOpenSessionIds(events)).toEqual(['b', 'c']);
  });
});

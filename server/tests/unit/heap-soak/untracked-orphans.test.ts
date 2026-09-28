import { describe, expect, it } from 'vitest';
import {
  findUntrackedChildrenSessions,
  isUnderChildWorkspace,
  trackedSessionIds,
  type ServerSessionRef,
} from '../../../src/live-validation/heap-soak/orphans.js';
import type { LaneEvent } from '../../../src/live-validation/heap-soak/types.js';

const RUN = '/root/.pi-web-ui/validation/heap-soak/micro-1';
const CHILDREN = `${RUN}/children`;
const NOW = Date.parse('2026-09-28T22:45:00.000Z');

function ref(sessionId: string, cwd: string, createdAt?: string): ServerSessionRef {
  return { sessionId, cwd, ...(createdAt !== undefined ? { createdAt } : {}) };
}

describe('trackedSessionIds', () => {
  it('collects every session id that appears anywhere in the events log', () => {
    const events: LaneEvent[] = [
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'child_created', sessionId: 's1' },
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'child_deleted', sessionId: 's1' },
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'orphan_swept', sessionId: 's2' },
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'checkpoint' },
    ];
    expect([...trackedSessionIds(events)].sort()).toEqual(['s1', 's2']);
  });
});

describe('isUnderChildWorkspace', () => {
  it('accepts the children root itself and any directory under it', () => {
    expect(isUnderChildWorkspace(CHILDREN, CHILDREN)).toBe(true);
    expect(isUnderChildWorkspace(`${CHILDREN}/A-5527047e`, CHILDREN)).toBe(true);
  });
  it('rejects a sibling that merely shares the prefix, another run, and undefined', () => {
    expect(isUnderChildWorkspace(`${CHILDREN}-extra/x`, CHILDREN)).toBe(false);
    expect(isUnderChildWorkspace('/root/.pi-web-ui/validation/heap-soak/other/children/A', CHILDREN)).toBe(false);
    expect(isUnderChildWorkspace(undefined, CHILDREN)).toBe(false);
    expect(isUnderChildWorkspace(`${RUN}/synthetic-registry`, CHILDREN)).toBe(false);
  });
  it('tolerates trailing slashes on either side', () => {
    expect(isUnderChildWorkspace(`${CHILDREN}/A/`, `${CHILDREN}/`)).toBe(true);
  });
});

describe('findUntrackedChildrenSessions (correction 04)', () => {
  const tracked = new Set(['s-tracked']);

  it('selects a server session under this run children cwd that the harness never logged', () => {
    const entries = [ref('s-orphan', `${CHILDREN}/A-5527047e`, '2026-09-28T22:43:34.298Z')];
    const selection = findUntrackedChildrenSessions(entries, { childWorkspaceRoot: CHILDREN, tracked, nowMs: NOW, graceMs: 30_000 });
    expect(selection.sweepable).toEqual(['s-orphan']);
  });

  it('never selects a tracked session, a session outside children, or the synthetic registry seed', () => {
    const entries = [
      ref('s-tracked', `${CHILDREN}/A-1`, '2026-09-28T22:40:00.000Z'),
      ref('s-elsewhere', '/root/.pi-web-ui/validation/heap-soak/other/children/A-2', '2026-09-28T22:40:00.000Z'),
      ref('synthetic-00000001', `${RUN}/synthetic-registry`, '2026-09-28T22:00:00.000Z'),
    ];
    const selection = findUntrackedChildrenSessions(entries, { childWorkspaceRoot: CHILDREN, tracked, nowMs: NOW, graceMs: 30_000 });
    expect(selection.sweepable).toEqual([]);
  });

  it('holds back a just-created untracked session inside the grace window', () => {
    const young = ref('s-young', `${CHILDREN}/A-3`, new Date(NOW - 5_000).toISOString());
    const selection = findUntrackedChildrenSessions([young], { childWorkspaceRoot: CHILDREN, tracked, nowMs: NOW, graceMs: 30_000 });
    expect(selection.sweepable).toEqual([]);
    expect(selection.skippedYoung).toEqual(['s-young']);
  });

  it('reconciles the supervisor-restart-during-create sequence: the tracker is lost, the server still lists the session', () => {
    // Gate 1 SIGKILLs the supervisor while its createSession was in flight, so
    // no child_created was ever logged; the restarted supervisor's trackers are
    // empty. The server is the only remaining source of truth.
    const events: LaneEvent[] = [{ ts: '', elapsedMs: 0, lane: 'A', kind: 'checkpoint' }];
    const restartedTracked = trackedSessionIds(events);
    const selection = findUntrackedChildrenSessions(
      [ref('01a0ea30-131a-774f-9f3c-642abb70790e', `${CHILDREN}/A-5527047e`, '2026-09-28T22:43:34.298Z')],
      { childWorkspaceRoot: CHILDREN, tracked: restartedTracked, nowMs: NOW, graceMs: 30_000 },
    );
    expect(selection.sweepable).toEqual(['01a0ea30-131a-774f-9f3c-642abb70790e']);
  });

  it('still selects an untracked session whose creation time is unknown', () => {
    const selection = findUntrackedChildrenSessions([ref('s-no-date', `${CHILDREN}/A-4`)], { childWorkspaceRoot: CHILDREN, tracked, nowMs: NOW, graceMs: 30_000 });
    expect(selection.sweepable).toEqual(['s-no-date']);
  });
});

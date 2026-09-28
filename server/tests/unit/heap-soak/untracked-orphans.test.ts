import { describe, expect, it } from 'vitest';
import {
  findUntrackedChildrenSessions,
  isUnderChildWorkspace,
  parseServerSessionList,
  summarizeServerChildSessions,
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

describe('findUntrackedChildrenSessions (correction 04/05)', () => {
  const tracked = new Set(['s-tracked']);
  const selection = (entries: ServerSessionRef[]) => findUntrackedChildrenSessions(entries, { childWorkspaceRoot: CHILDREN, tracked, nowMs: NOW, graceMs: 30_000 });

  it('selects a server session under this run children cwd that the harness never logged', () => {
    expect(selection([ref('s-orphan', `${CHILDREN}/A-5527047e`, '2026-09-28T22:43:34.298Z')]).sweepable).toEqual(['s-orphan']);
  });

  it('never selects a tracked session, a session outside children, or the synthetic registry seed', () => {
    const entries = [
      ref('s-tracked', `${CHILDREN}/A-1`, '2026-09-28T22:40:00.000Z'),
      ref('s-elsewhere', '/root/.pi-web-ui/validation/heap-soak/other/children/A-2', '2026-09-28T22:40:00.000Z'),
      ref('synthetic-00000001', `${RUN}/synthetic-registry`, '2026-09-28T22:00:00.000Z'),
    ];
    expect(selection(entries).sweepable).toEqual([]);
  });

  it('holds back a just-created untracked session inside the grace window', () => {
    const young = ref('s-young', `${CHILDREN}/A-3`, new Date(NOW - 5_000).toISOString());
    const result = selection([young]);
    expect(result.sweepable).toEqual([]);
    expect(result.skippedYoung).toEqual(['s-young']);
  });

  it('holds back a session with a missing timestamp — unknown age fails closed (correction 05)', () => {
    const result = selection([ref('s-no-date', `${CHILDREN}/A-4`)]);
    expect(result.sweepable).toEqual([]);
    expect(result.skippedUnknownAge).toEqual(['s-no-date']);
  });

  it('holds back a session with a malformed timestamp (correction 05)', () => {
    const result = selection([ref('s-bad-date', `${CHILDREN}/A-5`, 'not-a-date')]);
    expect(result.sweepable).toEqual([]);
    expect(result.skippedUnknownAge).toEqual(['s-bad-date']);
  });

  it('holds back a future-dated session — a clock-skewed timestamp is not proof of age (correction 05)', () => {
    const result = selection([ref('s-future', `${CHILDREN}/A-6`, new Date(NOW + 60_000).toISOString())]);
    expect(result.sweepable).toEqual([]);
    expect(result.skippedUnknownAge).toEqual(['s-future']);
  });

  it('reconciles the supervisor-restart-during-create sequence: the tracker is lost, the server still lists the session', () => {
    // Gate 1 SIGKILLs the supervisor while its createSession was in flight, so
    // no child_created was ever logged; the restarted supervisor's trackers are
    // empty. The server is the only remaining source of truth.
    const events: LaneEvent[] = [{ ts: '', elapsedMs: 0, lane: 'A', kind: 'checkpoint' }];
    const restartedTracked = trackedSessionIds(events);
    const result = findUntrackedChildrenSessions(
      [ref('01a0ea30-131a-774f-9f3c-642abb70790e', `${CHILDREN}/A-5527047e`, '2026-09-28T22:43:34.298Z')],
      { childWorkspaceRoot: CHILDREN, tracked: restartedTracked, nowMs: NOW, graceMs: 30_000 },
    );
    expect(result.sweepable).toEqual(['01a0ea30-131a-774f-9f3c-642abb70790e']);
  });
});

describe('parseServerSessionList (correction 05)', () => {
  it('accepts a well-formed response and keeps optional fields', () => {
    const parsed = parseServerSessionList({ sessions: [{ sessionId: 's1', cwd: `${CHILDREN}/A-1`, createdAt: '2026-09-28T22:00:00.000Z' }] });
    expect(parsed.ok).toBe(true);
    expect(parsed.sessions).toEqual([{ sessionId: 's1', cwd: `${CHILDREN}/A-1`, createdAt: '2026-09-28T22:00:00.000Z' }]);
    expect(parsed.malformed).toBe(0);
  });

  it('refuses a response that is not a list at all, rather than treating it as empty', () => {
    expect(parseServerSessionList(undefined).ok).toBe(false);
    expect(parseServerSessionList({}).ok).toBe(false);
    expect(parseServerSessionList({ sessions: 'nope' }).ok).toBe(false);
    expect(parseServerSessionList({ sessions: 'nope' }).error).toMatch(/shape/i);
  });

  it('drops malformed entries and counts them', () => {
    const parsed = parseServerSessionList({ sessions: [{ sessionId: 's1' }, { cwd: '/x' }, null, { sessionId: 42 }] } as unknown);
    expect(parsed.ok).toBe(true);
    expect(parsed.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(parsed.malformed).toBe(3);
  });
});

describe('summarizeServerChildSessions (correction 05 supervisor seam)', () => {
  it('returns counts when the list is available', () => {
    const counts = summarizeServerChildSessions(
      { ok: true, sessions: [ref('s-orphan', `${CHILDREN}/A-1`, '2026-09-28T22:00:00.000Z'), ref('s-tracked', `${CHILDREN}/A-2`, '2026-09-28T22:00:00.000Z')] },
      CHILDREN,
      new Set(['s-tracked']),
    );
    expect(counts).toMatchObject({ ok: true, serverChildrenSessionCount: 2, untrackedServerSessions: 1 });
  });

  it('returns UNKNOWN counts (not zero) when the list failed', () => {
    const counts = summarizeServerChildSessions({ ok: false, sessions: [], error: 'timed out' }, CHILDREN, new Set());
    expect(counts.ok).toBe(false);
    expect(counts.serverChildrenSessionCount).toBeUndefined();
    expect(counts.untrackedServerSessions).toBeUndefined();
    expect(counts.error).toContain('timed out');
  });
});

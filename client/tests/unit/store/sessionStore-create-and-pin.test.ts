import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';

// The preference delta channel is the durable half of the pin; the defect this
// file pins down is that the durable write never happened at all for a
// just-created session (the store dropped the pin before reaching it).
vi.mock('../../../src/lib/api', () => ({
  getPreferences: vi.fn().mockResolvedValue({}),
  patchPreferences: vi.fn().mockResolvedValue({}),
  archiveSessionPref: vi.fn().mockResolvedValue({}),
  unarchiveSessionPref: vi.fn().mockResolvedValue({}),
  archiveAllSessionsPref: vi.fn().mockResolvedValue({}),
  pinSessionPref: vi.fn().mockResolvedValue({}),
  unpinSessionPref: vi.fn().mockResolvedValue({}),
  setDisplayNamePref: vi.fn().mockResolvedValue({}),
  clearDisplayNamePref: vi.fn().mockResolvedValue({}),
}));

/**
 * Create-then-pin in one go (operator report 2026-09-15).
 *
 * Sequence in the real app, within the first second of creating a session:
 *   1. `session_created`            -> optimistic entry WITH sdkType
 *   2. `session_update` (changeType add, emitted by the SessionWatcher when the
 *      .jsonl appears) with an `info` projection that does NOT carry sdkType
 *   3. the user clicks pin          -> `pin_session` (WS) -> `session_pinned`
 *
 * Step 2 used to replace the session entry wholesale, so `sdkType` was lost;
 * `pinSession` then could not resolve the runtime and fell back to a cap check
 * that compares the TOTAL pinned set against the PER-RUNTIME cap, which
 * silently dropped the pin (and its durable write) for anyone with five or
 * more pins. A browser refresh restored sdkType from `sessions_list`, which is
 * why the workaround was "refresh the browser in between".
 */
describe('sessionStore — create-and-pin in one go', () => {
  beforeEach(async () => {
    const api = await import('../../../src/lib/api');
    for (const fn of Object.values(api)) {
      if (typeof fn === 'function' && 'mockClear' in fn) (fn as ReturnType<typeof vi.fn>).mockClear();
    }
    useSessionStore.setState({
      sessions: [],
      sessionMessages: {},
      sessionCache: new Map(),
      sessionCacheMeta: {},
      pinnedSessionPaths: [],
      archivedSessionPaths: [],
      sessionDisplayNames: {},
      sessionMeta: {},
      isLoadingSessions: false,
      currentSessionId: null,
    });
  });

  /** Exactly what server/src/index.ts broadcasts from the SessionWatcher. */
  const watcherAdd = (id: string, path: string) => ({
    type: 'session_update',
    changeType: 'add',
    sessionId: id,
    path,
    cwd: '/root',
    info: {
      id,
      path,
      cwd: '/root',
      firstMessage: 'New session',
      messageCount: 0,
      createdAt: '2026-09-15T08:00:00.000Z',
      lastActivity: '2026-09-15T08:00:01.000Z',
    },
  });

  it('keeps sdkType when the SessionWatcher session_update lands on a new session', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({
      type: 'session_created',
      sessionId: 'new-1',
      sessionPath: '/sessions/new-1.jsonl',
      sdkType: 'pi',
    });
    expect(useSessionStore.getState().sessions[0].sdkType).toBe('pi');

    state.handleServerMessage(watcherAdd('new-1', '/sessions/new-1.jsonl'));

    const entry = useSessionStore.getState().sessions.find((s) => s.id === 'new-1');
    expect(entry?.sdkType).toBe('pi');
    // The watcher's projection is a partial update; it must not erase fields it
    // does not carry (firstMessage etc. still come through).
    expect(entry?.firstMessage).toBe('New session');
    expect(entry?.path).toBe('/sessions/new-1.jsonl');
  });

  it('pins a session created and pinned in one go even when five other sessions are already pinned', async () => {
    // Five existing human pins (the operator's own set is larger still) whose
    // runtimes are not in the current list — the exact shape that used to make
    // the fallback branch compare a TOTAL count against a PER-RUNTIME cap.
    const existingPins = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`antigravity:a${i}`, { pinned: true as const, legacyKey: `a${i}`, updatedAt: 1 }]),
    );
    useSessionStore.setState({
      sessionMeta: existingPins,
      pinnedSessionPaths: Object.keys(existingPins).map((k) => k.slice('antigravity:'.length)),
    });

    const state = useSessionStore.getState();
    state.handleServerMessage({
      type: 'session_created',
      sessionId: 'new-1',
      sessionPath: '/sessions/new-1.jsonl',
      sdkType: 'pi',
      requestId: 'req-1',
    });
    // The watcher update always lands before a human can click (measured in the
    // browser at well under a second).
    state.handleServerMessage(watcherAdd('new-1', '/sessions/new-1.jsonl'));
    // The user's click -> server confirms.
    state.handleServerMessage({ type: 'session_pinned', sessionPath: '/sessions/new-1.jsonl', pinned: true });

    expect(useSessionStore.getState().pinnedSessionPaths).toContain('/sessions/new-1.jsonl');

    // ... and the pin is durable: a refresh must not lose it.
    const api = await import('../../../src/lib/api');
    const pinSessionPref = api.pinSessionPref as ReturnType<typeof vi.fn>;
    expect(pinSessionPref).toHaveBeenCalledWith('/sessions/new-1.jsonl', expect.any(Number));
  });

  it('preserves client-held fields the watcher projection does not carry', () => {
    // `origin` drives the sidebar's recency window for natively discovered CLI
    // sessions and `model` drives the displayed model; neither is in the
    // watcher's `info` projection, so a wholesale replace erased them.
    useSessionStore.getState().setSessions([{
      id: 'n1', path: '/sessions/n1.jsonl', firstMessage: 'x', messageCount: 0, cwd: '/root',
      sdkType: 'pi', origin: 'native-discovered', model: 'gpt-5.6-sol',
    }]);

    useSessionStore.getState().handleServerMessage(watcherAdd('n1', '/sessions/n1.jsonl'));

    const entry = useSessionStore.getState().sessions[0];
    expect(entry.origin).toBe('native-discovered');
    expect(entry.model).toBe('gpt-5.6-sol');
    expect(entry.messageCount).toBe(0);
  });

  it('removes the session on a changeType unlink update', () => {
    const state = useSessionStore.getState();
    state.handleServerMessage({
      type: 'session_created',
      sessionId: 'new-1',
      sessionPath: '/sessions/new-1.jsonl',
      sdkType: 'pi',
    });
    expect(useSessionStore.getState().sessions).toHaveLength(1);

    state.handleServerMessage({
      type: 'session_update',
      changeType: 'unlink',
      sessionId: 'new-1',
      path: '/sessions/new-1.jsonl',
      info: { id: 'new-1', path: '/sessions/new-1.jsonl', cwd: '/root', firstMessage: 'New session', messageCount: 0 },
    });

    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });
});

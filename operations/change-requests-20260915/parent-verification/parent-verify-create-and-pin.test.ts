import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';

// Conductor-written independent probe (2026-09-15). Written from the operator's
// symptom — "can't create a session and pin it in the same go; clicking the pin
// won't activate the pin; need to refresh the browser in between" — and NOT from
// the dispatched child's test file. It deliberately includes a positive control
// (case C) that reproduces the ORIGINAL defect, so a green run proves the probe
// is sensitive rather than merely agreeing with the fix.

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

/** The operator's real preference shape: seven stale pins, no live session rows. */
const OPERATOR_PIN_COUNT = 7;

const watcherProjection = (id: string, path: string) => ({
  type: 'session_update' as const,
  changeType: 'add' as const,
  sessionId: id,
  path,
  info: {
    id,
    path,
    cwd: '/root/pi-web-ui',
    firstMessage: 'New session',
    messageCount: 0,
    createdAt: '2026-09-15T09:00:00.000Z',
    lastActivity: '2026-09-15T09:00:01.000Z',
    // Note: no sdkType / model / origin — this is the real SessionWatcher shape.
  },
});

async function resetStoreWithStalePins(): Promise<void> {
  const api = await import('../../../src/lib/api');
  for (const fn of Object.values(api)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as ReturnType<typeof vi.fn>).mockClear();
  }
  const pinned = Array.from({ length: OPERATOR_PIN_COUNT }, (_, i) => `/sessions/stale-${i}.jsonl`);
  useSessionStore.setState({
    sessions: [],
    sessionMessages: {},
    sessionCache: new Map(),
    sessionCacheMeta: {},
    sessionMeta: Object.fromEntries(
      pinned.map((p) => [p, { pinned: true as const, legacyKey: p, updatedAt: 1 }]),
    ),
    pinnedSessionPaths: pinned,
    archivedSessionPaths: [],
    sessionDisplayNames: {},
    isLoadingSessions: false,
    currentSessionId: null,
  });
}

describe('CONDUCTOR PROBE — create-and-pin in one go (operator symptom)', () => {
  beforeEach(async () => {
    await resetStoreWithStalePins();
  });

  it('A. the watcher projection must not erase the runtime of a just-created session', () => {
    const { handleServerMessage } = useSessionStore.getState();
    handleServerMessage({
      type: 'session_created',
      sessionId: 'new-A',
      sessionPath: '/sessions/new-A.jsonl',
      sdkType: 'pi',
    } as never);
    handleServerMessage(watcherProjection('new-A', '/sessions/new-A.jsonl') as never);

    const entry = useSessionStore.getState().sessions.find((s) => s.id === 'new-A');
    expect(entry, 'the session row must survive the watcher update').toBeTruthy();
    expect(entry?.sdkType, 'sdkType must survive a partial projection').toBe('pi');
    expect(entry?.firstMessage).toBe('New session');
  });

  it('B. the pin click must activate and persist, with seven stale pins already present', async () => {
    const { handleServerMessage, pinSession, isSessionPinned } = useSessionStore.getState();
    handleServerMessage({
      type: 'session_created',
      sessionId: 'new-B',
      sessionPath: '/sessions/new-B.jsonl',
      sdkType: 'pi',
    } as never);
    handleServerMessage(watcherProjection('new-B', '/sessions/new-B.jsonl') as never);

    // The operator's actual gesture: clicking pin on the freshly created session.
    pinSession('/sessions/new-B.jsonl');

    expect(isSessionPinned('/sessions/new-B.jsonl'), 'the pin must activate on the first click').toBe(true);

    const api = await import('../../../src/lib/api');
    expect(
      api.pinSessionPref as ReturnType<typeof vi.fn>,
      'the pin must reach the durable preference write (survives a refresh)',
    ).toHaveBeenCalledWith('/sessions/new-B.jsonl', expect.any(Number));
  });

  it('C. POSITIVE CONTROL — with the runtime missing, the same click is silently dropped (the original defect)', async () => {
    const { handleServerMessage, pinSession, isSessionPinned } = useSessionStore.getState();
    handleServerMessage({
      type: 'session_created',
      sessionId: 'new-C',
      sessionPath: '/sessions/new-C.jsonl',
      sdkType: 'pi',
    } as never);
    handleServerMessage(watcherProjection('new-C', '/sessions/new-C.jsonl') as never);

    // Simulate the pre-fix state exactly: the entry exists but carries no runtime.
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((s) => (s.id === 'new-C' ? { ...s, sdkType: undefined } : s)),
    }));

    pinSession('/sessions/new-C.jsonl');

    expect(isSessionPinned('/sessions/new-C.jsonl'), 'control: the defect must reproduce when sdkType is absent').toBe(false);
    const api = await import('../../../src/lib/api');
    expect(api.pinSessionPref as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('D. a deleted session must actually be removed (the dead `type` check)', () => {
    const { handleServerMessage, setSessions } = useSessionStore.getState();
    setSessions([
      { id: 'gone', path: '/sessions/gone.jsonl', firstMessage: 'x', messageCount: 0, cwd: '/root', sdkType: 'pi' },
    ] as never);

    handleServerMessage({
      type: 'session_update',
      changeType: 'unlink',
      sessionId: 'gone',
    } as never);

    expect(
      useSessionStore.getState().sessions.map((s) => s.id),
      'an unlinked session must not survive the update',
    ).not.toContain('gone');
  });
});

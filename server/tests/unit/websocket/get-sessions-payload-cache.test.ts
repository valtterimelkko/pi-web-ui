/**
 * H1 Phase B: get_sessions payload cache (approved Option 3, default ON).
 *
 * Phase A measured 70–130 ms of main-thread work per get_sessions call at
 * ~1,966 entries (formatting + registry origin cross-ref + serialisation + GC),
 * on top of the socket write. The cache reuses the serialised sessions_list
 * frame while a cheap change signature (pi list digest + origin digest +
 * per-runtime list signatures) is unchanged, and recomputes the moment anything
 * changes. Correctness is unchanged: every call still answers with a full
 * sessions_list frame.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claudeMock, opencodeMock, antigravityMock, piServiceMock, registryMock, piCacheMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, { get: () => noopRecursive, apply: () => undefined });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
      sendPrompt: vi.fn(), steer: vi.fn(), followUp: vi.fn(), abort: vi.fn(),
      hasSession: vi.fn().mockReturnValue(false), getSessionState: vi.fn(),
      setThinkingLevel: vi.fn(), createSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piServiceMock: noopRecursive,
    registryMock: { upsert: vi.fn(), updateStatus: vi.fn(), get: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue([]), listAll: vi.fn().mockResolvedValue([]) },
    piCacheMock: { list: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: () => piServiceMock,
  assertPiSessionFileIdentity: vi.fn(),
  PiSessionIdentityError: class PiSessionIdentityError extends Error {},
}));
vi.mock('../../../src/pi/session-list-cache.js', () => ({ getPiSessionListCache: () => piCacheMock }));
vi.mock('../../../src/session-registry.js', () => ({
  getSessionRegistry: () => registryMock,
  resolveCanonicalSessionId: vi.fn().mockResolvedValue('canonical'),
}));
vi.mock('../../../src/internal-api/background-children.js', () => ({
  readBackgroundTasksSnapshot: vi.fn().mockResolvedValue([]),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

/** Constructor stub: the real constructor would build a CommandCodeService
 *  whose hasSession() costs ~5 s in tests (spawn/timeout), dominating runtime. */
const commandCodeStub: any = {
  isEnabled: () => false,
  isAvailable: () => false,
  hasSession: vi.fn().mockResolvedValue(false),
  getModels: vi.fn().mockReturnValue([]),
  init: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
};

function piSession(id: string, messageCount = 3) {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: '/tmp/x',
    name: undefined,
    sdkType: 'pi' as const,
    createdAt: new Date(1_000_000_000_000),
    lastActivity: new Date(1_000_000_000_000 + messageCount),
    messageCount,
    firstMessage: 'hello',
  };
}

describe('get_sessions payload cache (Option 3)', () => {
  let mgr: WebSocketConnectionManager;
  let rawSent: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    mgr = new WebSocketConnectionManager(commandCodeStub);
    rawSent = [];
    (mgr as any).sendRawSessionList = (_clientId: string, frame: string) => { rawSent.push(frame); };
    (mgr as any).commandCodeService = { listSessions: vi.fn().mockResolvedValue([]), getModels: vi.fn().mockReturnValue([]) };
  });

  it('answers every call with a full sessions_list frame', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a'), piSession('b')]);
    registryMock.listAll.mockResolvedValue([]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    expect(rawSent.length).toBe(2);
    for (const frame of rawSent) {
      const parsed = JSON.parse(frame);
      expect(parsed.type).toBe('sessions_list');
      expect(parsed.sessions.length).toBe(2);
    }
  });

  it('reuses the serialised frame (same string identity) while nothing changed', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a'), piSession('b')]);
    registryMock.listAll.mockResolvedValue([{ id: 'a', path: '/sessions/a.jsonl', origin: 'internal-api' }]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    expect(rawSent.length).toBe(3);
    expect(rawSent[1]).toBe(rawSent[0]);
    expect(rawSent[2]).toBe(rawSent[0]);
    expect((mgr as any).getSessionsListCacheStats?.()).toMatchObject({ hits: 2, misses: 1 });
  });

  it('invalidates when a Pi session changes (messageCount/lastActivity)', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a', 3)]);
    registryMock.listAll.mockResolvedValue([]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    piCacheMock.list.mockResolvedValue([piSession('a', 7)]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    expect(rawSent[1]).not.toBe(rawSent[0]);
    expect(JSON.parse(rawSent[1]).sessions[0].messageCount).toBe(7);
  });

  it('invalidates when a session is added or removed', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a')]);
    registryMock.listAll.mockResolvedValue([]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    piCacheMock.list.mockResolvedValue([piSession('a'), piSession('b')]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    expect(JSON.parse(rawSent[1]).sessions.length).toBe(2);
  });

  it('invalidates when a registry origin changes', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a')]);
    registryMock.listAll.mockResolvedValue([{ id: 'a', path: '/sessions/a.jsonl', origin: 'internal-api' }]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    expect(JSON.parse(rawSent[0]).sessions[0].origin).toBe('internal-api');
    registryMock.listAll.mockResolvedValue([{ id: 'a', path: '/sessions/a.jsonl', origin: 'browser' }]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    expect(JSON.parse(rawSent[1]).sessions[0].origin).toBe('browser');
  });

  it('invalidates when another runtime\'s list changes', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a')]);
    registryMock.listAll.mockResolvedValue([]);
    claudeMock.listSessions.mockResolvedValue([]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    claudeMock.listSessions.mockResolvedValue([{ id: 'cl1', firstMessage: 'x', messageCount: 1, cwd: '/tmp', createdAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-01T00:00:00Z' }]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    const parsed = JSON.parse(rawSent[1]);
    expect(parsed.sessions.some((s: { id: string }) => s.id === 'cl1')).toBe(true);
  });

  it('carries origin by path and by id as today', async () => {
    piCacheMock.list.mockResolvedValue([piSession('a'), piSession('b')]);
    registryMock.listAll.mockResolvedValue([
      { id: 'a', path: '/sessions/a.jsonl', origin: 'internal-api' },
      { id: 'b', origin: 'native-discovered' },
    ]);
    await (mgr as any).handleGetSessions('c1', { type: 'get_sessions' });
    const parsed = JSON.parse(rawSent[0]);
    const byPath = parsed.sessions.find((s: { id: string }) => s.id === 'a');
    const byId = parsed.sessions.find((s: { id: string }) => s.id === 'b');
    expect(byPath.origin).toBe('internal-api');
    expect(byId.origin).toBe('native-discovered');
  });
});

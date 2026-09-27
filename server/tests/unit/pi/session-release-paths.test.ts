import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiService } from '../../../src/pi/pi-service.js';
import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';
import { SessionPool } from '../../../src/pi/session-pool.js';

/**
 * B1 heap retainers (A1 soak `full-1790411484255-ec8b813c`, §3).
 *
 * Retainer 1: `PiService.sessions` kept every Pi `AgentSession` alive forever.
 * `MultiSessionManager.disposeSession` (Internal API DELETE, aggressive cleanup,
 * stale-stream reset) and `unloadSession` (idle cleanup, eviction) called
 * `piService.removeEventHandler` but never `piService.releaseSessionRefs`; only
 * `stopSession` did. Commit `91effe69` claimed the fix covered every dispose
 * path but wired one, and its wiring test covered only `stopSession`.
 *
 * These tests drive the REAL `PiService` ownership maps (`sessions`,
 * `clientSessionMap`, `eventHandlers`, `clientWebUIContexts`) through every
 * dispose/unload path with fake `AgentSession` objects, and assert that after
 * teardown: `getSession(sessionId)` is undefined and none of the client/handler
 * maps retains an entry for the handler key.
 *
 * Fake sessions are the only fake: the manager, the pool and PiService's release
 * code are the production ones, and `PiService.sessions` is the real map the
 * soak snapshots showed growing without bound.
 */

interface FakeAgentSession {
  sessionId: string;
  sessionFile?: string;
  sessionPath?: string;
  dispose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
}

interface PiServiceInternals {
  sessions: Map<string, unknown>;
  clientSessionMap: Map<string, string>;
  eventHandlers: Map<string, unknown>;
  clientWebUIContexts: Map<string, unknown>;
}

function internals(service: PiService): PiServiceInternals {
  return service as unknown as PiServiceInternals;
}

let sessionCounter = 0;

function fakeAgentSession(sessionId: string, sessionFile?: string): FakeAgentSession {
  return {
    sessionId,
    sessionFile,
    sessionPath: sessionFile,
    dispose: vi.fn(),
    abort: vi.fn(),
    subscribe: vi.fn(),
    setModel: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
  };
}

/**
 * Stub only the SDK-heavy `createSession` while wiring the REAL ownership maps
 * exactly as `PiService.createSession` does (clientSessionMap at :457,
 * clientWebUIContexts at :476, sessions at :522). Returns the sessions created.
 */
function installFakeCreateSession(service: PiService): FakeAgentSession[] {
  const created: FakeAgentSession[] = [];
  vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
    sessionCounter += 1;
    const sessionId = `sid-${sessionCounter}`;
    const sessionFile =
      options.sessionPath ?? (options.inMemory ? undefined : `/tmp/pi-sessions/${sessionId}.jsonl`);
    const session = fakeAgentSession(sessionId, sessionFile);
    internals(service).clientSessionMap.set(options.clientId, sessionId);
    if (options.webUIContext) {
      internals(service).clientWebUIContexts.set(options.clientId, options.webUIContext);
    }
    internals(service).sessions.set(sessionId, session);
    created.push(session);
    return session as never;
  });
  return created;
}

function expectFullyReleased(service: PiService, sessionId: string, handlerKey: string): void {
  expect(service.getSession(sessionId)).toBeUndefined();
  expect(internals(service).sessions.has(sessionId)).toBe(false);
  expect(internals(service).eventHandlers.has(handlerKey)).toBe(false);
  expect(internals(service).clientSessionMap.has(handlerKey)).toBe(false);
  expect(internals(service).clientWebUIContexts.has(handlerKey)).toBe(false);
}

/**
 * Replacement paths (SessionPool create/switch) reuse the client id as the
 * handler key for the NEW session, so the maps legitimately hold that key —
 * what must be gone is any reference to the DISPOSED session id.
 */
function expectNoReferenceTo(service: PiService, sessionId: string, handlerKey: string): void {
  expect(service.getSession(sessionId)).toBeUndefined();
  expect(internals(service).sessions.has(sessionId)).toBe(false);
  expect(internals(service).clientSessionMap.get(handlerKey)).not.toBe(sessionId);
}

/** The only handler key `createAndSubscribe` claims is the temp client id. */
function soleHandlerKey(service: PiService): string {
  const keys = [...internals(service).clientSessionMap.keys()];
  expect(keys).toHaveLength(1);
  return keys[0];
}

const services: PiService[] = [];
const managers: MultiSessionManager[] = [];
const pools: SessionPool[] = [];

function newService(): PiService {
  const service = new PiService();
  services.push(service);
  return service;
}

function newManager(service: PiService, options: Record<string, unknown> = {}): MultiSessionManager {
  const manager = new MultiSessionManager(service, vi.fn(), {
    enableMemoryMonitoring: false,
    cleanupIntervalMs: 3_600_000,
    ...options,
  } as never);
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const pool of pools.splice(0)) {
    for (const clientId of pool.getActiveClients()) pool.removeClient(clientId);
  }
  for (const service of services.splice(0)) service.cleanup();
  vi.restoreAllMocks();
});

describe('PiService session release — every dispose/unload path', () => {
  it('disposeLoadedSession (Internal API DELETE) releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];
    const handlerKey = soleHandlerKey(service);

    expect(manager.disposeLoadedSession(status.sessionPath)).toBe(true);

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
    expectFullyReleased(service, session.sessionId, handlerKey);
  });

  it('idle unload (cleanupIdleSessions) releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { idleSessionTimeoutMs: 1 });
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];
    const handlerKey = soleHandlerKey(service);

    // Simulate an idle session that has exceeded its timeout.
    const active = (manager as unknown as { sessions: Map<string, { lastActivity: Date }> }).sessions.get(
      status.sessionPath,
    )!;
    active.lastActivity = new Date(Date.now() - 60_000);
    manager.unsubscribeClient('client-1', status.sessionPath);

    expect(manager.cleanupIdleSessions()).toBeGreaterThanOrEqual(1);

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(status.sessionPath)).toBe(false);
    expectFullyReleased(service, session.sessionId, handlerKey);
  });

  it('eviction to enforce maxSessions releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service, { maxSessions: 1 });
    const first = await manager.createAndSubscribe('client-1', '/work');
    const firstSession = created[0];
    const firstHandlerKey = soleHandlerKey(service);
    manager.unsubscribeClient('client-1', first.sessionPath);

    // Rehydrating a second client at capacity evicts the oldest idle session.
    await manager.subscribeClient('client-2', '/work/second.jsonl');

    expect(firstSession.dispose).toHaveBeenCalledTimes(1);
    expect(manager.hasSession(first.sessionPath)).toBe(false);
    expectFullyReleased(service, firstSession.sessionId, firstHandlerKey);
  });

  it('stopSession releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const session = created[0];
    const handlerKey = soleHandlerKey(service);

    expect(manager.stopSession(status.sessionPath)).toBe(true);

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expectFullyReleased(service, session.sessionId, handlerKey);
  });

  it('a failed create (no session file) releases the references it claimed', async () => {
    const service = newService();
    const manager = newManager(service);
    let handlerKey = '';
    // Force the "Failed to create session file" branch after createSession claimed refs.
    vi.spyOn(service, 'createSession').mockImplementation(async (options) => {
      handlerKey = options.clientId;
      const session = fakeAgentSession('sid-no-file', undefined);
      internals(service).clientSessionMap.set(options.clientId, 'sid-no-file');
      internals(service).eventHandlers.set(options.clientId, () => {});
      internals(service).sessions.set('sid-no-file', session);
      return session as never;
    });

    await expect(manager.createAndSubscribe('client-1', '/work')).rejects.toThrow(/Failed to create session file/);

    expect(handlerKey).not.toBe('');
    expectFullyReleased(service, 'sid-no-file', handlerKey);
  });

  it('manager.dispose() (server shutdown) releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const manager = newManager(service);
    const first = await manager.createAndSubscribe('client-1', '/work');
    const second = await manager.createAndSubscribe('client-2', '/work');
    const handlerKeys = [...internals(service).clientSessionMap.keys()];
    expect(handlerKeys).toHaveLength(2);

    manager.dispose();

    expect(created[0].dispose).toHaveBeenCalledTimes(1);
    expect(created[1].dispose).toHaveBeenCalledTimes(1);
    expect(internals(service).sessions.size).toBe(0);
    for (const key of handlerKeys) {
      expect(internals(service).eventHandlers.has(key)).toBe(false);
      expect(internals(service).clientSessionMap.has(key)).toBe(false);
      expect(internals(service).clientWebUIContexts.has(key)).toBe(false);
    }
    expect(manager.hasSession(first.sessionPath)).toBe(false);
    expect(manager.hasSession(second.sessionPath)).toBe(false);
  });

  it('PiService.removeClient releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    await service.createSession({ clientId: 'client-1' } as never);
    const session = created[0];

    service.removeClient('client-1');

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expectFullyReleased(service, session.sessionId, 'client-1');
  });

  it('SessionPool.removeClient disposes and releases every PiService-owned reference', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = new SessionPool(service);
    pools.push(pool);
    pool.setWebUIContextProvider((clientId) => ({ clientId, sendToClient: () => {} }));

    const client = await pool.createClientSession('client-1', { cwd: '/work' });

    pool.removeClient('client-1');

    expect(created[0].dispose).toHaveBeenCalledTimes(1);
    expect(pool.getClientSession('client-1')).toBeUndefined();
    expectFullyReleased(service, client.sessionId, 'client-1');
  });

  it('a disposed AgentSession becomes collectable (run with NODE_OPTIONS=--expose-gc)', async (ctx) => {
    if (typeof global.gc !== 'function') {
      ctx.skip('run with NODE_OPTIONS=--expose-gc to assert collectability');
      return;
    }
    // Deliberately plain stubs (no vi.fn/mock history) so the only references
    // to the session are the production ones under test.
    const service = new PiService();
    services.push(service);
    let counter = 0;
    (service as unknown as { createSession: (options: { clientId: string; sessionPath?: string }) => Promise<unknown> }).createSession =
      async (options) => {
        counter += 1;
        const sessionId = `gc-sid-${counter}`;
        const session = {
          sessionId,
          sessionFile: `/tmp/pi-sessions/${sessionId}.jsonl`,
          sessionPath: `/tmp/pi-sessions/${sessionId}.jsonl`,
          dispose() {},
          abort() {},
          subscribe() {},
          setModel() {},
          getContextUsage() {},
        };
        internals(service).clientSessionMap.set(options.clientId, sessionId);
        internals(service).eventHandlers.set(options.clientId, () => {});
        internals(service).sessions.set(sessionId, session);
        return session;
      };
    const manager = newManager(service);
    const status = await manager.createAndSubscribe('client-1', '/work');
    const sessionRef = new WeakRef(internals(service).sessions.values().next().value as object);

    manager.disposeLoadedSession(status.sessionPath);

    let collected = false;
    for (let i = 0; i < 10 && !collected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      global.gc!();
      collected = sessionRef.deref() === undefined;
    }
    expect(collected).toBe(true);
  });

  it('SessionPool.createClientSession releases the session it replaces', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = new SessionPool(service);
    pools.push(pool);
    pool.setWebUIContextProvider((clientId) => ({ clientId, sendToClient: () => {} }));

    const first = await pool.createClientSession('client-1', { cwd: '/work' });
    const firstHandlerKey = soleHandlerKey(service);
    const second = await pool.createClientSession('client-1', { cwd: '/work' });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(created[0].dispose).toHaveBeenCalledTimes(1);
    expectNoReferenceTo(service, first.sessionId, firstHandlerKey);
    // The replacement is still owned and reachable.
    expect(service.getSession(second.sessionId)).toBe(second.session);
  });

  it('SessionPool.switchClientSession releases the session it replaces', async () => {
    const service = newService();
    const created = installFakeCreateSession(service);
    const pool = new SessionPool(service);
    pools.push(pool);
    pool.setWebUIContextProvider((clientId) => ({ clientId, sendToClient: () => {} }));

    const first = await pool.createClientSession('client-1', { cwd: '/work' });
    const firstHandlerKey = soleHandlerKey(service);
    const switched = await pool.switchClientSession('client-1', '/work/other.jsonl');

    expect(switched.sessionId).not.toBe(first.sessionId);
    expect(created[0].dispose).toHaveBeenCalledTimes(1);
    expectNoReferenceTo(service, first.sessionId, firstHandlerKey);
    expect(service.getSession(switched.sessionId)).toBe(switched.session);
  });
});

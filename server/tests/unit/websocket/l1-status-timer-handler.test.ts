/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * L1: WebSocket status-timer ownership + disconnected Pi handler cleanup.
 *
 * Drives the REAL WebSocketConnectionManager (service singletons mocked) with
 * fake timers. Proves the status-broadcast interval is owned and cleared on
 * dispose, that re-init does not duplicate it, and that a client's Pi event
 * handler is removed exactly once on disconnect while session state survives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { claudeMock, opencodeMock, antigravityMock, piMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn().mockReturnValue(false), sendPrompt: vi.fn(), abort: vi.fn(), hasSession: vi.fn().mockReturnValue(false), getSessionState: vi.fn(), setThinkingLevel: vi.fn(), createSession: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), validateAuth: vi.fn().mockResolvedValue({ ok: true }), stop: vi.fn().mockResolvedValue(undefined) },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn().mockReturnValue(false), isSessionPinned: vi.fn().mockReturnValue(false), validateSetup: vi.fn().mockResolvedValue({ ok: true }), isPendingPermission: vi.fn().mockReturnValue(false), resolvePermission: vi.fn(), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    piMock: noopRecursive,
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => piMock }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({
  getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

function fakeMulti() {
  return {
    getAllSessionStatuses: vi.fn(() => []),
    getClientSubscriptions: () => [],
    unsubscribeClient: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('L1: status-broadcast timer ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.useRealTimers();
  });

  it('polls while running and stops after close()', async () => {
    const mgr = new WebSocketConnectionManager();
    const multi = fakeMulti();
    (mgr as any).multiSessionManager = multi;
    vi.advanceTimersByTime(1000);
    expect(multi.getAllSessionStatuses).toHaveBeenCalled(); // interval alive
    multi.getAllSessionStatuses.mockClear();

    await mgr.close();
    vi.advanceTimersByTime(5000);
    expect(multi.getAllSessionStatuses).not.toHaveBeenCalled(); // interval cleared
  });

  it('repeated construct/close does not accumulate intervals', async () => {
    const closedMultis = [];
    for (let i = 0; i < 3; i++) {
      const m = new WebSocketConnectionManager();
      const multi = fakeMulti();
      (m as any).multiSessionManager = multi;
      await m.close();
      closedMultis.push(multi);
    }
    // After three construct/close cycles, a fresh manager has exactly one live
    // interval; the closed managers' intervals must not fire.
    const mgr = new WebSocketConnectionManager();
    const liveMulti = fakeMulti();
    (mgr as any).multiSessionManager = liveMulti;
    vi.advanceTimersByTime(1000);
    for (const cm of closedMultis) {
      expect(cm.getAllSessionStatuses).not.toHaveBeenCalled();
    }
    expect(liveMulti.getAllSessionStatuses).toHaveBeenCalled();
    await mgr.close();
  });

  it('re-init after close produces exactly one live interval', async () => {
    const m1 = new WebSocketConnectionManager();
    const multi1 = fakeMulti();
    (m1 as any).multiSessionManager = multi1;
    await m1.close();

    const m2 = new WebSocketConnectionManager();
    const multi2 = fakeMulti();
    (m2 as any).multiSessionManager = multi2;

    vi.advanceTimersByTime(1000);
    expect(multi1.getAllSessionStatuses).not.toHaveBeenCalled(); // m1 cleared
    expect(multi2.getAllSessionStatuses).toHaveBeenCalled(); // only m2 live
    await m2.close();
  });

  it('close() removes Pi handlers for clients before clearing connection state', async () => {
    const mgr = new WebSocketConnectionManager();
    const removeEventHandler = vi.fn();
    (mgr as any).piService = { removeEventHandler };
    (mgr as any).multiSessionManager = fakeMulti();
    (mgr as any).clients.set('c1', { id: 'c1', ws: { readyState: 1, close: vi.fn() }, isAuthenticated: true });
    (mgr as any).clients.set('c2', { id: 'c2', ws: { readyState: 1, close: vi.fn() }, isAuthenticated: true });

    await mgr.close();

    expect(removeEventHandler).toHaveBeenCalledTimes(2);
    expect(removeEventHandler).toHaveBeenCalledWith('c1');
    expect(removeEventHandler).toHaveBeenCalledWith('c2');
  });

  it('close() disposes every runtime service owner', async () => {
    const mgr = new WebSocketConnectionManager();
    (mgr as any).multiSessionManager = fakeMulti();

    await mgr.close();

    expect(claudeMock.stop).toHaveBeenCalledTimes(1);
    expect(opencodeMock.shutdown).toHaveBeenCalledTimes(1);
    expect(antigravityMock.shutdown).toHaveBeenCalledTimes(1);
  });

  it('still closes the WebSocket server and attempts every runtime shutdown when one fails', async () => {
    const mgr = new WebSocketConnectionManager();
    (mgr as any).multiSessionManager = fakeMulti();
    const closeWss = vi.spyOn(mgr.getWss(), 'close').mockImplementation(() => mgr.getWss());
    claudeMock.stop.mockRejectedValueOnce(new Error('claude shutdown failed'));

    await expect(mgr.close()).rejects.toThrow('claude shutdown failed');

    expect(opencodeMock.shutdown).toHaveBeenCalledTimes(1);
    expect(antigravityMock.shutdown).toHaveBeenCalledTimes(1);
    expect(closeWss).toHaveBeenCalledTimes(1);
  });

  it('double close() is harmless', async () => {
    const mgr = new WebSocketConnectionManager();
    (mgr as any).multiSessionManager = fakeMulti();
    await mgr.close();
    await expect(mgr.close()).resolves.toBeUndefined();
  });
});

describe('L1: Pi event handler removed on disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleDisconnect removes the client Pi event handler exactly once', () => {
    const removeEventHandler = vi.fn();
    const unsubscribeClient = vi.fn();
    const getClientSubscriptions = vi.fn(() => []);
    const mgr = new WebSocketConnectionManager();
    // Replace Pi service + multi-session manager with controllable fakes.
    (mgr as any).piService = { removeEventHandler };
    (mgr as any).multiSessionManager = {
      getClientSubscriptions,
      unsubscribeClient,
      getAllSessionStatuses: () => [],
    };
    // Inject a connected client (the connection handler set its Pi handler).
    (mgr as any).clients.set('c1', { id: 'c1', ws: { readyState: 1, close: () => {} }, isAuthenticated: true });

    (mgr as any).handleDisconnect('c1');

    expect(removeEventHandler).toHaveBeenCalledTimes(1);
    expect(removeEventHandler).toHaveBeenCalledWith('c1');
    expect((mgr as any).clients.has('c1')).toBe(false);
  });

  it('double disconnect (close + error) is harmless and removes the handler once', () => {
    const removeEventHandler = vi.fn();
    const mgr = new WebSocketConnectionManager();
    (mgr as any).piService = { removeEventHandler };
    (mgr as any).multiSessionManager = {
      getClientSubscriptions: () => [],
      unsubscribeClient: vi.fn(),
      getAllSessionStatuses: () => [],
    };
    (mgr as any).clients.set('c2', { id: 'c2', ws: { readyState: 1, close: () => {} }, isAuthenticated: true });

    (mgr as any).handleDisconnect('c2');
    (mgr as any).handleDisconnect('c2'); // as ws 'error' after 'close' would

    expect(removeEventHandler).toHaveBeenCalledTimes(1);
  });
});

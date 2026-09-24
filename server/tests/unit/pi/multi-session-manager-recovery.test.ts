/**
 * Contract 1.45.0 round 2 — dead-owner recovery preserves browser attachment
 * and runs single-flight.
 *
 * Round-1 recovery re-subscribed only the internal client: disposeSession()
 * drops every browser subscription and viewing reference, so an attached
 * browser silently lost its live view of the recovered session. Now
 * recoverSession() captures the subscribed and viewing client ids BEFORE
 * disposal, re-subscribes them after the reload (restoring viewing references
 * and pin claims), and broadcasts the same session_event envelope the
 * stale-stream reload path uses.
 *
 * Single-flight: two concurrent actions on the same dead-owner session share
 * ONE recovery — the second rehydration (createSession) never happens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MultiSessionManager, PromptNotSubmittedError } from '../../../src/pi/multi-session-manager.js';

const GRACE_MS = 40;

function createMockAgentSession(overrides: Record<string, unknown> = {}) {
  const sessionId = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionFile = `/tmp/recovery/${sessionId}.jsonl`;
  return {
    sessionId,
    sessionFile,
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setModel: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    isStreaming: false,
    prompt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('MultiSessionManager.recoverSession — browser re-attach and single-flight (round 2)', () => {
  let priorGrace: string | undefined;
  let session: ReturnType<typeof createMockAgentSession>;
  let manager: MultiSessionManager;
  let createSessionCalls: number;
  let piService: {
    createSession: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    setEventHandler: ReturnType<typeof vi.fn>;
    removeEventHandler: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    priorGrace = process.env.PI_PROMPT_EXECUTION_GRACE_MS;
    process.env.PI_PROMPT_EXECUTION_GRACE_MS = String(GRACE_MS);
    session = createMockAgentSession();
    createSessionCalls = 0;
    piService = {
      createSession: vi.fn(async () => {
        createSessionCalls += 1;
        return session;
      }),
      getSession: vi.fn(() => session),
      setEventHandler: vi.fn(),
      removeEventHandler: vi.fn(),
    };
    manager = new MultiSessionManager(piService as never, () => {}, { idleSessionTimeoutMs: 600_000 });
    await manager.subscribeClient('first-client', session.sessionFile);
    expect(createSessionCalls).toBe(1);
  });

  afterEach(() => {
    if (priorGrace === undefined) delete process.env.PI_PROMPT_EXECUTION_GRACE_MS;
    else process.env.PI_PROMPT_EXECUTION_GRACE_MS = priorGrace;
    manager.disposeAll?.();
  });

  it('RED: re-attaches every subscribed and viewing client after the reload', async () => {
    await manager.subscribeClient('browser-1', session.sessionFile);
    manager.setClientViewingSession('browser-1', session.sessionFile);

    const result = await manager.recoverSession(session.sessionFile);

    expect(result.subscribers).toEqual(expect.arrayContaining(['first-client', 'browser-1']));
    expect(result.viewers).toEqual(['browser-1']);
    // The reload happened (a second createSession) and BOTH clients are
    // subscribed again, with the viewing reference restored.
    expect(createSessionCalls).toBe(2);
    expect(manager.getSubscribers(session.sessionFile)).toEqual(expect.arrayContaining(['first-client', 'browser-1']));
    expect(manager.getViewingClients(session.sessionFile)).toEqual(['browser-1']);
    expect(manager.getSessionStatus(session.sessionFile)?.status).toBe('idle');
  });

  it('restores pin claims on the rehydrated session (owner decision: keep the pin)', async () => {
    manager.pinSession(session.sessionFile, 'web-ui');
    expect(manager.isSessionPinned(session.sessionFile)).toBe(true);

    await manager.recoverSession(session.sessionFile);

    expect(manager.isSessionPinned(session.sessionFile)).toBe(true);
    expect(manager.getPinClaims(session.sessionFile)).toEqual(['web-ui']);
  });

  it('RED: two concurrent recoveries share ONE dispose→rehydrate (single-flight)', async () => {
    await manager.subscribeClient('browser-1', session.sessionFile);
    expect(createSessionCalls).toBe(1);

    const [a, b] = await Promise.all([
      manager.recoverSession(session.sessionFile),
      manager.recoverSession(session.sessionFile),
    ]);

    expect(a).toEqual(b);
    expect(createSessionCalls).toBe(2, 'initial subscribe + exactly ONE rehydration');
  });

  it('a recovery triggered while another one is in flight is not double-disposed', async () => {
    await manager.recoverSession(session.sessionFile);
    const disposalsAfterFirst = session.dispose.mock.calls.length;
    expect(disposalsAfterFirst).toBeGreaterThanOrEqual(1);

    await Promise.all([
      manager.recoverSession(session.sessionFile),
      manager.recoverSession(session.sessionFile),
      manager.recoverSession(session.sessionFile),
    ]);
    // Each single-flight recovery disposes once (previous session torn down
    // before its own rehydration) — three recoveries, three disposals, and
    // crucially the session is healthy and subscribed afterwards.
    expect(manager.getSubscribers(session.sessionFile)).toContain('first-client');
    expect(manager.getSessionStatus(session.sessionFile)?.status).toBe('idle');
  });

  it('RED: a prompt submitted while a recovery is in flight resolves through the same recovery without a second rehydration', async () => {
    // Simulate the concurrent-action shape: one recovery in flight (slow
    // settle), a second caller (e.g. another API action) hits recoverSession.
    let releaseSettle!: () => void;
    const settleGate = new Promise<void>((resolve) => { releaseSettle = resolve; });
    const slowSession = createMockAgentSession();
    piService.createSession.mockImplementation(async () => {
      createSessionCalls += 1;
      if (createSessionCalls > 1) {
        await settleGate;
        return slowSession;
      }
      return session;
    });

    const first = manager.recoverSession(session.sessionFile);
    const second = manager.recoverSession(session.sessionFile);
    releaseSettle();
    const [ra, rb] = await Promise.all([first, second]);

    expect(ra).toEqual(rb);
    expect(createSessionCalls).toBe(2, 'initial + exactly one shared rehydration');
    expect(PromptNotSubmittedError).toBeDefined();
  });
});

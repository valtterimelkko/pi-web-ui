import { describe, it, expect, vi, afterEach } from 'vitest';
import { MultiSessionManager } from '../../../src/pi/multi-session-manager.js';

/**
 * B4.1 (contract 1.52.0) — the drain's read-only Pi busy-session accessor.
 *
 * R2 finding: the pre-restart drain counts admission-metered turns and run
 * receipts only, so a Pi turn started by the goal engine, another extension
 * (watch-wake deadline, subagent) or the browser holds nothing the drain can
 * see — a deploy could kill it silently. The busy truth for a resident Pi
 * session is the manager's own status flag (turn accepted, agent_start not yet
 * arrived) plus the SDK's public `AgentSession.isStreaming` state, which also
 * covers post-run continuations the manager status may lag behind.
 *
 * This accessor is READ-ONLY: it must not mutate session state (lane b5 owns
 * the dispose/unload paths).
 */

function makeManager(): MultiSessionManager {
  const piService = {
    createSession: vi.fn(),
    getSession: vi.fn(),
    setEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    releaseSessionRefs: vi.fn(),
  };
  return new MultiSessionManager(piService as never, vi.fn());
}

interface InjectedSession {
  sessionId: string;
  sessionPath: string;
  status: string;
  agentSession: { isStreaming: boolean };
}

function inject(manager: MultiSessionManager, session: InjectedSession): void {
  (manager as unknown as {
    sessions: Map<string, unknown>;
  }).sessions.set(session.sessionPath, {
    sessionPath: session.sessionPath,
    sessionId: session.sessionId,
    agentSession: session.agentSession,
    status: session.status,
    subscribers: new Set<string>(),
    lastActivity: new Date(),
    lastEventTimestamp: Date.now(),
    messageCount: 1,
    currentStep: 1,
    pinned: false,
    pinClaims: new Set<string>(),
    handlerKey: `handler-${session.sessionId}`,
  });
}

describe('MultiSessionManager.listBusySessions (B4.1)', () => {
  let manager: MultiSessionManager | undefined;
  afterEach(() => {
    manager?.stopCleanupTimer();
    manager = undefined;
  });

  it('returns no busy sessions when no session is resident', () => {
    manager = makeManager();
    expect(manager.listBusySessions()).toEqual([]);
  });

  it('counts a busy-status session (turn accepted, streaming not started yet)', () => {
    manager = makeManager();
    inject(manager, { sessionId: 'sid-1', sessionPath: '/s/one.jsonl', status: 'busy', agentSession: { isStreaming: false } });
    expect(manager.listBusySessions()).toEqual([
      { sessionId: 'sid-1', sessionPath: '/s/one.jsonl', busyBecause: ['status'] },
    ]);
  });

  it('counts a streaming-status session', () => {
    manager = makeManager();
    inject(manager, { sessionId: 'sid-2', sessionPath: '/s/two.jsonl', status: 'streaming', agentSession: { isStreaming: false } });
    expect(manager.listBusySessions()).toEqual([
      { sessionId: 'sid-2', sessionPath: '/s/two.jsonl', busyBecause: ['status'] },
    ]);
  });

  it('counts a session the SDK publicly reports as streaming even when the manager status lags (extension-driven continuation)', () => {
    manager = makeManager();
    inject(manager, { sessionId: 'sid-3', sessionPath: '/s/three.jsonl', status: 'idle', agentSession: { isStreaming: true } });
    expect(manager.listBusySessions()).toEqual([
      { sessionId: 'sid-3', sessionPath: '/s/three.jsonl', busyBecause: ['sdk_streaming'] },
    ]);
  });

  it('reports both signals when both see the busy state', () => {
    manager = makeManager();
    inject(manager, { sessionId: 'sid-4', sessionPath: '/s/four.jsonl', status: 'streaming', agentSession: { isStreaming: true } });
    expect(manager.listBusySessions()).toEqual([
      { sessionId: 'sid-4', sessionPath: '/s/four.jsonl', busyBecause: ['status', 'sdk_streaming'] },
    ]);
  });

  it('does not count idle or error sessions the SDK reports idle', () => {
    manager = makeManager();
    inject(manager, { sessionId: 'sid-5', sessionPath: '/s/idle.jsonl', status: 'idle', agentSession: { isStreaming: false } });
    inject(manager, { sessionId: 'sid-6', sessionPath: '/s/err.jsonl', status: 'error', agentSession: { isStreaming: false } });
    expect(manager.listBusySessions()).toEqual([]);
  });

  it('survives a throwing isStreaming getter without counting the session as busy on status alone', () => {
    manager = makeManager();
    inject(manager, {
      sessionId: 'sid-7', sessionPath: '/s/throwing.jsonl', status: 'idle',
      agentSession: { get isStreaming(): boolean { throw new Error('getter exploded'); } },
    } as unknown as InjectedSession);
    expect(manager.listBusySessions()).toEqual([]);
  });

  it('is read-only: listing does not touch status flags or activity', () => {
    manager = makeManager();
    inject(manager, { sessionId: 'sid-8', sessionPath: '/s/ro.jsonl', status: 'busy', agentSession: { isStreaming: true } });
    const before = manager.getSessionStatus('/s/ro.jsonl');
    manager.listBusySessions();
    const after = manager.getSessionStatus('/s/ro.jsonl');
    expect(after).toEqual(before);
    expect(after?.status).toBe('busy');
  });
});

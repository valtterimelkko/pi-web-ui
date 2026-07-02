/**
 * WebSocket routing tests for the Claude SDK AskUserQuestion bridge.
 *
 * Drives the REAL WebSocketConnectionManager (service singletons mocked) so the
 * actual `handleClaudePrompt` normalized-event routing and
 * `handleExtensionUiResponse` dispatch are exercised — not a logic simulation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { claudeMock, opencodeMock, antigravityMock, piMock } = vi.hoisted(() => {
  // A recursive no-op proxy so any PiService method/property the heavy manager
  // constructor touches (setSessionPool, etc.) is satisfied without real Pi init.
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }),
      isRunning: vi.fn().mockReturnValue(false),
      sendPrompt: vi.fn(),
      sendPermissionResponse: vi.fn(),
      isPendingAskUserQuestion: vi.fn().mockReturnValue(false),
      respondToAskUserQuestion: vi.fn().mockReturnValue(true),
      hasPendingAskUserQuestionForSession: vi.fn().mockReturnValue(false),
      cancelPendingAskUserQuestionsForSession: vi.fn(),
      wasRecentlyResolvedAskUserQuestion: vi.fn().mockReturnValue(false),
      startChannel: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      abort: vi.fn(),
      hasSession: vi.fn().mockReturnValue(false),
      getSessionState: vi.fn().mockReturnValue(undefined),
      setThinkingLevel: vi.fn(),
      createSession: vi.fn(),
    },
    opencodeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: true }),
      isPendingPermission: vi.fn().mockReturnValue(false),
      resolvePermission: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
    },
    antigravityMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: true }),
      listSessions: vi.fn().mockResolvedValue([]),
    },
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

const QUESTIONS = [
  {
    question: 'Pick a colour?',
    header: 'Colour',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'r' },
      { label: 'Blue', description: 'b' },
    ],
  },
];

describe('Claude AskUserQuestion WebSocket routing', () => {
  let mgr: WebSocketConnectionManager;
  let sent: Array<{ clientId: string; message: any }>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish default resolved values (clearAllMocks resets implementations).
    claudeMock.isAvailable.mockResolvedValue(true);
    claudeMock.isRunning.mockReturnValue(false);
    claudeMock.isPendingAskUserQuestion.mockReturnValue(false);
    claudeMock.respondToAskUserQuestion.mockReturnValue(true);
    claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(false);
    claudeMock.cancelPendingAskUserQuestionsForSession.mockReset();
    claudeMock.wasRecentlyResolvedAskUserQuestion.mockReturnValue(false);
    opencodeMock.isAvailable.mockResolvedValue(true);
    opencodeMock.isPendingPermission.mockReturnValue(false);
    antigravityMock.isAvailable.mockResolvedValue(true);

    mgr = new WebSocketConnectionManager();

    sent = [];
    // Capture outbound messages instead of writing to a real socket.
    (mgr as any).sendMessage = (clientId: string, message: unknown) => {
      sent.push({ clientId, message });
    };
  });

  afterEach(async () => {
    if (mgr) await (mgr as any).close?.();
  });

  // ── ask_user_question_request → extension_ui_request ────────────────────────

  it('converts an ask_user_question_request into a top-level extension_ui_request', async () => {
    claudeMock.sendPrompt.mockImplementation(async (_sid: string, _prompt: string, onEvent: any, onComplete: any) => {
      onEvent({
        type: 'ask_user_question_request',
        sessionId: 'sess-1',
        timestamp: Date.now(),
        data: { requestId: 'req-xyz', toolCallId: 'toolu_1', toolName: 'AskUserQuestion', questions: QUESTIONS, timeoutMs: 300000 },
      });
      onComplete(undefined);
    });

    await (mgr as any).handleClaudePrompt('client-1', 'sess-1', 'ask me');

    const uiReq = sent.find((s) => s.message?.type === 'extension_ui_request');
    expect(uiReq).toBeDefined();
    expect(uiReq!.clientId).toBe('client-1');
    expect(uiReq!.message.request).toMatchObject({
      id: 'req-xyz',
      type: 'ask_user_question',
      method: 'claude.askUserQuestion',
    });
    expect(uiReq!.message.request.params.questions).toEqual(QUESTIONS);
    expect(uiReq!.message.request.params.toolCallId).toBe('toolu_1');
    expect(uiReq!.message.request.timeout).toBe(300000);
  });

  it('delivers the request to Claude subscribers when present', async () => {
    (mgr as any).claudeSubs.subscribe('sub-1', 'sess-2');

    claudeMock.sendPrompt.mockImplementation(async (_sid: string, _prompt: string, onEvent: any, onComplete: any) => {
      onEvent({
        type: 'ask_user_question_request',
        sessionId: 'sess-2',
        timestamp: Date.now(),
        data: { requestId: 'req-sub', toolCallId: 't', toolName: 'AskUserQuestion', questions: QUESTIONS, timeoutMs: 300000 },
      });
      onComplete(undefined);
    });

    await (mgr as any).handleClaudePrompt('client-1', 'sess-2', 'ask me');

    const uiReq = sent.find((s) => s.message?.type === 'extension_ui_request' && s.clientId === 'sub-1');
    expect(uiReq).toBeDefined();
    expect(uiReq!.message.request.id).toBe('req-sub');
  });

  // ── ask_user_question_closed → extension_ui_cancel ──────────────────────────

  it('converts an ask_user_question_closed event into a top-level extension_ui_cancel broadcast', async () => {
    (mgr as any).claudeSubs.subscribe('sub-1', 'sess-closed');
    (mgr as any).claudeSubs.subscribe('sub-2', 'sess-closed');

    claudeMock.sendPrompt.mockImplementation(async (_sid: string, _prompt: string, onEvent: any, onComplete: any) => {
      onEvent({
        type: 'ask_user_question_closed',
        sessionId: 'sess-closed',
        timestamp: Date.now(),
        data: { requestId: 'req-closed', reason: 'timeout' },
      });
      onComplete(undefined);
    });

    await (mgr as any).handleClaudePrompt('client-1', 'sess-closed', 'ask');

    const cancels = sent.filter((s) => s.message?.type === 'extension_ui_cancel');
    expect(cancels).toHaveLength(2);
    expect(cancels.some((c) => c.clientId === 'sub-1')).toBe(true);
    expect(cancels.some((c) => c.clientId === 'sub-2')).toBe(true);
    expect(cancels[0].message.request).toEqual({ id: 'req-closed', reason: 'timeout' });
    // The closed event must NOT also be forwarded as a session_event — the
    // cancel IS the surface (a session_event carrying agent_end from turn
    // completion is fine and unrelated).
    const closedAsSessionEvent = sent.find((s) => s.message?.type === 'session_event'
      && (s.message as { event?: { type?: string } }).event?.type === 'ask_user_question_closed');
    expect(closedAsSessionEvent).toBeUndefined();
  });

  it('forwards the actual close reason through extension_ui_cancel (disconnected)', async () => {
    (mgr as any).claudeSubs.subscribe('sub-1', 'sess-disc');

    claudeMock.sendPrompt.mockImplementation(async (_sid: string, _prompt: string, onEvent: any, onComplete: any) => {
      onEvent({
        type: 'ask_user_question_closed',
        sessionId: 'sess-disc',
        timestamp: Date.now(),
        data: { requestId: 'req-disc', reason: 'disconnected' },
      });
      onComplete(undefined);
    });

    await (mgr as any).handleClaudePrompt('client-1', 'sess-disc', 'ask');

    const cancel = sent.find((s) => s.message?.type === 'extension_ui_cancel');
    expect(cancel).toBeDefined();
    expect(cancel!.message.request).toEqual({ id: 'req-disc', reason: 'disconnected' });
  });

  // ── extension_ui_response routing ───────────────────────────────────────────

  it('routes a structured answer to claudeService.respondToAskUserQuestion', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(true);
    claudeMock.respondToAskUserQuestion.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'req-1', approved: true, value: { answers: { 'Pick a colour?': 'Blue' } } },
    });

    expect(claudeMock.respondToAskUserQuestion).toHaveBeenCalledWith('req-1', {
      answers: { 'Pick a colour?': 'Blue' },
    });
  });

  it('routes a cancelled answer to respondToAskUserQuestion as cancelled', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'req-2', cancelled: true },
    });

    expect(claudeMock.respondToAskUserQuestion).toHaveBeenCalledWith('req-2', expect.objectContaining({ cancelled: true }));
  });

  // ── Late-answer handling (D3): never silently drop a stale answer ───────────

  it('notifies the client when a late answer arrives for an already-closed AskUserQuestion', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(false);
    claudeMock.wasRecentlyResolvedAskUserQuestion.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'req-late', approved: true, value: { answers: { 'Pick a colour?': 'Blue' } } },
    });

    const notice = sent.find((s) => s.message?.type === 'error' && s.message?.code === 'ASK_ALREADY_CLOSED');
    expect(notice).toBeDefined();
    expect(notice!.clientId).toBe('client-1');
    expect(notice!.message.message).toMatch(/already closed/i);
    // Must not be silently routed to the permission/opencode paths.
    expect(claudeMock.sendPermissionResponse).not.toHaveBeenCalled();
  });

  it('notifies the client when a pending AskUserQuestion is resolved between check and respond (race)', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(true);
    claudeMock.respondToAskUserQuestion.mockReturnValue(false); // resolved mid-flight

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'req-race', approved: true, value: { answers: { 'Pick a colour?': 'Blue' } } },
    });

    expect(sent.find((s) => s.message?.code === 'ASK_ALREADY_CLOSED')).toBeDefined();
  });

  it('does not send a close notice for a response id that was never an AskUserQuestion', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(false);
    claudeMock.wasRecentlyResolvedAskUserQuestion.mockReturnValue(false);

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'req-unknown', approved: true },
    });

    expect(sent.find((s) => s.message?.code === 'ASK_ALREADY_CLOSED')).toBeUndefined();
  });

  it('delivers a valid pending answer and sends no close notice', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(true);
    claudeMock.respondToAskUserQuestion.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'req-valid', approved: true, value: { answers: { 'Pick a colour?': 'Blue' } } },
    });

    expect(claudeMock.respondToAskUserQuestion).toHaveBeenCalledWith('req-valid', { answers: { 'Pick a colour?': 'Blue' } });
    expect(sent.find((s) => s.message?.code === 'ASK_ALREADY_CLOSED')).toBeUndefined();
  });

  // ── Existing paths remain intact ────────────────────────────────────────────

  it('still routes Claude channel permission responses via sendPermissionResponse', async () => {
    (mgr as any).pendingClaudePermissions.set('perm-1', 'sess-perm');

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'perm-1', approved: true },
    });

    expect(claudeMock.sendPermissionResponse).toHaveBeenCalledWith('sess-perm', 'perm-1', true);
    expect(claudeMock.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  it('still routes OpenCode permission responses via resolvePermission', async () => {
    opencodeMock.isPendingPermission.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-1', {
      type: 'extension_ui_response',
      response: { id: 'oc-1', approved: true },
    });

    expect(opencodeMock.resolvePermission).toHaveBeenCalledWith('oc-1', true);
    expect(claudeMock.respondToAskUserQuestion).not.toHaveBeenCalled();
  });

  // ── Disconnect grace timer (B) ──────────────────────────────────────────────

  /** Register a fake client so handleDisconnect's `if (client)` branch runs. */
  function connectClient(clientId: string): void {
    (mgr as any).clients.set(clientId, { ws: { readyState: 1 } });
  }

  it('starts a grace timer (does NOT cancel immediately) when the last subscriber leaves a session with a pending question', async () => {
    vi.useFakeTimers();
    try {
      claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(true);
      connectClient('client-A');
      (mgr as any).claudeSubs.subscribe('client-A', 'sess-grace');

      (mgr as any).handleDisconnect('client-A');

      // Session now has zero subscribers but the question must NOT be cancelled
      // immediately — a brief network blip should not drop the dialog.
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).not.toHaveBeenCalled();

      // Advance to the default grace window (120s).
      await vi.advanceTimersByTimeAsync(120_000);

      expect(claudeMock.cancelPendingAskUserQuestionsForSession).toHaveBeenCalledWith('sess-grace', 'disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cancel when a non-last subscriber leaves (others remain)', async () => {
    vi.useFakeTimers();
    try {
      claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(true);
      connectClient('client-A');
      connectClient('client-B');
      (mgr as any).claudeSubs.subscribe('client-A', 'sess-multi');
      (mgr as any).claudeSubs.subscribe('client-B', 'sess-multi');

      // A leaves — B still subscribed, so no grace timer / no cancel.
      (mgr as any).handleDisconnect('client-A');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).not.toHaveBeenCalled();

      // Now B leaves too — only then is the timer armed + fires.
      (mgr as any).handleDisconnect('client-B');
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).toHaveBeenCalledWith('sess-multi', 'disconnected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the grace timer when a client re-subscribes before it fires (no cancellation)', async () => {
    vi.useFakeTimers();
    try {
      claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(true);
      connectClient('client-A');
      (mgr as any).claudeSubs.subscribe('client-A', 'sess-resub');

      (mgr as any).handleDisconnect('client-A'); // arms the grace timer

      // A different client re-opens the session before the grace expires.
      (mgr as any).claudeSubs.subscribe('client-B', 'sess-resub');

      await vi.advanceTimersByTimeAsync(120_000);
      // Re-subscribe cleared the timer → no cancellation.
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects CLAUDE_ASK_USER_QUESTION_DISCONNECT_GRACE_MS', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_DISCONNECT_GRACE_MS = '5000';
    vi.useFakeTimers();
    try {
      claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(true);
      connectClient('client-A');
      (mgr as any).claudeSubs.subscribe('client-A', 'sess-env');

      (mgr as any).handleDisconnect('client-A');

      await vi.advanceTimersByTimeAsync(4_999);
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).toHaveBeenCalledWith('sess-env', 'disconnected');
    } finally {
      vi.useRealTimers();
      delete process.env.CLAUDE_ASK_USER_QUESTION_DISCONNECT_GRACE_MS;
    }
  });

  it('does nothing when the last subscriber leaves a session with NO pending question', async () => {
    vi.useFakeTimers();
    try {
      claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(false);
      connectClient('client-A');
      (mgr as any).claudeSubs.subscribe('client-A', 'sess-nopending');

      (mgr as any).handleDisconnect('client-A');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(claudeMock.cancelPendingAskUserQuestionsForSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears all grace timers on close() (no dangling timers)', async () => {
    vi.useFakeTimers();
    try {
      claudeMock.hasPendingAskUserQuestionForSession.mockReturnValue(true);
      connectClient('client-A');
      (mgr as any).claudeSubs.subscribe('client-A', 'sess-teardown');

      (mgr as any).handleDisconnect('client-A');
      expect((mgr as any).askUserDisconnectGraceTimers.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    await (mgr as any).close();
    expect((mgr as any).askUserDisconnectGraceTimers.size).toBe(0);
    mgr = null as any; // afterEach would double-close; null it out
  });
});

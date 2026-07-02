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
});

/**
 * Extension UI dialogs are broadcast to every client watching a session, but an
 * answer only resolves the pending request once. Without a fan-out the other
 * device keeps a modal that blocks its whole composer (observed live on a phone
 * while the desktop had already answered "Clear goal?"). These tests drive the
 * REAL WebSocketConnectionManager response path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { claudeMock, opencodeMock, antigravityMock, piMock, extensionUiHandlerMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn().mockReturnValue(false),
      isPendingAskUserQuestion: vi.fn().mockReturnValue(false),
      respondToAskUserQuestion: vi.fn().mockReturnValue(true),
      wasRecentlyResolvedAskUserQuestion: vi.fn().mockReturnValue(false),
      sendPermissionResponse: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isPendingPermission: vi.fn().mockReturnValue(false),
      resolvePermission: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    antigravityMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      listSessions: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    piMock: noopRecursive,
    extensionUiHandlerMock: { handleResponse: vi.fn() },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => piMock }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({
  getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }),
}));
vi.mock('../../../src/pi/extension-ui-handler.js', () => ({
  getExtensionUIHandler: () => extensionUiHandlerMock,
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

describe('extension UI answer fan-out', () => {
  let mgr: WebSocketConnectionManager;
  let sent: Array<{ clientId: string; message: any }>;

  beforeEach(() => {
    vi.clearAllMocks();
    claudeMock.isPendingAskUserQuestion.mockReturnValue(false);
    claudeMock.wasRecentlyResolvedAskUserQuestion.mockReturnValue(false);
    opencodeMock.isPendingPermission.mockReturnValue(false);
    extensionUiHandlerMock.handleResponse.mockReset();

    mgr = new WebSocketConnectionManager();
    sent = [];
    (mgr as any).sendMessage = (clientId: string, message: unknown) => {
      sent.push({ clientId, message });
    };
    // Two devices watching the same session.
    (mgr as any).clients = new Map([
      ['client-desktop', { ws: { readyState: 1, close: () => {}, send: () => {} } }],
      ['client-mobile', { ws: { readyState: 1, close: () => {}, send: () => {} } }],
    ]);
  });

  afterEach(async () => {
    if (mgr) await (mgr as any).close?.();
  });

  it('closes the dialog on the other client when a Pi extension request is answered', async () => {
    await (mgr as any).handleExtensionUiResponse('client-desktop', {
      type: 'extension_ui_response',
      response: { id: 'req-goal-clear', approved: true },
    });

    expect(extensionUiHandlerMock.handleResponse).toHaveBeenCalledWith({ id: 'req-goal-clear', approved: true });

    const cancels = sent.filter((s) => s.message?.type === 'extension_ui_cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].clientId).toBe('client-mobile');
    expect(cancels[0].message.request).toEqual({ id: 'req-goal-clear', reason: 'answered' });
  });

  it('does not echo the cancel back to the client that answered', async () => {
    await (mgr as any).handleExtensionUiResponse('client-desktop', {
      type: 'extension_ui_response',
      response: { id: 'req-1', cancelled: true },
    });

    const echoed = sent.filter(
      (s) => s.message?.type === 'extension_ui_cancel' && s.clientId === 'client-desktop',
    );
    expect(echoed).toHaveLength(0);
  });

  it('fans out for a Claude AskUserQuestion answer too', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-mobile', {
      type: 'extension_ui_response',
      response: { id: 'req-ask', value: { answers: { 'Pick?': 'Blue' } } },
    });

    const cancels = sent.filter((s) => s.message?.type === 'extension_ui_cancel');
    expect(cancels).toHaveLength(1);
    expect(cancels[0].clientId).toBe('client-desktop');
    expect(cancels[0].message.request.reason).toBe('answered');
  });

  it('fans out for an OpenCode permission answer', async () => {
    opencodeMock.isPendingPermission.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-desktop', {
      type: 'extension_ui_response',
      response: { id: 'perm-1', approved: true },
    });

    expect(opencodeMock.resolvePermission).toHaveBeenCalledWith('perm-1', true);
    const cancels = sent.filter((s) => s.message?.type === 'extension_ui_cancel');
    expect(cancels.map((c) => c.clientId)).toEqual(['client-mobile']);
  });

  it('does not fan out when the answer was already too late to be delivered', async () => {
    claudeMock.isPendingAskUserQuestion.mockReturnValue(false);
    claudeMock.wasRecentlyResolvedAskUserQuestion.mockReturnValue(true);

    await (mgr as any).handleExtensionUiResponse('client-desktop', {
      type: 'extension_ui_response',
      response: { id: 'req-late', approved: true },
    });

    expect(sent.filter((s) => s.message?.type === 'extension_ui_cancel')).toHaveLength(0);
  });
});

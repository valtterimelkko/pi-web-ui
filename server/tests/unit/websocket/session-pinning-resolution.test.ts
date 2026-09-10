/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { noopRecursive, claudeMock, opencodeMock, antigravityMock, commandCodeMock, registryMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    noopRecursive,
    claudeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateAuth: vi.fn().mockResolvedValue({ ok: true }),
      listSessions: vi.fn().mockResolvedValue([]),
      pinSession: vi.fn().mockResolvedValue(true),
      unpinSession: vi.fn().mockReturnValue(true),
      hasSession: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    opencodeMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: true }),
      listSessions: vi.fn().mockResolvedValue([]),
      pinSession: vi.fn().mockResolvedValue(true),
      unpinSession: vi.fn().mockReturnValue(true),
      hasSession: vi.fn().mockReturnValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    antigravityMock: {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateSetup: vi.fn().mockResolvedValue({ ok: true }),
      listSessions: vi.fn().mockResolvedValue([]),
      pinSession: vi.fn().mockResolvedValue(true),
      unpinSession: vi.fn().mockReturnValue(true),
      hasSession: vi.fn().mockReturnValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    commandCodeMock: {
      pinSession: vi.fn().mockReturnValue(true),
      unpinSession: vi.fn().mockReturnValue(true),
      hasSession: vi.fn().mockResolvedValue(true),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    registryMock: {
      get: vi.fn(),
    },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => noopRecursive }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({
  getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }),
}));
vi.mock('../../../src/session-registry.js', () => ({
  getSessionRegistry: () => registryMock,
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

describe('WebSocketConnectionManager pin resolution', () => {
  let manager: WebSocketConnectionManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
    vi.clearAllMocks();
  });

  it('resolves an untracked Antigravity session from registry and pins it', async () => {
    manager = new WebSocketConnectionManager();
    const sendMessage = vi.fn();
    (manager as any).sendMessage = sendMessage;
    (manager as any).antigravityService = antigravityMock;
    registryMock.get.mockResolvedValueOnce({ id: 'agy-untracked-1', sdkType: 'antigravity' });

    await (manager as any).handlePinSession('client-1', {
      type: 'pin_session',
      sessionPath: 'agy-untracked-1',
    });

    expect(antigravityMock.pinSession).toHaveBeenCalledWith('agy-untracked-1');
    expect(sendMessage).toHaveBeenCalledWith('client-1', {
      type: 'session_pinned',
      sessionPath: 'agy-untracked-1',
      pinned: true,
    });
  });

  it('resolves an untracked Claude session from registry and pins it', async () => {
    manager = new WebSocketConnectionManager();
    const sendMessage = vi.fn();
    (manager as any).sendMessage = sendMessage;
    (manager as any).claudeService = claudeMock;
    registryMock.get.mockResolvedValueOnce({ id: 'claude-untracked-1', sdkType: 'claude' });

    await (manager as any).handlePinSession('client-1', {
      type: 'pin_session',
      sessionPath: 'claude-untracked-1',
    });

    expect(claudeMock.pinSession).toHaveBeenCalledWith('claude-untracked-1');
    expect(sendMessage).toHaveBeenCalledWith('client-1', {
      type: 'session_pinned',
      sessionPath: 'claude-untracked-1',
      pinned: true,
    });
  });

  it('resolves an untracked OpenCode session from registry and unpins it', async () => {
    manager = new WebSocketConnectionManager();
    const sendMessage = vi.fn();
    (manager as any).sendMessage = sendMessage;
    (manager as any).opencodeService = opencodeMock;
    registryMock.get.mockResolvedValueOnce({ id: 'opencode-untracked-1', sdkType: 'opencode' });

    await (manager as any).handleUnpinSession('client-1', {
      type: 'unpin_session',
      sessionPath: 'opencode-untracked-1',
    });

    expect(opencodeMock.unpinSession).toHaveBeenCalledWith('opencode-untracked-1');
    expect(sendMessage).toHaveBeenCalledWith('client-1', {
      type: 'session_pinned',
      sessionPath: 'opencode-untracked-1',
      pinned: false,
    });
  });

  it('resolves an untracked Command Code session from registry and pins it', async () => {
    manager = new WebSocketConnectionManager();
    const sendMessage = vi.fn();
    (manager as any).sendMessage = sendMessage;
    (manager as any).commandCodeService = commandCodeMock;
    registryMock.get.mockResolvedValueOnce({ id: 'cmd-untracked-1', sdkType: 'commandcode' });

    await (manager as any).handlePinSession('client-1', {
      type: 'pin_session',
      sessionPath: 'cmd-untracked-1',
    });

    expect(commandCodeMock.pinSession).toHaveBeenCalledWith('cmd-untracked-1');
    expect(sendMessage).toHaveBeenCalledWith('client-1', {
      type: 'session_pinned',
      sessionPath: 'cmd-untracked-1',
      pinned: true,
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { noopRecursive, claudeMock, opencodeMock, antigravityMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, {
    get: () => noopRecursive,
    apply: () => undefined,
  });
  return {
    noopRecursive,
    claudeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateAuth: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), stop: vi.fn().mockResolvedValue(undefined) },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(true), validateSetup: vi.fn().mockResolvedValue({ ok: true }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => noopRecursive }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({
  getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }),
}));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';

let manager: WebSocketConnectionManager | undefined;
afterEach(async () => {
  await manager?.close();
  manager = undefined;
});

describe('Command Code WebSocket pinning', () => {
  it('reports the human pin limit when the sixth known session is rejected', async () => {
    manager = new WebSocketConnectionManager();
    const sendMessage = vi.fn();
    (manager as any).sendMessage = sendMessage;
    (manager as any).commandCodeSessionIds = new Set(['commandcode-6']);
    (manager as any).commandCodeService = { pinSession: vi.fn(() => false), shutdown: vi.fn().mockResolvedValue(undefined) };

    await (manager as any).handlePinSession('client-1', {
      type: 'pin_session',
      sessionPath: 'commandcode-6',
    });

    expect(sendMessage).toHaveBeenCalledWith('client-1', {
      type: 'session_pin_error',
      sessionPath: 'commandcode-6',
      error: 'Maximum pinned sessions limit reached',
    });
  });
});

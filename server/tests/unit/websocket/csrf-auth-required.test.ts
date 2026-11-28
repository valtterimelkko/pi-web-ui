/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const { noopRecursive, claudeMock, opencodeMock, antigravityMock } = vi.hoisted(() => {
  const noopRecursive: any = new Proxy(function noop() {}, { get: () => noopRecursive, apply: () => undefined });
  return {
    noopRecursive,
    claudeMock: { isAvailable: vi.fn().mockResolvedValue(false), validateAuth: vi.fn().mockResolvedValue({ ok: false }), listSessions: vi.fn().mockResolvedValue([]), stop: vi.fn().mockResolvedValue(undefined) },
    opencodeMock: { isAvailable: vi.fn().mockResolvedValue(false), validateSetup: vi.fn().mockResolvedValue({ ok: false }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
    antigravityMock: { isAvailable: vi.fn().mockResolvedValue(false), validateSetup: vi.fn().mockResolvedValue({ ok: false }), listSessions: vi.fn().mockResolvedValue([]), shutdown: vi.fn().mockResolvedValue(undefined) },
  };
});
vi.mock('../../../src/claude/index.js', () => ({ getClaudeService: () => claudeMock }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => opencodeMock }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: () => antigravityMock }));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => noopRecursive }));
vi.mock('../../../src/pi/session-list-cache.js', () => ({ getPiSessionListCache: () => ({ list: () => Promise.resolve([]) }) }));

import { WebSocketConnectionManager } from '../../../src/websocket/connection.js';
import { generateCsrfToken } from '../../../src/security/csrf.js';

function connectCookieClient(mgr: WebSocketConnectionManager) {
  const ws = new EventEmitter() as any;
  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn();
  (mgr as any).wss.emit('connection', ws, { headers: {} }, {
    success: true,
    user: { userId: 'default-user', iat: 1, exp: 2 },
  });
  const client = Array.from((mgr as any).clients.values())[0] as any;
  return { ws, client };
}

describe('WebSocket CSRF authentication requirement', () => {
  let mgr: WebSocketConnectionManager | undefined;
  afterEach(async () => { await mgr?.close(); mgr = undefined; vi.clearAllMocks(); });

  it('keeps a cookie-upgraded client unauthenticated until the auth message', () => {
    mgr = new WebSocketConnectionManager();
    const { client } = connectCookieClient(mgr);
    expect(client.isAuthenticated).toBe(false);
  });

  it('rejects privileged messages before CSRF auth and accepts the valid handshake', async () => {
    mgr = new WebSocketConnectionManager();
    const { ws, client } = connectCookieClient(mgr);
    await (mgr as any).handleMessage(client.id, Buffer.from(JSON.stringify({ type: 'pin_session', sessionPath: 's1' })));
    const before = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(before.some((m: any) => m.code === 'UNAUTHORIZED')).toBe(true);

    const csrfToken = generateCsrfToken('default-user');
    await (mgr as any).handleMessage(client.id, Buffer.from(JSON.stringify({ type: 'auth', csrfToken })));
    expect(client.isAuthenticated).toBe(true);
    const after = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(after.some((m: any) => m.type === 'connection_status' && m.status === 'authenticated')).toBe(true);
  });
});

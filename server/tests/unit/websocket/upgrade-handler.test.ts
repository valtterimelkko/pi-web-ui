import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { handleWebSocketUpgrade, type UpgradeDeps } from '../../../src/websocket/upgrade-handler.js';
import { generateSessionToken } from '../../../src/security/auth.js';
import { wsUpgradeLimiter } from '../../../src/security/rate-limit.js';
import { config } from '../../../src/config.js';

// Use the real configured allowed origin so the test is environment-independent.
const ALLOWED = config.allowedOrigins[0];

let server: Server;
let baseUrl: string;
let wss: WebSocketServer;
const sessionSpy = vi.fn();
const terminalSpy = vi.fn();

function buildDeps(): UpgradeDeps {
  return {
    wsManager: {
      handleUpgrade: (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      },
      getWss: () => wss,
      getMultiSessionManager: () => ({}) as never,
    },
    handlers: {
      onSession: sessionSpy,
      onTerminal: terminalSpy,
    },
  };
}

beforeAll(async () => {
  wss = new WebSocketServer({ noServer: true });
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    handleWebSocketUpgrade(req, socket, head, buildDeps());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(r));
  wss.close();
});

beforeEach(() => {
  sessionSpy.mockClear();
  terminalSpy.mockClear();
  wsUpgradeLimiter.reset();
  vi.restoreAllMocks();
});

type Outcome = 'open' | 'rejected';

function attemptConnect(path: string, opts: { origin?: string; cookie?: string }): Promise<Outcome> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (opts.origin !== undefined) headers.Origin = opts.origin;
    if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
    const ws = new WebSocket(`ws://${baseUrl}${path}`, { headers });
    let settled = false;
    const done = (o: Outcome) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      resolve(o);
    };
    ws.on('open', () => done('open'));
    ws.on('error', () => done('rejected'));
    // unexpected-response (ws rejects with HTTP status) -> rejected
    ws.on('unexpected-response', () => done('rejected'));
    setTimeout(() => done('rejected'), 1500);
  });
}

function validCookie(): string {
  return `accessToken=${generateSessionToken('test-user')}`;
}

const PATHS = ['/ws', '/ws/terminal', '/ws/sessions/abc-123'];

describe('handleWebSocketUpgrade — central guard across all paths', () => {
  describe.each(PATHS)('path %s', (path) => {
    it('upgrades with a valid cookie + allowed origin', async () => {
      const outcome = await attemptConnect(path, { origin: ALLOWED, cookie: validCookie() });
      expect(outcome).toBe('open');
    });

    it('rejects without a cookie (no upgrade)', async () => {
      const outcome = await attemptConnect(path, { origin: ALLOWED });
      expect(outcome).toBe('rejected');
    });

    it('rejects a disallowed origin (no upgrade)', async () => {
      const outcome = await attemptConnect(path, {
        origin: 'http://evil.example',
        cookie: validCookie(),
      });
      expect(outcome).toBe('rejected');
    });

    it('rejects when the upgrade rate limit is exceeded (no upgrade)', async () => {
      vi.spyOn(wsUpgradeLimiter, 'check').mockReturnValue(false);
      const outcome = await attemptConnect(path, { origin: ALLOWED, cookie: validCookie() });
      expect(outcome).toBe('rejected');
    });
  });

  it('destroys unknown paths without upgrading', async () => {
    const outcome = await attemptConnect('/ws/unknown-path', { origin: ALLOWED, cookie: validCookie() });
    expect(outcome).toBe('rejected');
  });

  it('does not invoke the session handler when a session upgrade is rejected', async () => {
    await attemptConnect('/ws/sessions/abc', { origin: ALLOWED }); // no cookie
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it('does not invoke the terminal handler when a terminal upgrade is rejected', async () => {
    await attemptConnect('/ws/terminal', { origin: ALLOWED }); // no cookie
    expect(terminalSpy).not.toHaveBeenCalled();
  });

  it('invokes the terminal handler exactly once on a valid terminal upgrade', async () => {
    await attemptConnect('/ws/terminal', { origin: ALLOWED, cookie: validCookie() });
    expect(terminalSpy).toHaveBeenCalledTimes(1);
  });

  it('invokes the session handler exactly once on a valid session upgrade', async () => {
    await attemptConnect('/ws/sessions/abc', { origin: ALLOWED, cookie: validCookie() });
    expect(sessionSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects URL-encoded path tricks that do not match an accepted path', async () => {
    const outcome = await attemptConnect('/ws/terminal/extra', { origin: ALLOWED, cookie: validCookie() });
    expect(outcome).toBe('rejected');
    expect(terminalSpy).not.toHaveBeenCalled();
  });
});

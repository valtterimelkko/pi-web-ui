import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PROXY_KEY_HEADER,
  isLoopbackPeer,
  loadProxyKey,
  createProxyKeyGuard,
  proxyKeyMiddleware,
  proxyKeyUpgradeAllowed,
  type ProxyKeyGuard,
} from '../../../src/security/proxy-key.js';
import { handleWebSocketUpgrade, type UpgradeDeps } from '../../../src/websocket/upgrade-handler.js';
import { generateSessionToken } from '../../../src/security/auth.js';
import { wsUpgradeLimiter } from '../../../src/security/rate-limit.js';
import { config } from '../../../src/config.js';
import { createApp } from '../../../src/app.js';

const KEY = 'test-proxy-key-0123456789abcdef';
const ALLOWED_ORIGIN = config.allowedOrigins[0];

/** A non-loopback peer, e.g. Caddy's Docker-bridge address or a hostile container. */
const NON_LOOPBACK = '172.18.0.9';

function fakeReq(remote: string | undefined, headers: Record<string, unknown> = {}): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress: remote },
  } as unknown as IncomingMessage;
}

function guardFor(remote: string | undefined, key: Buffer | null = Buffer.from(KEY)): ProxyKeyGuard {
  return createProxyKeyGuard({ key, resolveRemoteAddress: () => remote });
}

describe('isLoopbackPeer', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.254',
    '127.63.42.9',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:127.200.1.1',
  ])('treats %s as loopback', (addr) => {
    expect(isLoopbackPeer(addr)).toBe(true);
  });

  it.each([
    '10.0.0.9',
    '172.18.0.4',
    '192.168.1.20',
    '8.8.8.8',
    '126.255.255.255',
    '128.0.0.1',
    '::ffff:10.0.0.9',
    '::ffff:8.8.8.8',
    'fe80::1',
    '2001:db8::1',
    'garbage',
    '',
    undefined,
  ])('treats %s as non-loopback', (addr) => {
    expect(isLoopbackPeer(addr)).toBe(false);
  });
});

describe('loadProxyKey', () => {
  it('returns null and warns once when the path is unset', () => {
    const warn = vi.fn();
    expect(loadProxyKey(undefined, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns once when the path is blank', () => {
    const warn = vi.fn();
    expect(loadProxyKey('   ', warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns once when the file does not exist', () => {
    const warn = vi.fn();
    expect(loadProxyKey(path.join(tmpdir(), 'pwu-key-does-not-exist'), warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns once when the path is unreadable (a directory)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pwu-key-dir-'));
    const warn = vi.fn();
    expect(loadProxyKey(dir, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns once when the file is empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pwu-key-'));
    const file = path.join(dir, 'key');
    writeFileSync(file, '');
    const warn = vi.fn();
    expect(loadProxyKey(file, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and warns once when the file is whitespace only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pwu-key-'));
    const file = path.join(dir, 'key');
    writeFileSync(file, '  \n\t ');
    const warn = vi.fn();
    expect(loadProxyKey(file, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns the trimmed file contents and never warns on a readable key', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pwu-key-'));
    const file = path.join(dir, 'key');
    writeFileSync(file, `  ${KEY}\n`);
    const warn = vi.fn();
    const key = loadProxyKey(file, warn);
    expect(key).not.toBeNull();
    expect(key!.toString('utf8')).toBe(KEY);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never includes key material in the warning text', () => {
    const warn = vi.fn();
    loadProxyKey(path.join(tmpdir(), 'pwu-key-missing'), warn);
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('PI_WEB_UI_PROXY_KEY_FILE');
    expect(message).not.toContain(KEY);
  });
});

describe('createProxyKeyGuard — allow() decision', () => {
  it('allows a loopback peer with no header', () => {
    expect(guardFor('127.0.0.1').allow(fakeReq('127.0.0.1'))).toBe(true);
  });

  it.each(['127.9.9.9', '::1', '::ffff:127.0.0.1'])(
    'allows loopback %s even when no key is configured',
    (remote) => {
      expect(guardFor(remote, null).allow(fakeReq(remote))).toBe(true);
    },
  );

  it('refuses a non-loopback peer with no header', () => {
    expect(guardFor(NON_LOOPBACK).allow(fakeReq(NON_LOOPBACK))).toBe(false);
  });

  it('refuses a non-loopback peer with the wrong key', () => {
    expect(
      guardFor(NON_LOOPBACK).allow(fakeReq(NON_LOOPBACK, { [PROXY_KEY_HEADER]: 'wrong-key' })),
    ).toBe(false);
  });

  it('refuses a non-loopback peer presenting a duplicated header (array)', () => {
    expect(
      guardFor(NON_LOOPBACK).allow(
        fakeReq(NON_LOOPBACK, { [PROXY_KEY_HEADER]: [KEY, KEY] }),
      ),
    ).toBe(false);
  });

  it('refuses a non-loopback peer whose duplicated header arrives comma-joined', () => {
    expect(
      guardFor(NON_LOOPBACK).allow(
        fakeReq(NON_LOOPBACK, { [PROXY_KEY_HEADER]: `${KEY}, ${KEY}` }),
      ),
    ).toBe(false);
  });

  it('allows a non-loopback peer presenting the exact key', () => {
    expect(
      guardFor(NON_LOOPBACK).allow(fakeReq(NON_LOOPBACK, { [PROXY_KEY_HEADER]: KEY })),
    ).toBe(true);
  });

  it('ignores a spoofed X-Forwarded-For from a non-loopback peer', () => {
    const req = fakeReq(NON_LOOPBACK, {
      'x-forwarded-for': '127.0.0.1',
      'x-real-ip': '127.0.0.1',
    });
    expect(guardFor(NON_LOOPBACK).allow(req)).toBe(false);
  });

  it('refuses every non-loopback peer when the key failed to load (fail closed)', () => {
    const guard = guardFor(NON_LOOPBACK, null);
    expect(guard.allow(fakeReq(NON_LOOPBACK))).toBe(false);
    expect(guard.allow(fakeReq(NON_LOOPBACK, { [PROXY_KEY_HEADER]: KEY }))).toBe(false);
  });
});

describe('proxyKeyMiddleware over real HTTP', () => {
  function minimalApp(guard: ProxyKeyGuard): express.Express {
    const app = express();
    app.use(proxyKeyMiddleware(guard));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('passes a loopback peer through to the route', async () => {
    const res = await request(minimalApp(guardFor('127.0.0.1'))).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('403s a non-loopback peer with no header', async () => {
    const res = await request(minimalApp(guardFor(NON_LOOPBACK))).get('/health');
    expect(res.status).toBe(403);
  });

  it('403s a non-loopback peer with the wrong key', async () => {
    const res = await request(minimalApp(guardFor(NON_LOOPBACK)))
      .get('/health')
      .set(PROXY_KEY_HEADER, 'wrong-key');
    expect(res.status).toBe(403);
  });

  it('403s a non-loopback peer with a duplicated header', async () => {
    // Array form sends two header lines; Node comma-joins them on receipt.
    const res = await request(minimalApp(guardFor(NON_LOOPBACK)))
      .get('/health')
      .set(PROXY_KEY_HEADER, [KEY, KEY]);
    expect(res.status).toBe(403);
  });

  it('passes a non-loopback peer with the right key', async () => {
    const res = await request(minimalApp(guardFor(NON_LOOPBACK)))
      .get('/health')
      .set(PROXY_KEY_HEADER, KEY);
    expect(res.status).toBe(200);
  });

  it('403s a non-loopback peer spoofing X-Forwarded-For: 127.0.0.1', async () => {
    const res = await request(minimalApp(guardFor(NON_LOOPBACK)))
      .get('/health')
      .set('X-Forwarded-For', '127.0.0.1')
      .set('X-Real-Ip', '127.0.0.1');
    expect(res.status).toBe(403);
  });

  it('403s a non-loopback peer when the key file was missing (fail closed)', async () => {
    const warn = vi.fn();
    const key = loadProxyKey(path.join(tmpdir(), 'pwu-key-missing'), warn);
    const res = await request(minimalApp(guardFor(NON_LOOPBACK, key))).get('/health');
    expect(res.status).toBe(403);
  });
});

describe('proxy-key guard wired into createApp() before every route', () => {
  const nonLoopbackGuard = guardFor(NON_LOOPBACK);

  function app(): express.Express {
    return createApp(undefined, { proxyKeyGuard: nonLoopbackGuard });
  }

  it('403s /health for a non-loopback peer without the key', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(403);
  });

  it('403s the login route for a non-loopback peer without the key', async () => {
    const res = await request(app())
      .post('/api/auth/login')
      .send({ password: 'anything' });
    expect(res.status).toBe(403);
  });

  it('403s an unmatched SPA path for a non-loopback peer without the key', async () => {
    const res = await request(app()).get('/some/spa/path');
    expect(res.status).toBe(403);
  });

  it('403s an API route for a non-loopback peer without the key', async () => {
    const res = await request(app()).get('/api/sessions');
    expect(res.status).toBe(403);
  });

  it('passes a non-loopback peer with the key through to the real route', async () => {
    const res = await request(app())
      .get('/health')
      .set(PROXY_KEY_HEADER, KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('proxy-key guard on WebSocket upgrades', () => {
  let server: Server;
  let baseUrl: string;
  let port: number;
  let wss: WebSocketServer;
  let guard: ProxyKeyGuard;
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
      proxyKeyGuard: guard,
    };
  }

  beforeAll(async () => {
    wss = new WebSocketServer({ noServer: true });
    server = createServer();
    server.on('upgrade', (req, socket, head) => {
      handleWebSocketUpgrade(req, socket, head, buildDeps());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
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
    // The real socket peer is loopback (supertest-style); the injected resolver
    // reports whatever peer the case under test needs. Default: non-loopback.
    guard = guardFor(NON_LOOPBACK);
  });

  type Outcome = 'open' | 'rejected';

  function attemptConnect(path: string, headers: Record<string, string>): Promise<Outcome> {
    return new Promise((resolve) => {
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
      ws.on('unexpected-response', () => done('rejected'));
      setTimeout(() => done('rejected'), 1500);
    });
  }

  function validHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Origin: ALLOWED_ORIGIN,
      Cookie: `accessToken=${generateSessionToken('test-user')}`,
      ...extra,
    };
  }

  /** Write a raw upgrade request (for header shapes ws cannot express). */
  function rawUpgradeRequest(rawHeaders: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      socket.on('data', (d) => {
        received += d.toString('utf8');
        socket.end();
        resolve(received);
      });
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(
          'GET /ws HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          // RFC 6455's sample nonce, built at runtime so secret scanners do not flag a literal.
          `Sec-WebSocket-Key: ${Buffer.from('the sample nonce').toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          rawHeaders +
          '\r\n',
        );
      });
      setTimeout(() => {
        socket.destroy();
        resolve(received);
      }, 2000);
    });
  }

  it('passes a loopback peer with no key header', async () => {
    guard = guardFor('127.0.0.1');
    const outcome = await attemptConnect('/ws', validHeaders());
    expect(outcome).toBe('open');
  });

  it('rejects a non-loopback peer with no key header (403 + socket destroyed)', async () => {
    const outcome = await attemptConnect('/ws', validHeaders());
    expect(outcome).toBe('rejected');
  });

  it('writes a real HTTP 403 to the wire for a non-loopback peer with no key', async () => {
    const response = await rawUpgradeRequest('');
    expect(response).toContain('403');
  });

  it('rejects a non-loopback peer with the wrong key', async () => {
    const outcome = await attemptConnect('/ws', validHeaders({ [PROXY_KEY_HEADER]: 'wrong-key' }));
    expect(outcome).toBe('rejected');
  });

  it('rejects a non-loopback peer with a duplicated key header', async () => {
    const response = await rawUpgradeRequest(
      `${PROXY_KEY_HEADER}: ${KEY}\r\n${PROXY_KEY_HEADER}: ${KEY}\r\n`,
    );
    expect(response).toContain('403');
  });

  it('passes a non-loopback peer with the right key through to auth and upgrade', async () => {
    const outcome = await attemptConnect('/ws', validHeaders({ [PROXY_KEY_HEADER]: KEY }));
    expect(outcome).toBe('open');
  });

  it('rejects a non-loopback peer spoofing X-Forwarded-For: 127.0.0.1', async () => {
    const outcome = await attemptConnect(
      '/ws',
      validHeaders({ 'X-Forwarded-For': '127.0.0.1' }),
    );
    expect(outcome).toBe('rejected');
  });

  it('rejects a non-loopback peer when the key file was missing (fail closed)', async () => {
    guard = guardFor(NON_LOOPBACK, null);
    const outcome = await attemptConnect('/ws', validHeaders({ [PROXY_KEY_HEADER]: KEY }));
    expect(outcome).toBe('rejected');
  });
});

describe('proxyKeyUpgradeAllowed — direct call', () => {
  function fakeSocket(): Duplex & { written: string; destroyed: boolean } {
    const state = { written: '', destroyed: false };
    return Object.assign(state, {
      write(chunk: string) { state.written += chunk; return true; },
      destroy() { state.destroyed = true; return this; },
    }) as unknown as Duplex & { written: string; destroyed: boolean };
  }

  it('writes a 403 and destroys the socket for a refused peer', () => {
    const socket = fakeSocket();
    const allowed = proxyKeyUpgradeAllowed(
      fakeReq(NON_LOOPBACK),
      socket,
      guardFor(NON_LOOPBACK),
    );
    expect(allowed).toBe(false);
    expect(socket.written).toContain('403');
    expect(socket.destroyed).toBe(true);
  });

  it('returns true without touching the socket for an allowed peer', () => {
    const socket = fakeSocket();
    const allowed = proxyKeyUpgradeAllowed(
      fakeReq('127.0.0.1'),
      socket,
      guardFor('127.0.0.1'),
    );
    expect(allowed).toBe(true);
    expect(socket.written).toBe('');
    expect(socket.destroyed).toBe(false);
  });
});

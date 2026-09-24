/**
 * Phase 3 (contract 1.45.0, INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md)
 * — Pi control actions lazy-load an unloaded registered session (S5).
 *
 * Incident shape (23 Sep): a fresh child session was unloaded after ~31 min
 * idle despite a retention lease; set_thinking_level then answered
 * `404 SESSION_NOT_FOUND "Pi session not loaded"` while GET /sessions/:id
 * showed a healthy idle session. Dispatch lazy-loads through subscribeClient;
 * control actions did not.
 *
 * Now: control resolves the session through the dispatch-path pattern
 * (d27e75cd) — subscribe an internal client, re-apply the stored model
 * binding outside the model lock (379211d6), act, hand the load back. A
 * session already loaded is untouched; a genuinely unknown session stays 404.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const SESSION_PATH = '/tmp/sessions/session-1.jsonl';

function jsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes(): ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> } {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = vi.fn((name: string, value: unknown) => { headers[name.toLowerCase()] = value; }) as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.write = vi.fn((data: string | Buffer) => { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res) as any;
  return res;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    path: SESSION_PATH,
    sdkType: 'pi',
    cwd: '/root/pi-web-ui',
    model: 'zai/glm-5.3',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-08-27T12:00:00.000Z',
    lastActivity: '2026-08-27T12:00:00.000Z',
    ...overrides,
  };
}

describe('Pi control actions lazy-load (Phase 3, contract 1.45.0)', () => {
  let dir: string;
  let registry: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let agentSession: Record<string, unknown>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-control-lazy-'));
    agentSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      model: { provider: 'zai', id: 'glm-5.3' },
      thinkingLevel: undefined as string | undefined,
      setThinkingLevel: vi.fn(function (this: { thinkingLevel?: string }, level: string) { this.thinkingLevel = level; }),
    };
    registry = {
      get: vi.fn(async (id: string) => entry({ id, path: id === 'session-1' ? SESSION_PATH : id })),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    piService = {
      getAvailableModels: vi.fn().mockResolvedValue([
        { id: 'glm-5.3', name: 'GLM-5.3', provider: 'zai', contextWindow: 200000 },
      ]),
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager = {
      // Start UNLOADED: the incident shape.
      getAgentSession: vi.fn(() => null),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn(async () => {
        // subscribeClient loads the session into memory.
        multiSessionManager.getAgentSession.mockReturnValue(agentSession);
      }),
      unsubscribeClient: vi.fn(),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      getAllSessionStatuses: vi.fn(() => []),
      isSessionPinned: vi.fn(() => false),
    };
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, {}),
      idFactory: (() => { let n = 0; return () => `lazy-${++n}`; })(),
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false), abort: vi.fn(), getBackendMode: vi.fn().mockResolvedValue('sdk') } as any,
      opencodeService: { isRunning: vi.fn(() => false), isEnabled: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('RED: set_thinking_level on an unloaded registered session lazy-loads and succeeds (S5)', async () => {
    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'high' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, action: 'set_thinking_level', level: 'high' });
    expect(multiSessionManager.subscribeClient).toHaveBeenCalledWith('internal-test-client', SESSION_PATH);
    expect(agentSession.setThinkingLevel).toHaveBeenCalledWith('high');
    // The load is handed back after the action.
    expect(multiSessionManager.unsubscribeClient).toHaveBeenCalledWith('internal-test-client', SESSION_PATH);
  });

  it('does not re-subscribe an already-loaded session (left exactly as found)', async () => {
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'low' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    expect(multiSessionManager.subscribeClient).not.toHaveBeenCalled();
    expect(multiSessionManager.unsubscribeClient).not.toHaveBeenCalled();
  });

  it('a genuinely unknown session stays 404 SESSION_NOT_FOUND', async () => {
    registry.get.mockResolvedValue(null);

    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'high' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('SESSION_NOT_FOUND');
    expect(multiSessionManager.subscribeClient).not.toHaveBeenCalled();
  });

  it('RED: create-time thinkingLevel echoes the applied level instead of omitting it (S5)', async () => {
    multiSessionManager.createAndSubscribe = vi.fn(async () => ({
      sessionId: 'pi-new',
      sessionPath: '/tmp/sessions/pi-new.jsonl',
    }));
    multiSessionManager.getAgentSession.mockImplementation((_path: string) =>
      _path === '/tmp/sessions/pi-new.jsonl' ? agentSession : null);

    const res = mockRes();
    await routes.handleCreateSession(
      jsonReq('POST', '/api/v1/sessions', { runtime: 'pi', cwd: '/root/pi-web-ui', thinkingLevel: 'high' }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.thinkingLevel).toBe('high');
  });

  it('create-time thinkingLevel says why when no level could be applied (S5 honest reason)', async () => {
    const clampedSession = {
      ...agentSession,
      // Model rejects the effort: Pi reports no active level afterwards.
      thinkingLevel: undefined,
      setThinkingLevel: vi.fn(function (this: { thinkingLevel?: string }) { this.thinkingLevel = undefined; }),
    };
    multiSessionManager.createAndSubscribe = vi.fn(async () => ({
      sessionId: 'pi-new',
      sessionPath: '/tmp/sessions/pi-new.jsonl',
    }));
    multiSessionManager.getAgentSession.mockImplementation((_path: string) =>
      _path === '/tmp/sessions/pi-new.jsonl' ? clampedSession : null);

    const res = mockRes();
    await routes.handleCreateSession(
      jsonReq('POST', '/api/v1/sessions', { runtime: 'pi', cwd: '/root/pi-web-ui', thinkingLevel: 'max' }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.thinkingLevel).toBeNull();
    expect(String(body.thinkingLevelNote)).toContain('no active thinking level');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  });
  res.getHeader = vi.fn();
  return res;
}

function json(res: { body: string }): any {
  return JSON.parse(res.body);
}

describe('createSessionRoutes — API pinning + detach', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-pin-routes-'));

    registry = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        path: sessionId,
        sdkType: 'claude',
        cwd: '/root/proj',
        model: 'sonnet',
        firstMessage: '',
        messageCount: 0,
        status: 'idle',
        createdAt: '2026-06-19T00:00:00.000Z',
        lastActivity: '2026-06-19T00:00:00.000Z',
      })),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    claudeService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn(async () => ({ sessionId: 'claude-1' })),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      setModel: vi.fn().mockResolvedValue('sonnet'),
      sendPrompt: vi.fn(async (_id: string, _msg: string, onEvent: (e: NormalizedEvent) => void, onComplete: (e?: Error) => void) => {
        onEvent({ type: 'agent_start', sessionId: 'claude-1', timestamp: Date.now(), data: {} });
        onComplete();
      }),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('channel'),
      abort: vi.fn(),
    };
    opencodeService = { isAvailable: vi.fn().mockResolvedValue(true) };
    antigravityService = { isAvailable: vi.fn().mockResolvedValue(true) };
    multiSessionManager = {};
    piService = { setModel: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes() {
    return createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      // Make the expiry sweep inert during these fast tests.
      pinExpiryIntervalMs: 60_000,
    });
  }

  it('pins at creation when pin:true and returns pinned + pinnedUntil', async () => {
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', pin: true });
    const res = createMockRes();
    await routes.handleCreateSession(req, res, 'claude-1');

    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({ sessionId: 'claude-1', pinned: true });
    expect(json(res).pinnedUntil).toEqual(expect.any(String));
    expect(claudeService.pinSession).toHaveBeenCalledWith('claude-1');
  });

  it('returns PIN_LIMIT_REACHED (session still created) when the runtime refuses the pin', async () => {
    claudeService.pinSession.mockReturnValue(false);
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', pin: true });
    const res = createMockRes();
    await routes.handleCreateSession(req, res, 'claude-1');

    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      sessionId: 'claude-1',
      pinned: false,
      pinReason: 'PIN_LIMIT_REACHED',
    });
    expect(json(res).pinnedUntil).toBeUndefined();
  });

  it('does not pin when pin is not requested', async () => {
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude' });
    const res = createMockRes();
    await routes.handleCreateSession(req, res, 'claude-1');

    expect(res.statusCode).toBe(201);
    expect(json(res).pinned).toBeUndefined();
    expect(claudeService.pinSession).not.toHaveBeenCalled();
  });

  it('control pin with pinTtlSeconds returns a clamped pinnedUntil', async () => {
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions/claude-1/control', {
      action: 'pin',
      pinTtlSeconds: 60,
    });
    const res = createMockRes();
    await routes.handleSessionControl(req, res, 'claude-1');

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true, action: 'pin', pinned: true });
    expect(json(res).pinnedUntil).toEqual(expect.any(String));
  });

  it('control unpin clears the pin ledger record', async () => {
    const routes = makeRoutes();
    // pin first
    await routes.handleSessionControl(
      createJsonReq('POST', '/x', { action: 'pin', pinTtlSeconds: 3600 }),
      createMockRes(),
      'claude-1',
    );
    // then unpin
    const unpinRes = createMockRes();
    await routes.handleSessionControl(
      createJsonReq('POST', '/x', { action: 'unpin' }),
      unpinRes,
      'claude-1',
    );

    expect(json(unpinRes)).toMatchObject({ success: true, action: 'unpin', pinned: false });
    expect(claudeService.unpinSession).toHaveBeenCalledWith('claude-1');
  });

  it('/info reports pinnedUntil while an API pin is active', async () => {
    const routes = makeRoutes();
    await routes.handleSessionControl(
      createJsonReq('POST', '/x', { action: 'pin', pinTtlSeconds: 3600 }),
      createMockRes(),
      'claude-1',
    );
    claudeService.isSessionPinned.mockReturnValue(true);

    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/x'), infoRes, 'claude-1');

    expect(json(infoRes)).toMatchObject({ sessionId: 'claude-1', pinned: true });
    expect(json(infoRes).pinnedUntil).toEqual(expect.any(String));
  });

  it('detach=true returns 202 immediately and runs the turn in the background', async () => {
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions/claude-1/prompt', {
      message: 'do something long',
      detach: true,
    });
    const res = createMockRes();
    await routes.handleSendPrompt(req, res, 'claude-1');

    expect(res.statusCode).toBe(202);
    expect(json(res)).toMatchObject({ sessionId: 'claude-1', detached: true, status: 'accepted' });
    // Let the fire-and-forget turn run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(claudeService.sendPrompt).toHaveBeenCalledWith(
      'claude-1',
      'do something long',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('detach with a streaming verbosity is rejected', async () => {
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions/claude-1/prompt', {
      message: 'hi',
      detach: true,
      verbosity: 'full',
    });
    const res = createMockRes();
    await routes.handleSendPrompt(req, res, 'claude-1');

    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('INVALID_REQUEST');
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
  });

  it('deleting a session clears its pin ledger record', async () => {
    const routes = makeRoutes();
    await routes.handleSessionControl(
      createJsonReq('POST', '/x', { action: 'pin', pinTtlSeconds: 3600 }),
      createMockRes(),
      'claude-1',
    );
    await routes.handleDeleteSession(createJsonReq('DELETE', '/x'), createMockRes(), 'claude-1');
    // After delete, /info no longer reports a pinnedUntil for this session.
    claudeService.isSessionPinned.mockReturnValue(false);
    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/x'), infoRes, 'claude-1');
    expect(json(infoRes).pinnedUntil).toBeUndefined();
  });
});

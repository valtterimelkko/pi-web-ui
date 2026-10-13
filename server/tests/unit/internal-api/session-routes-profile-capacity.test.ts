import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';


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
  res.setHeader = vi.fn((name: string, value: unknown) => { headers[name] = value; }) as any;
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


function createMultiSessionManagerMock() {
  return {
    getAgentSession: vi.fn(() => null),
    subscribeClient: vi.fn().mockResolvedValue(undefined),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    pinSession: vi.fn(() => true),
    unpinSession: vi.fn(() => true),
    isSessionPinned: vi.fn(() => false),
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1', path: 'session-1', sdkType: 'claude', claudeProfileId: 'capped-profile',
    cwd: '/root/pi-web-ui', model: 'sonnet', firstMessage: 'first', messageCount: 0, status: 'idle',
    createdAt: '2026-07-15T12:00:00.000Z', lastActivity: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('Internal API Claude profile capacity admission (contract 1.61.0)', () => {
  let dir: string;
  let claudeService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let atCap: boolean;

  beforeEach(async () => {
    atCap = true;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-profile-cap-'));
    const registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isRunning: vi.fn(() => false),
      getProfileCapacity: vi.fn((profileId?: string) => profileId === 'capped-profile'
        ? { profileId, maxConcurrent: 2, active: atCap ? 2 : 1 }
        : undefined),
      getProfileCapacities: vi.fn(() => [{ profileId: 'capped-profile', maxConcurrent: 2, active: atCap ? 2 : 1 }]),
      sendPrompt: vi.fn(async (sessionId: string, _m: string, onEvent: (e: any) => void, onComplete: (e?: Error) => void) => {
        onEvent({ type: 'agent_start', sessionId, timestamp: Date.now(), data: {} });
        onEvent({ type: 'agent_end', sessionId, timestamp: Date.now(), data: {} });
        onComplete();
      }),
      steer: vi.fn(() => true),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
      isSessionPinned: vi.fn(() => false),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      abort: vi.fn(),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
    };
    manager = new RunReceiptManager({ store: new RunReceiptStore(dir), idFactory: (() => { let n = 0; return () => `run-cap-${++n}`; })() });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager: createMultiSessionManagerMock() as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry as any,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) } as any,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('refuses a prompt at the profile cap with 429 PROFILE_CAPACITY_EXHAUSTED and creates no run receipt', async () => {
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'third', idempotencyKey: 'cap-1' }), res, 'session-1');
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ code: 'PROFILE_CAPACITY_EXHAUSTED', profileId: 'capped-profile', maxConcurrent: 2, active: 2 });
    expect(res.headers['Retry-After']).toBeDefined();
    expect(body.runId).toBeUndefined();
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(manager.listNonterminal()).toEqual([]);
    expect(await manager.findExistingRun({
      sessionId: 'session-1', runtime: 'claude', executionInstanceId: 'capped-profile', model: 'sonnet',
      message: 'third', mode: 'prompt', verbosity: 'answers', detach: false, requireActiveTurn: false, idempotencyKey: 'cap-1',
    } as any)).toBeUndefined();
  });

  it('refuses a follow_up that would start a new turn at the cap', async () => {
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'x', mode: 'follow_up' }), res, 'session-1');
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body).code).toBe('PROFILE_CAPACITY_EXHAUSTED');
  });

  it('admits the prompt when the profile is below its cap', async () => {
    atCap = false;
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'ok' }), res, 'session-1');
    expect(res.statusCode).toBe(200);
    expect(claudeService.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('still steers a busy session at the cap (steer joins a live turn)', async () => {
    claudeService.isRunning.mockReturnValue(true);
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'nudge', mode: 'steer', detach: true }), res, 'session-1');
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'accepted', mode: 'steer', dispatchMode: 'steer' });
    await vi.waitFor(() => expect(claudeService.steer).toHaveBeenCalledTimes(1));
  });

  it('refuses a batch prompt entry at the cap without creating a run receipt', async () => {
    const res = mockRes();
    await routes.handleBatchPrompt(jsonReq('POST', '/api/v1/sessions/batch/prompt', { prompts: [{ sessionId: 'session-1', message: 'b' }] }), res);
    const body = JSON.parse(res.body);
    const result = body.results?.[0] ?? body.responses?.[0];
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PROFILE_CAPACITY_EXHAUSTED');
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(manager.listNonterminal()).toEqual([]);
  });

  it('GET /capacity advertises claudeProfiles', async () => {
    const res = mockRes();
    await routes.handleCapacity(jsonReq('GET', '/api/v1/capacity'), res);
    expect(JSON.parse(res.body).claudeProfiles).toEqual([{ profileId: 'capped-profile', maxConcurrent: 2, active: 2 }]);
  });
});

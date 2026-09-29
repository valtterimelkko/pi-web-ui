/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

/**
 * C2 (contract 1.57.0) — busy follow-ups and never-started runs, part 1:
 *
 * A Pi session reports `busy:false` while auto-compaction is running (the
 * manager's status flipped to idle at agent_end, but the SDK is still
 * compacting). The Internal API then accepted a prompt with 202 and the
 * detached run failed with "Cannot submit a prompt while compaction is in
 * progress" (receipt failed RUNTIME_ERROR): an accepted-then-lost dispatch.
 *
 * These tests pin the explicit-refusal fix:
 *  - compaction is exposed as busy (detail.busy) and every prompt mode is
 *    refused with 409 SESSION_BUSY, a compaction hint and Retry-After;
 *  - a follow_up is only queued when the busy state is backed by a LIVE
 *    runtime turn (status streaming or SDK isStreaming truth) — a busy state
 *    with no live turn (the pre-start limbo) is refused instead of queued
 *    into a queue nothing may ever drain.
 */

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
    path: 'session-1',
    sdkType: 'pi',
    cwd: '/root/pi-web-ui',
    model: 'provider/model',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-07-15T12:00:00.000Z',
    lastActivity: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

function createAgentSessionMock(overrides: Record<string, unknown> = {}) {
  const followUps: string[] = [];
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn(async (message: string) => { followUps.push(message); }),
    getFollowUpMessages: vi.fn(() => [...followUps]),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMultiSessionManagerMock(overrides: Record<string, unknown> = {}) {
  return {
    getAgentSession: vi.fn(() => null),
    getSessionStatus: vi.fn(() => ({ status: 'idle' })),
    isSessionPinned: vi.fn(() => false),
    subscribeClient: vi.fn().mockResolvedValue(undefined),
    unsubscribeClient: vi.fn().mockResolvedValue(undefined),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    getAllSessionStatuses: vi.fn(() => []),
    ...overrides,
  };
}

describe('C2 — compaction exposed as busy, follow_up requires a live turn', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: ReturnType<typeof createMultiSessionManagerMock>;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let now: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-c2-busy-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(),
      isPendingAskUserQuestion: vi.fn(() => false),
      respondToAskUserQuestion: vi.fn(() => true),
      wasRecentlyResolvedAskUserQuestion: vi.fn(() => false),
      sendPermissionResponse: vi.fn(),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false), replyPermission: vi.fn() };
    antigravityService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false) };
    piService = { setModel: vi.fn().mockResolvedValue(undefined) };
    multiSessionManager = createMultiSessionManagerMock();
  });

  afterEach(async () => {
    await routes?.shutdown();
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function makeRoutes() {
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager: multiSessionManager as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
      runReceiptManager: manager,
    });
  }

  it('1. detached prompt during Pi auto-compaction is refused 409 SESSION_BUSY with a compaction hint and Retry-After (was: 202 then failed RUNTIME_ERROR)', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: true });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'continue', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(String(body.error)).toMatch(/compact/i);
    expect(res.headers['retry-after']).toBeDefined();
    // Nothing was accepted: no receipt, no runtime dispatch.
    expect(manager.get('run-1')).toBeUndefined();
    expect(agentSession.prompt).not.toHaveBeenCalled();
  });

  it('2. synchronous prompt during Pi auto-compaction is refused 409 with the compaction hint', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: true });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hello' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(String(body.error)).toMatch(/compact/i);
    expect(agentSession.prompt).not.toHaveBeenCalled();
    expect(manager.get('run-1')).toBeUndefined();
  });

  it('3. steer during Pi auto-compaction is refused 409 (a steer into a compacting session is doomed)', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: true });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'stop', mode: 'steer' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(String(body.error)).toMatch(/compact/i);
    expect(agentSession.steer).not.toHaveBeenCalled();
  });

  it('4. GET /sessions/:id reports busy:true while the Pi session is auto-compacting', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: true });

    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/session-1'), res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.busy).toBe(true);
  });

  it('5. follow_up into a busy Pi session with NO live turn is refused 409 with a hint (was: queued then TURN_STALLED)', async () => {
    await makeRoutes();
    // The pre-start limbo shape: the manager's status says busy (a prompt was
    // accepted) but no runtime turn is streaming — nothing will drain a queue.
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'busy', compacting: false, sdkStreaming: false });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'when done, run tests', mode: 'follow_up', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(res.headers['retry-after']).toBeDefined();
    expect(agentSession.followUp).not.toHaveBeenCalled();
    expect(manager.get('run-1')).toBeUndefined();
  });

  it('6. follow_up into a busy Pi session whose SDK reports a live streaming turn is still queued', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'busy', compacting: false, sdkStreaming: true });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'when done, run tests', mode: 'follow_up', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(202);
    expect(agentSession.followUp).toHaveBeenCalledWith('when done, run tests');
    expect(manager.get('run-1')?.dispatchMode).toBe('follow_up');
  });

  it('7. regression: follow_up into a streaming (status) Pi session still queues', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming', compacting: false });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'queued note', mode: 'follow_up', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(202);
    expect(agentSession.followUp).toHaveBeenCalledWith('queued note');
  });

  it('8. regression: plain prompt on a genuinely idle Pi session is unchanged', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: false, sdkStreaming: false });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    multiSessionManager.addApiObserver.mockImplementation((_sessionPath: string, observer: (event: any) => void) => {
      process.nextTick(() => {
        observer({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} });
      });
    });

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hello' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(200);
    expect(agentSession.prompt).toHaveBeenCalledWith('hello');
  });

  it('9. correction 01: follow_up with manager-idle but SDK-streaming truth queues behind the live turn (was: idle-promoted, SDK-rejected, cancelled)', async () => {
    await makeRoutes();
    // The extension-driven / browser turn shape: the manager's status is idle
    // (it never saw the turn) but the SDK is streaming. One liveness predicate
    // must see it, so the follow_up is QUEUED, not promoted to a plain prompt.
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: false, sdkStreaming: true });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'after the live turn', mode: 'follow_up', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.dispatchMode).toBe('follow_up');
    expect(agentSession.followUp).toHaveBeenCalledWith('after the live turn');
    expect(agentSession.prompt).not.toHaveBeenCalled();
    expect(manager.get('run-1')?.dispatchMode).toBe('follow_up');
  });

  it('10. correction 01: plain prompt with manager-idle but SDK-streaming truth is refused 409 SESSION_BUSY', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle', compacting: false, sdkStreaming: true });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hello', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(res.headers['retry-after']).toBeDefined();
    expect(agentSession.prompt).not.toHaveBeenCalled();
    expect(manager.get('run-1')).toBeUndefined();
  });
});

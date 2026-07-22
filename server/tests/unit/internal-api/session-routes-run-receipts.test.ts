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
    id: 'session-1',
    path: 'session-1',
    sdkType: 'claude',
    claudeProfileId: 'native-profile',
    cwd: '/root/pi-web-ui',
    model: 'sonnet',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-07-15T12:00:00.000Z',
    lastActivity: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('Internal API run receipt integration', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let multiSessionManager: ReturnType<typeof createMultiSessionManagerMock>;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-route-'));
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(async (sessionId: string, _message: string, onEvent: (event: any) => void, onComplete: (error?: Error) => void) => {
        onEvent({ type: 'agent_start', sessionId, timestamp: Date.now(), data: {} });
        onEvent({ type: 'agent_end', sessionId, timestamp: Date.now(), data: {} });
        onComplete();
      }),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
      isSessionPinned: vi.fn(() => false),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      abort: vi.fn(),
    };
    multiSessionManager = createMultiSessionManagerMock();
    manager = new RunReceiptManager({ store: new RunReceiptStore(dir), idFactory: (() => {
      let n = 0;
      return () => `run-route-${++n}`;
    })() });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager: multiSessionManager as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('returns a runId and deduplicates a retry without invoking the runtime twice', async () => {
    const firstResponse = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'dispatch-1' }),
      firstResponse,
      'session-1',
    );
    const first = JSON.parse(firstResponse.body);

    const duplicateResponse = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'dispatch-1' }),
      duplicateResponse,
      'session-1',
    );
    const duplicate = JSON.parse(duplicateResponse.body);

    expect(first.runId).toBe('run-route-1');
    expect(first.turnComplete).toBe(true);
    expect(duplicate).toMatchObject({ runId: first.runId, duplicate: true, receipt: { status: 'completed' } });
    expect(claudeService.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('replays an idempotent run even when the runtime still reports the session busy', async () => {
    const existing = await manager.beginRun({
      sessionId: 'session-1',
      runtime: 'claude',
      executionInstanceId: 'native-profile',
      model: 'sonnet',
      message: 'do it',
      mode: 'prompt',
      verbosity: 'answers',
      detach: false,
      idempotencyKey: 'dispatch-busy',
    });
    await manager.markStarted(existing.receipt.runId);
    claudeService.isRunning.mockReturnValue(true);

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'dispatch-busy' }),
      response,
      'session-1',
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      runId: existing.receipt.runId,
      duplicate: true,
      receipt: { status: 'started' },
    });
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
  });

  it('releases an idempotency key when a busy race cancels before runtime dispatch', async () => {
    claudeService.isRunning
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const racedResponse = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'retry-after-race' }),
      racedResponse,
      'session-1',
    );
    const raced = JSON.parse(racedResponse.body);

    const retryResponse = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'retry-after-race' }),
      retryResponse,
      'session-1',
    );
    const retry = JSON.parse(retryResponse.body);

    expect(racedResponse.statusCode).toBe(409);
    expect(raced).toMatchObject({ runId: 'run-route-1', code: 'SESSION_BUSY' });
    expect(retryResponse.statusCode).toBe(200);
    expect(retry).toMatchObject({ runId: 'run-route-2', turnComplete: true });
    expect(claudeService.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('releases an idempotency key when the post-reservation busy check throws', async () => {
    claudeService.isRunning
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => { throw new Error('busy check unavailable'); })
      .mockReturnValue(false);

    const failedResponse = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'retry-after-busy-error' }),
      failedResponse,
      'session-1',
    );
    const failed = JSON.parse(failedResponse.body);

    const retryResponse = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: 'retry-after-busy-error' }),
      retryResponse,
      'session-1',
    );
    const retry = JSON.parse(retryResponse.body);

    expect(failedResponse.statusCode).toBe(500);
    expect(failed).toMatchObject({ runId: 'run-route-1', code: 'INTERNAL_ERROR' });
    expect(retryResponse.statusCode).toBe(200);
    expect(retry).toMatchObject({ runId: 'run-route-2', turnComplete: true });
    expect(claudeService.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('returns a conflict instead of swallowing a same-key different prompt', async () => {
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'first', idempotencyKey: 'dispatch-1' }),
      mockRes(),
      'session-1',
    );
    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'different', idempotencyKey: 'dispatch-1' }),
      response,
      'session-1',
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(claudeService.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('returns the persisted receipt from the run lookup endpoint', async () => {
    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'lookup me' }),
      response,
      'session-1',
    );
    const runId = JSON.parse(response.body).runId;

    const lookup = mockRes();
    await routes.handleGetRunReceipt(jsonReq('GET', `/api/v1/runs/${runId}`), lookup, runId);

    expect(lookup.statusCode).toBe(200);
    expect(JSON.parse(lookup.body)).toMatchObject({
      runId,
      status: 'completed',
      sessionId: 'session-1',
      executionInstanceId: 'native-profile',
    });
  });

  it('exposes executionInstanceId in session list and info without changing runtime-family fields', async () => {
    const list = mockRes();
    await routes.handleListSessions(jsonReq('GET', '/api/v1/sessions'), list);
    expect(JSON.parse(list.body).sessions[0]).toMatchObject({ runtime: 'claude', executionInstanceId: 'native-profile' });

    const info = mockRes();
    await routes.handleGetSessionInfo(jsonReq('GET', '/api/v1/sessions/session-1/info'), info, 'session-1');
    expect(JSON.parse(info.body)).toMatchObject({ runtime: 'claude', executionInstanceId: 'native-profile' });
  });

  it('rejects an empty idempotency key before invoking the runtime', async () => {
    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', idempotencyKey: '   ' }),
      response,
      'session-1',
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
  });

  it('includes the runId when a runtime turn fails and persists the failed receipt', async () => {
    claudeService.sendPrompt.mockImplementationOnce(async (sessionId: string, _message: string, _onEvent: (event: any) => void, onComplete: (error?: Error) => void) => {
      onComplete(new Error('provider failed'));
    });
    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'fail once' }),
      response,
      'session-1',
    );
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(500);
    expect(body.runId).toMatch(/^run-route-/);
    const lookup = mockRes();
    await routes.handleGetRunReceipt(jsonReq('GET', `/api/v1/runs/${body.runId}`), lookup, body.runId);
    expect(JSON.parse(lookup.body)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_ERROR' });
  });

  it('does not close a successful stream before its terminal receipt reaches durable storage', async () => {
    let releaseTerminalWrite!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => { releaseTerminalWrite = resolve; });
    const delayedStore = new RunReceiptStore(path.join(dir, 'delayed'));
    const transition = delayedStore.transition.bind(delayedStore);
    let terminalWriteStarted = false;
    vi.spyOn(delayedStore, 'transition').mockImplementation(async (runId, status, patch) => {
      if (status === 'completed') {
        terminalWriteStarted = true;
        await terminalWriteGate;
      }
      return transition(runId, status, patch);
    });
    const delayedManager = new RunReceiptManager({ store: delayedStore });
    await delayedManager.init();
    const delayedRoutes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false), abort: vi.fn() } as unknown as SessionRoutesDeps['opencodeService'],
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as unknown as SessionRoutesDeps['antigravityService'],
      multiSessionManager: multiSessionManager as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches-delayed'),
      runReceiptManager: delayedManager,
    });
    const response = mockRes();

    const pending = delayedRoutes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'stream it', verbosity: 'full' }),
      response,
      'session-1',
    );
    await vi.waitFor(() => expect(terminalWriteStarted).toBe(true));

    expect(response.end).not.toHaveBeenCalled();
    releaseTerminalWrite();
    await pending;
    expect(response.headers['X-Run-Id']).toEqual(expect.any(String));
    expect(response.end).toHaveBeenCalledOnce();
  });

  it('terminalizes a started receipt when streaming transport setup fails before runtime dispatch', async () => {
    const response = mockRes();
    response.setHeader = vi.fn(() => { throw new Error('transport unavailable'); }) as typeof response.setHeader;

    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'stream it', verbosity: 'full' }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);

    expect(response.statusCode).toBe(500);
    expect(manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_ERROR' });
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
  });

  it('records the current Pi model even when registry metadata has not been patched', async () => {
    registry.get.mockResolvedValue(entry({
      sdkType: 'pi',
      claudeProfileId: undefined,
      model: undefined,
      path: '/tmp/pi-session.jsonl',
    }));
    multiSessionManager.getAgentSession.mockReturnValue({
      model: { provider: 'openai-codex', id: 'gpt-5.6-terra' },
      prompt: vi.fn().mockRejectedValue(new Error('stop after dispatch')),
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'capture model', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);

    expect(manager.get(runId)?.model).toBe('openai-codex/gpt-5.6-terra');
  });

  it('keeps a Pi receipt nonterminal when prompt returns at compaction and completes only on agent_end', async () => {
    registry.get.mockResolvedValue(entry({
      sdkType: 'pi',
      claudeProfileId: undefined,
      model: 'openai/gpt-5.6-terra',
      path: '/tmp/pi-compaction-session.jsonl',
    }));
    const observers = new Set<(event: unknown) => void>();
    multiSessionManager.addApiObserver.mockImplementation((_sessionPath: string, observer: (event: unknown) => void) => { observers.add(observer); });
    multiSessionManager.removeApiObserver.mockImplementation((_sessionPath: string, observer: (event: unknown) => void) => { observers.delete(observer); });
    let releasePrompt!: () => void;
    const promptReturned = new Promise<void>((resolve) => { releasePrompt = resolve; });
    multiSessionManager.getAgentSession.mockReturnValue({
      model: { provider: 'openai-codex', id: 'gpt-5.6-terra' },
      prompt: vi.fn(() => promptReturned),
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'survive compaction', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);
    await vi.waitFor(() => expect(observers.size).toBeGreaterThanOrEqual(2));

    for (const observer of [...observers]) observer({ type: 'session_compaction', sessionId: 'session-1', timestamp: Date.now(), data: {} });
    releasePrompt();
    for (const observer of [...observers]) observer({ type: 'agent_start', sessionId: 'session-1', timestamp: Date.now(), data: { resumed: true } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.get(runId)?.status).toBe('started');
    expect(manager.get(runId)?.agentEndAt).toBeUndefined();
    expect(manager.get(runId)?.terminalAt).toBeUndefined();

    const endedAt = Date.now();
    for (const observer of [...observers]) observer({ type: 'agent_end', sessionId: 'session-1', timestamp: endedAt, data: {} });
    await vi.waitFor(() => expect(manager.get(runId)).toMatchObject({
      status: 'completed',
      agentEndAt: new Date(endedAt).toISOString(),
      terminalAt: expect.any(String),
    }));
  });

  it('completes a Pi slash command when its handler returns without agent_end', async () => {
    registry.get.mockResolvedValue(entry({ sdkType: 'pi', claudeProfileId: undefined, model: 'openai/gpt-5.6-terra', path: '/tmp/pi-command-session.jsonl' }));
    multiSessionManager.getAgentSession.mockReturnValue({
      model: { provider: 'openai-codex', id: 'gpt-5.6-terra' },
      prompt: vi.fn().mockResolvedValue(undefined),
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/autocompact75 validate-next 5', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);

    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('completed'));
    expect(manager.get(runId)?.agentEndAt).toBeUndefined();
    expect(manager.get(runId)?.terminalAt).toEqual(expect.any(String));
  });

  it('returns a runId for detached dispatches', async () => {
    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'detach me', detach: true }),
      response,
      'session-1',
    );

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ detached: true, status: 'accepted', runId: expect.any(String) });
  });
});

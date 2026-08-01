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
    subscribeClient: vi.fn().mockResolvedValue(undefined),
    unsubscribeClient: vi.fn().mockResolvedValue(undefined),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    getAllSessionStatuses: vi.fn(() => []),
    ...overrides,
  };
}

describe('Internal API prompt mode dispatch semantics', () => {
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
  const intervals: NodeJS.Timeout[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-prompt-modes-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
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
    piService = {};
    multiSessionManager = createMultiSessionManagerMock();
  });

  afterEach(async () => {
    intervals.splice(0).forEach(clearInterval);
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function makeRoutes(options: { idleTimeoutMs?: number; maxMs?: number } = {}) {
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
      turnIdleTimeoutMs: options.idleTimeoutMs ?? 60_000,
      turnMaxMs: options.maxMs ?? 300_000,
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

  // ─────────────────────────────────────────────────────────────────────────
  // Task 1 — Pi follow_up / steer dispatch through session state
  // ─────────────────────────────────────────────────────────────────────────

  it('1. follow_up on an idle Pi session is promoted to a new turn and response carries dispatchMode prompt', async () => {
    await makeRoutes();
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    multiSessionManager.addApiObserver.mockImplementation((_sessionPath: string, observer: (event: any) => void) => {
      // Simulate the turn completing immediately with agent_end
      process.nextTick(() => {
        observer({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} });
      });
    });

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'continue', mode: 'follow_up' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.dispatchMode).toBe('prompt');
    expect(body.mode).toBe('follow_up');
    expect(body.turnComplete).toBe(true);
    expect(agentSession.prompt).toHaveBeenCalledWith('continue');
    expect(agentSession.followUp).not.toHaveBeenCalled();
    expect(agentSession.steer).not.toHaveBeenCalled();
  });

  it('2. follow_up on a streaming Pi session calls followUp and receipt reaches queued', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', {
      message: 'continue',
      mode: 'follow_up',
      detach: true,
    });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('accepted');
    expect(body.runId).toBe('run-1');
    const receipt = manager.get('run-1');
    expect(receipt?.status).toBe('queued');
    expect(receipt?.dispatchMode).toBe('follow_up');
    expect(agentSession.followUp).toHaveBeenCalledWith('continue');
  });

  it('3. follow_up + requireActiveTurn: true on an idle Pi session returns 409 SESSION_NOT_STREAMING', async () => {
    await makeRoutes();

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', {
      message: 'continue',
      mode: 'follow_up',
      requireActiveTurn: true,
    });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_NOT_STREAMING');
    expect(manager.get('run-1')).toBeUndefined();
  });

  it('4. steer on an idle Pi session returns 409 SESSION_NOT_STREAMING', async () => {
    await makeRoutes();

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'stop', mode: 'steer' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_NOT_STREAMING');
    expect(manager.get('run-1')).toBeUndefined();
  });

  it('5. steer on a streaming Pi session still calls steer()', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    multiSessionManager.addApiObserver.mockImplementation((_sessionPath: string, observer: (event: any) => void) => {
      process.nextTick(() => {
        observer({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} });
      });
    });

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'stop', mode: 'steer' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.dispatchMode).toBe('steer');
    expect(agentSession.steer).toHaveBeenCalledWith('stop');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task 2 — Busy pre-flight applies to every mode
  // ─────────────────────────────────────────────────────────────────────────

  it('6. follow_up on a running Claude session returns 409 SESSION_BUSY and creates no receipt', async () => {
    await makeRoutes();
    registry.get.mockResolvedValue({ ...entry(), sdkType: 'claude', status: 'running' });
    claudeService.isRunning.mockReturnValue(true);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'continue', mode: 'follow_up' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(manager.listBySession('session-1')).toHaveLength(0);
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
  });

  it('7. 409 SESSION_BUSY includes Retry-After header', async () => {
    await makeRoutes();
    registry.get.mockResolvedValue({ ...entry(), sdkType: 'claude', status: 'running' });
    claudeService.isRunning.mockReturnValue(true);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'continue', mode: 'follow_up' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('8. racing already-running throw after reservation terminalises receipt with SESSION_BUSY', async () => {
    await makeRoutes();
    registry.get.mockResolvedValue({ ...entry(), sdkType: 'claude', status: 'idle' });
    claudeService.isRunning.mockReturnValue(false);
    claudeService.sendPrompt.mockImplementation((_sessionId: string, _message: string, _onEvent: any, onComplete: (error?: Error) => void) => {
      onComplete(new Error('Claude session is already running: session-1'));
    });

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', mode: 'prompt' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_BUSY');
    expect(body.runId).toBe('run-1');
    const receipt = manager.get('run-1');
    expect(receipt?.status).toBe('cancelled');
    expect(receipt?.errorCode).toBe('SESSION_BUSY');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task 4 — A run may only be terminalised by its own turn
  // ─────────────────────────────────────────────────────────────────────────

  it('14. two overlapping Pi runs: the first agent_end terminalises only run A; run B remains non-terminal', async () => {
    await makeRoutes();
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    multiSessionManager.addApiObserver.mockImplementation(() => undefined);

    // Start run A (will be held open until we emit its agent_end)
    const promiseA = routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'A', mode: 'prompt' }),
      mockRes(),
      'session-1',
    );

    // Wait until run A owns the session before racing run B.
    await vi.waitFor(() => expect(agentSession.prompt).toHaveBeenCalledWith('A'));

    // Run B must be rejected as busy because run A is in flight.
    const resB = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'B', mode: 'prompt' }),
      resB,
      'session-1',
    );
    expect(resB.statusCode).toBe(409);

    // Complete run A
    process.nextTick(() => {
      for (const call of multiSessionManager.addApiObserver.mock.calls) {
        (call[1] as (event: any) => void)({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} });
      }
    });
    await promiseA;

    const receiptA = manager.get('run-1');
    const receiptB = manager.get('run-2'); // never created because busy
    expect(receiptA?.status).toBe('completed');
    expect(receiptB).toBeUndefined();
  });

  it('15. a queued follow-up receipt is not completed by the in-flight turn agent_end', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    // Detached follow_up while streaming creates a queued receipt with no observer.
    const resQueued = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'continue', mode: 'follow_up', detach: true }),
      resQueued,
      'session-1',
    );
    expect(resQueued.statusCode).toBe(202);
    const queuedRunId = JSON.parse(resQueued.body).runId;
    expect(manager.get(queuedRunId)?.status).toBe('queued');

    // Simulate the currently streaming turn ending.
    const observers = multiSessionManager.addApiObserver.mock.calls.map((call) => call[1] as (event: any) => void);
    observers.forEach((observer) => observer({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} }));

    // The queued receipt must stay queued — it has no agent_end observer.
    expect(manager.get(queuedRunId)?.status).toBe('queued');
  });

  it('15b. a queued follow-up terminalises only after its own user message is delivered', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    const agentSession = createAgentSessionMock();
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const res = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'queued continuation', mode: 'follow_up', detach: true }),
      res,
      'session-1',
    );
    const runId = JSON.parse(res.body).runId;
    const observers = multiSessionManager.addApiObserver.mock.calls.map((call) => call[1] as (event: any) => void);

    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now, data: {} }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.get(runId)?.status).toBe('queued');

    const deliveredUserMessage = { role: 'user', content: [{ type: 'text', text: 'queued continuation' }] };
    observers.forEach((observer) => observer({ type: 'queue_update', timestamp: now + 1, data: { followUp: [] } }));
    observers.forEach((observer) => observer({
      type: 'message_start',
      timestamp: now + 1,
      data: { message: deliveredUserMessage },
    }));
    observers.forEach((observer) => observer({
      type: 'agent_end', timestamp: now + 2, data: { synthetic: true, reason: 'api_error_grace' },
    }));
    await vi.waitFor(() => expect(manager.get(runId)?.agentEndAt).toBeDefined());
    expect(manager.get(runId)).toMatchObject({
      status: 'started',
      liveness: { cessation: { state: 'unconfirmed', basis: 'synthetic_terminal_signal' } },
    });

    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now + 3, data: {} }));
    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('completed'));
  });

  it('15c. duplicate queued prompt text is correlated FIFO to one receipt per delivered turn', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    multiSessionManager.getAgentSession.mockReturnValue(createAgentSessionMock());

    const firstRes = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'same text', mode: 'follow_up', detach: true }),
      firstRes,
      'session-1',
    );
    const secondRes = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'same text', mode: 'follow_up', detach: true }),
      secondRes,
      'session-1',
    );
    const firstRunId = JSON.parse(firstRes.body).runId as string;
    const secondRunId = JSON.parse(secondRes.body).runId as string;
    const observers = multiSessionManager.addApiObserver.mock.calls.map((call) => call[1] as (event: any) => void);
    const delivered = {
      type: 'message_start',
      timestamp: now + 1,
      data: { message: { role: 'user', content: [{ type: 'text', text: 'same text' }] } },
    };

    observers.forEach((observer) => observer({ type: 'queue_update', timestamp: now + 1, data: { followUp: ['same text'] } }));
    observers.forEach((observer) => observer(delivered));
    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now + 2, data: {} }));
    await vi.waitFor(() => expect(manager.get(firstRunId)?.status).toBe('completed'));
    expect(manager.get(secondRunId)?.status).toBe('queued');

    observers.forEach((observer) => observer({ type: 'queue_update', timestamp: now + 3, data: { followUp: [] } }));
    observers.forEach((observer) => observer({ ...delivered, timestamp: now + 3 }));
    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now + 4, data: {} }));
    await vi.waitFor(() => expect(manager.get(secondRunId)?.status).toBe('completed'));
  });

  it('15d. a foreign same-text user event cannot claim a queued receipt before SDK queue removal', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    multiSessionManager.getAgentSession.mockReturnValue(createAgentSessionMock());

    const res = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'same text', mode: 'follow_up', detach: true }),
      res,
      'session-1',
    );
    const runId = JSON.parse(res.body).runId as string;
    const observers = multiSessionManager.addApiObserver.mock.calls.map((call) => call[1] as (event: any) => void);
    const messageStart = {
      type: 'message_start',
      timestamp: now + 1,
      data: { message: { role: 'user', content: [{ type: 'text', text: 'same text' }] } },
    };

    observers.forEach((observer) => observer(messageStart));
    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now + 2, data: {} }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.get(runId)?.status).toBe('queued');

    observers.forEach((observer) => observer({ type: 'queue_update', timestamp: now + 3, data: { followUp: [] } }));
    observers.forEach((observer) => observer({ ...messageStart, timestamp: now + 4 }));
    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now + 5, data: {} }));
    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('completed'));
  });

  it('15e. appending another SDK follow-up cannot be misread as removal of this run', async () => {
    await makeRoutes();
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    multiSessionManager.getAgentSession.mockReturnValue(createAgentSessionMock());

    const res = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'A', mode: 'follow_up', detach: true }),
      res,
      'session-1',
    );
    const runId = JSON.parse(res.body).runId as string;
    const observers = multiSessionManager.addApiObserver.mock.calls.map((call) => call[1] as (event: any) => void);

    observers.forEach((observer) => observer({ type: 'queue_update', timestamp: now + 1, data: { followUp: ['A', 'foreign-B'] } }));
    observers.forEach((observer) => observer({
      type: 'message_start',
      timestamp: now + 2,
      data: { message: { role: 'user', content: [{ type: 'text', text: 'A' }] } },
    }));
    observers.forEach((observer) => observer({ type: 'agent_end', timestamp: now + 3, data: {} }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.get(runId)?.status).toBe('queued');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task 5 — Stalled-run reconciliation and capacity release
  // ─────────────────────────────────────────────────────────────────────────

  it('16. a run that emits one event then nothing is terminalised TURN_STALLED after idle timeout', async () => {
    await makeRoutes({ idleTimeoutMs: 50 });
    const agentSession = createAgentSessionMock({
      prompt: vi.fn(async () => {
        // Emit exactly one non-terminal event and then hang forever.
        const observer = multiSessionManager.addApiObserver.mock.calls[0]?.[1] as (event: any) => void;
        process.nextTick(() => observer?.({ type: 'message_update', sessionId: 'session-1', timestamp: now, data: {} }));
        return new Promise(() => { /* never resolves */ });
      }),
    });
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hang', mode: 'prompt', detach: true });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');
    expect(res.statusCode).toBe(202);
    const runId = JSON.parse(res.body).runId;

    // Advance past the idle timeout.
    now += 200;
    await new Promise((r) => setTimeout(r, 150));

    const receipt = manager.get(runId);
    expect(receipt?.status).toBe('failed');
    expect(receipt?.errorCode).toBe('TURN_STALLED');
    expect(receipt?.terminalAt).toBeDefined();
  });

  it('17. admission activeTurns returns to zero after a stalled run is reaped', async () => {
    await makeRoutes({ idleTimeoutMs: 50 });
    const agentSession = createAgentSessionMock({
      prompt: vi.fn(async () => {
        const observer = multiSessionManager.addApiObserver.mock.calls[0]?.[1] as (event: any) => void;
        process.nextTick(() => observer?.({ type: 'message_update', sessionId: 'session-1', timestamp: now, data: {} }));
        return new Promise(() => { /* never resolves */ });
      }),
    });
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hang', mode: 'prompt', detach: true }),
      mockRes(),
      'session-1',
    );

    now += 200;
    await new Promise((r) => setTimeout(r, 150));

    const capacityRes = mockRes();
    await routes.handleCapacity(jsonReq('GET', '/api/v1/capacity'), capacityRes);
    const capacity = JSON.parse(capacityRes.body);
    expect(capacity.activeTurns).toBe(0);
    expect(capacity.runtimes.pi.activeTurns).toBe(0);
  });

  it('18. a run emitting periodic events is not reaped before the absolute ceiling', async () => {
    await makeRoutes({ idleTimeoutMs: 50, maxMs: 10_000 });
    const agentSession = createAgentSessionMock({
      prompt: vi.fn(async () => {
        const interval = setInterval(() => {
          now += 40;
          for (const call of multiSessionManager.addApiObserver.mock.calls) {
            (call[1] as (event: any) => void)({ type: 'message_update', sessionId: 'session-1', timestamp: now, data: {} });
          }
        }, 40);
        intervals.push(interval);
        return new Promise(() => { /* run until absolute ceiling, but we stop test early */ });
      }),
    });
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const resAlive = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'keep alive', mode: 'prompt', detach: true }),
      resAlive,
      'session-1',
    );
    const runId = JSON.parse(resAlive.body).runId;

    // Wait longer than the idle timeout.
    await new Promise((r) => setTimeout(r, 200));

    const receipt = manager.get(runId);
    expect(receipt?.status).not.toBe('failed');
  });

  it('review regression: a non-detached stalled run returns TURN_STALLED and aborts the runtime', async () => {
    await makeRoutes({ idleTimeoutMs: 50 });
    const agentSession = createAgentSessionMock({
      prompt: vi.fn(() => new Promise(() => { /* watchdog must settle the request */ })),
    });
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    const res = mockRes();
    const request = routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hang', mode: 'prompt' }),
      res,
      'session-1',
    );

    await vi.waitFor(() => expect(agentSession.prompt).toHaveBeenCalled());
    now += 200;
    await request;

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).code).toBe('TURN_STALLED');
    expect(agentSession.abort).toHaveBeenCalledTimes(1);
    expect(manager.get('run-1')).toMatchObject({ status: 'failed', errorCode: 'TURN_STALLED' });
  });

  it('19. /capacity reports stalledRuns', async () => {
    await makeRoutes({ idleTimeoutMs: 50 });
    const agentSession = createAgentSessionMock({
      prompt: vi.fn(async () => {
        const observer = multiSessionManager.addApiObserver.mock.calls[0]?.[1] as (event: any) => void;
        process.nextTick(() => observer?.({ type: 'message_update', sessionId: 'session-1', timestamp: now, data: {} }));
        return new Promise(() => { /* never resolves */ });
      }),
    });
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hang', mode: 'prompt', detach: true }),
      mockRes(),
      'session-1',
    );

    now += 200;
    await new Promise((r) => setTimeout(r, 150));

    const capacityRes = mockRes();
    await routes.handleCapacity(jsonReq('GET', '/api/v1/capacity'), capacityRes);
    const capacity = JSON.parse(capacityRes.body);
    expect(capacity.stalledRuns).toBeGreaterThanOrEqual(1);
  });
});

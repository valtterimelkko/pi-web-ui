/**
 * B3b — the run receipt carries RUN_BUDGET_EXCEEDED when a per-run budget
 * (output tokens or streamed bytes) aborts a Pi run.
 *
 * As in B3a, the upstream abort ends the run NORMALLY (stopReason "aborted",
 * a real agent_end), so without the plumbing under test here the receipt
 * would complete as `completed` and mask the breach. The Pi dispatch path
 * must turn the synthetic `run_budget_exceeded` event into a
 * `PiRunBudgetExceededError`, which `runtimeErrorCode` maps to
 * `RUN_BUDGET_EXCEEDED` on the terminal receipt — the same terminal code as
 * B3a's tool-argument budget, with the budget kind carried by the event
 * (`data.budget`), not by the receipt (which persists only the code).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { ErrorCode } from '../../../src/internal-api/error-codes.js';
import { SSE_EVENT_TYPES } from '../../../src/internal-api/types.js';
import { REGISTRY_EVENT_TYPES } from '../../../src/internal-api/event-types.js';
import { RUN_BUDGET_EXCEEDED_EVENT } from '../../../src/pi/run-budget.js';

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

function mockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn() as any;
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

describe('Internal API receipts carry RUN_BUDGET_EXCEEDED for per-run budgets (B3b)', () => {
  let dir: string;
  let registry: any;
  let multiSessionManager: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-budget-route-'));
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager = {
      getAgentSession: vi.fn(() => null),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      getAllSessionStatuses: vi.fn(() => []),
    };
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir),
      idFactory: (() => { let n = 0; return () => `run-budget-${++n}`; })(),
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService: {
        executionBackend: vi.fn(() => 'sdk-subscription'),
        isAvailable: vi.fn().mockResolvedValue(true),
        isRunning: vi.fn(() => false),
        sendPrompt: vi.fn(),
        getSessionStats: vi.fn().mockResolvedValue(null),
        getContextUsage: vi.fn().mockResolvedValue(null),
        getBackendMode: vi.fn().mockResolvedValue('sdk'),
      } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false) } as any,
      multiSessionManager: multiSessionManager as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) } as any,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    await routes?.shutdown();
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function installBreachAgent(budget: 'streamed_bytes' | 'output_tokens'): void {
    const observers: Array<(event: unknown) => void> = [];
    const agentSession = {
      prompt: vi.fn(async () => {
        // Simulate the guard upstream: the synthetic breach event, then the
        // aborted run's agent_end, then prompt() resolves normally.
        process.nextTick(() => {
          for (const observer of observers) {
            observer({
              type: RUN_BUDGET_EXCEEDED_EVENT,
              timestamp: Date.now(),
              data: budget === 'streamed_bytes'
                ? { budget, cap: 16 * 1024 * 1024, observed: 16 * 1024 * 1024 + 4096 }
                : { budget, cap: 500_000, observed: 500_400 },
            });
          }
          for (const observer of observers) {
            observer({ type: 'agent_end', sessionId: 'session-1', timestamp: Date.now(), data: {} });
          }
        });
      }),
    };
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    multiSessionManager.addApiObserver.mockImplementation((_path: string, observer: (event: unknown) => void) => {
      observers.push(observer);
    });
  }

  it(`a streamed_bytes breach (synthetic event, then aborted agent_end) fails the receipt with RUN_BUDGET_EXCEEDED`, async () => {
    installBreachAgent('streamed_bytes');
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it' }), res, 'session-1');
    expect(res.statusCode, res.body).toBe(500);
    const body = JSON.parse(res.body) as { runId: string; code: string };
    expect(body.code).toBe('RUN_BUDGET_EXCEEDED');
    await new Promise((resolve) => setImmediate(resolve));
    const receipt = manager.get(body.runId);
    expect(receipt?.status).toBe('failed');
    expect(receipt?.errorCode).toBe(ErrorCode.RUN_BUDGET_EXCEEDED);
    expect(receipt?.errorCode).toBe('RUN_BUDGET_EXCEEDED');
  });

  it(`an output_tokens breach fails the receipt with the same terminal code (the budget kind rides the event, not the receipt)`, async () => {
    installBreachAgent('output_tokens');
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it' }), res, 'session-1');
    expect(res.statusCode, res.body).toBe(500);
    const body = JSON.parse(res.body) as { code: string };
    expect(body.code).toBe('RUN_BUDGET_EXCEEDED');
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('a normal Pi turn still completes the receipt as completed (no false positives)', async () => {
    const agentSession = { prompt: vi.fn(async () => undefined) };
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    multiSessionManager.addApiObserver.mockImplementation((_path: string, observer: (event: any) => void) => {
      process.nextTick(() => {
        observer({ type: 'message_end', sessionId: 'session-1', timestamp: Date.now(), data: {}, message: { role: 'assistant', usage: { output: 42 } } });
        observer({ type: 'agent_end', sessionId: 'session-1', timestamp: Date.now(), data: {} });
      });
    });
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it' }), res, 'session-1');
    expect(res.statusCode, res.body).toBe(200);
    const { runId } = JSON.parse(res.body) as { runId: string };
    await new Promise((resolve) => setImmediate(resolve));
    const receipt = manager.get(runId);
    expect(receipt?.status).toBe('completed');
    expect(receipt?.errorCode).toBeUndefined();
  });

  it('a DETACHED dispatch (202) that breaches ends in a failed RUN_BUDGET_EXCEEDED receipt (shared executePromptWithReceipt path)', async () => {
    installBreachAgent('streamed_bytes');
    const res = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'do it', detach: true }),
      res,
      'session-1',
    );
    expect(res.statusCode, res.body).toBe(202);
    const body = JSON.parse(res.body) as { runId: string; detached?: boolean };
    expect(body.detached).toBe(true);
    let receipt = manager.get(body.runId);
    for (let i = 0; i < 50 && receipt?.status !== 'failed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      receipt = manager.get(body.runId);
    }
    expect(receipt?.status).toBe('failed');
    expect(receipt?.errorCode).toBe(ErrorCode.RUN_BUDGET_EXCEEDED);
  });

  it('the wire event type is registered in the contract surfaces and consistent across modules', () => {
    expect(SSE_EVENT_TYPES.RUN_BUDGET_EXCEEDED).toBe(RUN_BUDGET_EXCEEDED_EVENT);
    expect(SSE_EVENT_TYPES.RUN_BUDGET_EXCEEDED).toBe('run_budget_exceeded');
    expect(REGISTRY_EVENT_TYPES).toContain(RUN_BUDGET_EXCEEDED_EVENT);
  });
});

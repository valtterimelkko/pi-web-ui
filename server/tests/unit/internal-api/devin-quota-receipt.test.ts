import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { DevinProviderTurnError } from '../../../src/devin/devin-service.js';

/**
 * Lane C phase 2 — the ACTUAL route/receipt pipeline for a Devin quota refusal.
 *
 * Before this lane the receipt said `RUNTIME_ERROR`, i.e. "something went wrong,
 * try again", for a refusal where retrying cannot help until the allowance
 * resets (53 recorded failures). These tests drive the real prompt route and the
 * real run-receipt manager with a Devin service that completes with the typed
 * error the ACP boundary now produces.
 */

const QUOTA_TEXT = 'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 15 minutes.';
const RESET_AT = '2026-11-24T21:20:00.000Z';

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

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    path: 'session-1',
    sdkType: 'devin',
    cwd: '/ws',
    model: 'swe-2-flash-medium',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-11-24T20:00:00.000Z',
    lastActivity: '2026-11-24T20:00:00.000Z',
    ...overrides,
  };
}

describe('Internal API run receipt — Devin provider quota', () => {
  let dir: string;
  let registry: any;
  let devinService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-devin-quota-route-'));
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      listAll: vi.fn().mockResolvedValue([entry()]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    devinService = {
      isRunning: vi.fn(() => false),
      hasSession: vi.fn(() => true),
      abort: vi.fn(),
      sendPrompt: vi.fn(),
      followUp: vi.fn(),
      getServedModel: vi.fn().mockResolvedValue('swe-2-flash-medium'),
      getLastCompletedTurn: vi.fn().mockResolvedValue(null),
      getSessionStats: vi.fn().mockResolvedValue(null),
    };
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir),
      idFactory: (() => { let n = 0; return () => `run-devin-quota-${++n}`; })(),
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService: { executionBackend: vi.fn(() => 'sdk-subscription'), isRunning: vi.fn(() => false), sendPrompt: vi.fn(), getSessionStats: vi.fn().mockResolvedValue(null), getContextUsage: vi.fn().mockResolvedValue(null), getBackendMode: vi.fn().mockResolvedValue('sdk'), isSessionPinned: vi.fn(() => false), pinSession: vi.fn(() => true), unpinSession: vi.fn(() => true), abort: vi.fn() } as any,
      opencodeService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      antigravityService: { isRunning: vi.fn(() => false), hasSession: vi.fn(() => true), abort: vi.fn(), sendPrompt: vi.fn() } as any,
      devinService: devinService as unknown as SessionRoutesDeps['devinService'],
      multiSessionManager: {
        getAgentSession: vi.fn(() => null),
        subscribeClient: vi.fn().mockResolvedValue(undefined),
        addApiObserver: vi.fn(),
        removeApiObserver: vi.fn(),
        pinSession: vi.fn(() => true),
        unpinSession: vi.fn(() => true),
        isSessionPinned: vi.fn(() => false),
      } as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) } as any,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: manager,
      devinSessionDir: path.join(dir, 'devin-goals'),
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  /** Drive one failing Devin prompt and assert the receipt's errorCode. */
  async function runFailingDevinTurn(failure: Error, expectedCode: string): Promise<{ statusCode: number; body: any }> {
    devinService.sendPrompt.mockImplementationOnce(async (
      sessionId: string,
      _message: string,
      onEvent: (event: unknown) => void,
      onComplete: (error?: Error) => void,
    ) => {
      onEvent({ type: 'agent_start', sessionId, timestamp: Date.now(), data: {} });
      onEvent({
        type: 'agent_end',
        sessionId,
        timestamp: Date.now(),
        data: { result: null, usage: {}, error: failure.message, errorClass: 'quota', resetAt: RESET_AT },
      });
      onComplete(failure);
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'fail this turn' }),
      response,
      'session-1',
    );
    const body = JSON.parse(response.body);
    expect(devinService.sendPrompt).toHaveBeenCalledTimes(1);

    const lookup = mockRes();
    await routes.handleGetRunReceipt(jsonReq('GET', `/api/v1/runs/${body.runId}`), lookup, body.runId);
    expect(JSON.parse(lookup.body)).toMatchObject({ status: 'failed', errorCode: expectedCode });
    return { statusCode: response.statusCode, body };
  }

  it('names an exhausted free-model allowance on the run receipt', async () => {
    const failure = new DevinProviderTurnError(QUOTA_TEXT, 'quota', RESET_AT);
    const { statusCode, body } = await runFailingDevinTurn(failure, 'PROVIDER_QUOTA_EXHAUSTED');
    // The turn ran and failed: the response is the pre-existing failure shape
    // (500 + code), never an invented preflight refusal, and the code names the
    // class because the route computes it from the same completion error.
    expect(statusCode).toBe(500);
    expect(body.code).toBe('PROVIDER_QUOTA_EXHAUSTED');
  });

  it('keeps the generic runtime code for an unclassified Devin failure', async () => {
    const failure = new Error('devin acp session/prompt timed out after 120000ms');
    const { body } = await runFailingDevinTurn(failure, 'RUNTIME_ERROR');
    expect(body.code).toBe('RUNTIME_ERROR');
  });

  it('does not invent a client-visible 429 or a retry hint on the response', async () => {
    const failure = new DevinProviderTurnError(QUOTA_TEXT, 'quota', RESET_AT);
    const { statusCode, body } = await runFailingDevinTurn(failure, 'PROVIDER_QUOTA_EXHAUSTED');
    expect(statusCode).not.toBe(429);
    expect(JSON.stringify(body)).not.toMatch(/Retry-After|retryAfterSeconds/);
  });
});

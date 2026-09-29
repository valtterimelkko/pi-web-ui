/* eslint-disable @typescript-eslint/no-explicit-any -- route fixtures exercise heterogeneous runtime seams */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { DrainController } from '../../../src/internal-api/drain-controller.js';
import { createDrainRoutes, isExecutionEntryRequest } from '../../../src/internal-api/routes/drain.js';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { ErrorCode, ERROR_CODE_INFO } from '../../../src/internal-api/error-codes.js';

/**
 * B4 HTTP surface: the authenticated drain control endpoint, the gate that
 * refuses new P2/P3 creates/prompts while draining with a DISTINCT code and a
 * Retry-After, and the same mapping for admission refusals inside the prompt
 * pipeline (goal control and wakes reuse it).
 */

function jsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes(): ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> } {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = new Writable({
    write(chunk: Buffer, _e: BufferEncoding, cb: (error?: Error | null) => void) { chunks.push(chunk); cb(); },
  }) as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = vi.fn((name: string, value: unknown) => { headers[name.toLowerCase()] = value; }) as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number, hdrs?: Record<string, unknown>) {
    res.statusCode = code;
    for (const [k, v] of Object.entries(hdrs ?? {})) headers[k.toLowerCase()] = v;
    return this;
  }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res) as any;
  return res;
}

function roomyAdmission(): AdmissionController {
  return new AdmissionController({
    maxActiveTurns: 6,
    interactiveReserve: 1,
    minimumHeadroomBytes: 1,
    memoryCriticalBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    memory: () => ({ currentBytes: 0, limitBytes: 1_000_000 }),
    readPids: () => ({ current: 0, max: 10_000 }),
    host: () => ({ memAvailableBytes: 1_000_000 }),
    readMemoryEvents: () => undefined,
  });
}

describe('SERVER_DRAINING error code', () => {
  it('is a distinct, catalogued 503 code with an actionable hint', () => {
    expect(ErrorCode.SERVER_DRAINING).toBe('SERVER_DRAINING');
    expect(ERROR_CODE_INFO[ErrorCode.SERVER_DRAINING]).toMatchObject({ httpStatus: 503 });
    expect(ERROR_CODE_INFO[ErrorCode.SERVER_DRAINING].hint).toMatch(/Retry-After/);
  });
});

describe('isExecutionEntryRequest — what draining refuses at the router', () => {
  it.each([
    ['POST', ['sessions'], true],
    ['POST', ['sessions', 'batch'], true],
    ['POST', ['sessions', 'batch', 'prompt'], true],
    ['POST', ['sessions', 'child-1', 'prompt'], true],
    ['POST', ['sessions', 'child-1', 'transfer'], true],
  ] as const)('%s /%s is new P2 execution', (method, segments, expected) => {
    expect(isExecutionEntryRequest(method, [...segments])).toBe(expected);
  });

  it.each([
    ['GET', ['sessions']],
    ['DELETE', ['sessions', 'child-1']],
    ['POST', ['sessions', 'child-1', 'abort']],
    ['POST', ['sessions', 'child-1', 'control']],
    ['POST', ['sessions', 'child-1', 'watch']],
    ['DELETE', ['sessions', 'child-1', 'watch']],
    ['POST', ['sessions', 'child-1', 'adopt']],
    ['POST', ['sessions', 'child-1', 'approvals', 'r1', 'respond']],
    ['GET', ['sessions', 'child-1', 'wait']],
    ['GET', ['runs', 'run-1']],
    ['GET', ['capacity']],
    ['POST', ['drain']],
    ['DELETE', ['drain']],
    ['POST', ['notifications']],
    ['POST', ['sessions', 'usage']],
  ] as const)('%s /%s stays available (control, disposal, observation)', (method, segments) => {
    expect(isExecutionEntryRequest(method, [...segments])).toBe(false);
  });
});

describe('drain control routes', () => {
  let drain: DrainController | undefined;
  afterEach(() => { drain?.shutdown(); drain = undefined; });

  function setup(runs: Array<{ runId: string; sessionId: string; runtime: string; status: string }> = [], onBeforeStart?: () => Promise<void>) {
    const admission = roomyAdmission();
    drain = new DrainController({ admission, listNonterminalRuns: () => runs, pollIntervalMs: 5 });
    return { admission, routes: createDrainRoutes({ drain, onBeforeStart }) };
  }

  it('POST /drain closes admission, waits for the verdict and returns it', async () => {
    const { admission, routes } = setup();
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy 1.51.0', timeoutSeconds: 5 }), res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ state: 'settled', draining: true, reason: 'deploy 1.51.0', joined: false, cutOffRunIds: [] });
    expect(admission.getDraining()).toMatchObject({ reason: 'deploy 1.51.0' });
  });

  // B4.1: the busy-session source reads a refreshed snapshot BEFORE the first
  // measure — a busy session present only after the refresh must be counted.
  it('POST /drain awaits onBeforeStart before the first measurement (B4.1)', async () => {
    const busy: Array<{ sessionId: string; runtime: string; busyReason: string }> = [];
    const admission = roomyAdmission();
    drain = new DrainController({ admission, listNonterminalRuns: () => [], listBusySessions: () => busy, pollIntervalMs: 5 });
    const routes = createDrainRoutes({
      drain,
      onBeforeStart: async () => {
        busy.push({ sessionId: 'late-goal', runtime: 'pi', busyReason: 'sdk_streaming' });
      },
    });
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy 1.52.0', timeoutSeconds: 0 }), res);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'timed_out', cutOffSessionIds: ['late-goal'] });
  });

  it('a rejecting onBeforeStart never blocks the drain (B4.1)', async () => {
    const { routes } = setup([], async () => { throw new Error('snapshot down'); });
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy', timeoutSeconds: 5 }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'settled' });
  });

  // Correction 01 (self-drain): the caller may exclude its own session from
  // the busy-session settle wait, bounded and validated.
  it('POST /drain accepts bounded excludeSessionIds and reports them (correction 01)', async () => {
    const admission = roomyAdmission();
    const busy = [{ sessionId: 'self-1', runtime: 'pi', busyReason: 'status' }];
    drain = new DrainController({ admission, listNonterminalRuns: () => [], listBusySessions: () => busy, pollIntervalMs: 5 });
    const routes = createDrainRoutes({ drain });
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy', timeoutSeconds: 5, excludeSessionIds: ['self-1'] }), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'settled', excludedSessionIds: ['self-1'] });
  });

  it.each([
    ['more than 8 ids', { reason: 'deploy', excludeSessionIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }],
    ['an unsafe id', { reason: 'deploy', excludeSessionIds: ['../etc/passwd'] }],
    ['a non-string id', { reason: 'deploy', excludeSessionIds: [42] }],
    ['a non-array value', { reason: 'deploy', excludeSessionIds: 'self-1' }],
    ['an empty id', { reason: 'deploy', excludeSessionIds: [''] }],
  ])('POST /drain rejects %s with 400 and admission untouched', async (_label, body) => {
    const { admission, routes } = setup();
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', body), res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    expect(admission.getDraining()).toBeNull();
  });

  it('POST /drain reports the cut-off runs when the timeout elapses', async () => {
    const { routes } = setup([{ runId: 'run-a', sessionId: 'child-a', runtime: 'pi', status: 'started' }]);
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy', timeoutSeconds: 0 }), res);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'timed_out', cutOffRunIds: ['run-a'] });
  });

  it.each([
    [{}, 'missing reason'],
    [{ reason: '' }, 'empty reason'],
    [{ reason: 'x'.repeat(501) }, 'overlong reason'],
    [{ reason: 'ok', timeoutSeconds: -1 }, 'negative timeout'],
    [{ reason: 'ok', timeoutSeconds: 3601 }, 'timeout above the maximum'],
    [{ reason: 'ok', timeoutSeconds: 1.5 }, 'fractional timeout'],
    [{ reason: 'ok', holdSeconds: 0 }, 'zero hold'],
    [{ reason: 'ok', extra: true }, 'unknown field'],
    ['{not json', 'malformed JSON'],
  ])('POST /drain rejects %j (%s) with 400 and leaves admission open', async (body, _label) => {
    const { admission, routes } = setup();
    const res = mockRes();
    await routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', body), res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    expect(admission.getDraining()).toBeNull();
  });

  it('GET /drain reports status and DELETE /drain cancels and reopens admission', async () => {
    const { admission, routes } = setup([{ runId: 'run-a', sessionId: 'child-a', runtime: 'pi', status: 'started' }]);
    const started = mockRes();
    const pending = routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy', timeoutSeconds: 60 }), started);
    await new Promise((r) => setTimeout(r, 20));
    const status = mockRes();
    await routes.handleGetDrain(jsonReq('GET', '/api/v1/drain'), status);
    expect(JSON.parse(status.body)).toMatchObject({ state: 'draining', remaining: { nonterminalRuns: 1 } });

    const cancelled = mockRes();
    await routes.handleCancelDrain(jsonReq('DELETE', '/api/v1/drain'), cancelled);
    expect(JSON.parse(cancelled.body)).toMatchObject({ state: 'idle', draining: false, lastOutcome: { endedBy: 'operator' } });
    expect(admission.getDraining()).toBeNull();
    await pending;
    expect(JSON.parse(started.body).state).toBe('idle');
  });

  it('sendDrainingRefusal answers 503 SERVER_DRAINING with Retry-After and the drain context', async () => {
    const { routes } = setup([{ runId: 'run-a', sessionId: 'child-a', runtime: 'pi', status: 'started' }]);
    void routes.handleStartDrain(jsonReq('POST', '/api/v1/drain', { reason: 'deploy', timeoutSeconds: 60 }), mockRes());
    await new Promise((r) => setTimeout(r, 10));
    const res = mockRes();
    routes.sendDrainingRefusal(res);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(JSON.parse(res.body)).toMatchObject({ code: 'SERVER_DRAINING', retryAfterSeconds: 30, drain: { state: 'draining', reason: 'deploy' } });
  });
});

describe('prompt pipeline maps a draining admission refusal to SERVER_DRAINING', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map((c) => c())); });

  async function harness() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-b4-drain-routes-'));
    const admission = roomyAdmission();
    const manager = new RunReceiptManager({ store: new RunReceiptStore(dir), turnIdleTimeoutMs: 60_000 });
    await manager.init();
    const entry = {
      id: 'child-1', path: 'child-1', sdkType: 'claude', cwd: '/tmp/b4-drain', model: 'sonnet',
      firstMessage: 'fixture', messageCount: 0, status: 'idle',
      createdAt: '2026-09-29T00:00:00.000Z', lastActivity: '2026-09-29T00:00:00.000Z',
    };
    const claudeService: any = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isRunning: vi.fn(() => false),
      getBackendMode: vi.fn(async () => 'sdk'),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      steer: vi.fn(() => true),
      abort: vi.fn(),
      sendPrompt: vi.fn(async () => { throw new Error('must not dispatch while draining'); }),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      isAvailable: vi.fn().mockResolvedValue(true),
    };
    const routes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false), isEnabled: vi.fn(() => true), abort: vi.fn() } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager: {
        getAgentSession: vi.fn(() => undefined), getSessionStatus: vi.fn(() => ({ status: 'idle' })),
        subscribeClient: vi.fn(), unsubscribeClient: vi.fn(), addApiObserver: vi.fn(), removeApiObserver: vi.fn(),
      } as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: {
        get: vi.fn(async (id: string) => (id === 'child-1' ? entry : undefined)),
        listAll: vi.fn(async () => [entry]),
        delete: vi.fn(), upsert: vi.fn(), patchSessionMeta: vi.fn(),
      } as any,
      piService: { setModel: vi.fn() } as any,
      internalClientId: 'b4-drain-test',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: manager,
      admissionController: admission,
      drainRetryAfterSeconds: 30,
    });
    await routes.ready;
    cleanups.push(async () => { await routes.shutdown(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
    return { admission, routes, claudeService, manager };
  }

  it('a prompt refused because admission is draining gets 503 SERVER_DRAINING + Retry-After, and its receipt is cancelled', async () => {
    const { admission, routes, claudeService, manager } = await harness();
    admission.setDraining({ since: Date.now(), reason: 'deploy' });
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/child-1/prompt', { message: 'hello', detach: true }), res, 'child-1');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ code: 'SERVER_DRAINING', reason: 'draining', retryAfterSeconds: 30 });
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(manager.get(body.runId)).toMatchObject({ status: 'cancelled', errorCode: 'SERVER_DRAINING' });
    expect(manager.listNonterminal()).toEqual([]);
  });

  it('a batch prompt item refused by draining carries SERVER_DRAINING', async () => {
    const { admission, routes } = await harness();
    admission.setDraining({ since: Date.now(), reason: 'deploy' });
    const res = mockRes();
    await routes.handleBatchPrompt(jsonReq('POST', '/api/v1/sessions/batch/prompt', { prompts: [{ sessionId: 'child-1', message: 'hello' }] }), res);
    const body = JSON.parse(res.body);
    expect(body.results[0]).toMatchObject({ success: false, error: { code: 'SERVER_DRAINING', reason: 'draining' } });
  });
});

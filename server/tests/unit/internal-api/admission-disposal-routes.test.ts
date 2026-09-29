/**
 * B2 at the route level: admission acts on heap/lag pressure (creates and
 * prompts refused with 503 ADMISSION_CAPACITY_EXHAUSTED + reason + Retry-After),
 * P0/P1 control keeps working while P2 is refused, and session disposal
 * (DELETE, abort) succeeds at every pressure level including the critical
 * memory floor — R1 found wrapControl refusing DELETE with CONTROL_CRITICAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { AdmissionController, type AdmissionControllerOptions } from '../../../src/internal-api/admission-controller.js';
import { BoundedControlLane } from '../../../src/internal-api/control-lane.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const MiB = 1024 * 1024;

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
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

type MockRes = ServerResponse & { body: string; statusCode: number; headers: Record<string, string> };

function createMockRes(): MockRes {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as MockRes;
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = vi.fn((name: string, value: string) => { res.headers[name.toLowerCase()] = String(value); return res; }) as never;
  res.writeHead = vi.fn(function (this: MockRes, code: number) { res.statusCode = code; return this; }) as never;
  res.end = vi.fn(function (this: MockRes, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as never;
  res.getHeader = vi.fn();
  return res;
}

const json = (res: { body: string }): any => JSON.parse(res.body);

/** Admission with ample cgroup/host/PID room; tests add the pressure they need. */
function admissionWith(overrides: AdmissionControllerOptions = {}): AdmissionController {
  return new AdmissionController({
    maxActiveTurns: 4,
    interactiveReserve: 1,
    memory: () => ({ currentBytes: 0, limitBytes: 100_000 * MiB }),
    minimumHeadroomBytes: 1,
    reservedBytesPerTurn: 1,
    readPids: () => ({}) as never,
    host: () => ({}) as never,
    readMemoryEvents: () => undefined,
    heap: () => ({ usedBytes: 10 * MiB, limitBytes: 1000 * MiB }),
    ...overrides,
  });
}

/** cgroup projected headroom 9 bytes < critical floor 25 → controlAvailable=false. */
const criticalFloor = (): AdmissionControllerOptions => ({
  memory: () => ({ currentBytes: 9_990, limitBytes: 10_000 }),
  minimumHeadroomBytes: 100,
  reservedBytesPerTurn: 1,
});

const heapPressure = (): AdmissionControllerOptions => ({
  heap: () => ({ usedBytes: 900 * MiB, limitBytes: 1000 * MiB }),
});

function lagged(admission: AdmissionController): AdmissionController {
  admission.observeLagReading({ p99Ms: 800, atMs: Date.now(), sampleCount: 120 });
  admission.observeLagReading({ p99Ms: 800, atMs: Date.now(), sampleCount: 120 });
  return admission;
}

describe('B2 admission at the route level', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let commandCodeService: any;
  const pending: Array<Promise<unknown>> = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-admission-routes-'));
    registry = {
      get: vi.fn(async (sessionId: string) => sessionId.startsWith('claude-') ? {
        id: sessionId, path: sessionId, sdkType: 'claude', cwd: '/root/proj', model: 'sonnet',
        firstMessage: '', messageCount: 0, status: 'idle',
        createdAt: '2026-09-29T00:00:00.000Z', lastActivity: '2026-09-29T00:00:00.000Z',
      } : null),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn(async () => ({ sessionId: 'claude-new' })),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      sendPrompt: vi.fn(),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('channel'),
      abort: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    const ccSession = (id: string) => id === 'commandcode-1'
      ? { sessionId: id, executionInstanceId: 'commandcode-default', cwd: '/root/proj', modelSelector: 'deepseek/deepseek-v4-pro', state: 'idle' }
      : undefined;
    commandCodeService = {
      getSession: vi.fn(async (id: string) => ccSession(id)),
      findSession: vi.fn(async (id: string) => ccSession(id)),
      isRunning: vi.fn(() => false),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      sendPrompt: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await Promise.all(pending.splice(0));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes(admissionController: AdmissionController, extra: { controlLane?: BoundedControlLane; disposalLane?: BoundedControlLane } = {}) {
    const routes = createSessionRoutes({
      claudeService,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), abort: vi.fn() } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(true), abort: vi.fn() } as any,
      commandCodeService,
      multiSessionManager: {} as any,
      sessionRegistry: registry,
      piService: { setModel: vi.fn() } as any,
      internalClientId: 'internal-test',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
      admissionController,
      runReceiptManager: new RunReceiptManager({ store: new RunReceiptStore(path.join(dir, 'receipts')) }),
      ...extra,
    } as any);
    pending.push(routes.ready.catch(() => undefined));
    return routes;
  }

  describe('session disposal is always available', () => {
    it('DELETE succeeds at the critical memory floor while other control is refused CONTROL_CRITICAL', async () => {
      const admission = admissionWith(criticalFloor());
      expect(admission.snapshot().controlAvailable).toBe(false);
      const routes = makeRoutes(admission);

      const evidence = createMockRes();
      await routes.handleGetSessionEvidence(createJsonReq('GET', '/x'), evidence, 'claude-1');
      expect(evidence.statusCode).toBe(503);
      expect(json(evidence).code).toBe('CONTROL_CRITICAL');

      const del = createMockRes();
      await routes.handleDeleteSession(createJsonReq('DELETE', '/x'), del, 'claude-1');
      expect(del.statusCode).toBe(200);
      expect(json(del)).toMatchObject({ success: true });
      expect(claudeService.abort).toHaveBeenCalledWith('claude-1');
    });

    it('DELETE of a Command Code session succeeds at the critical floor', async () => {
      const routes = makeRoutes(admissionWith(criticalFloor()));
      const del = createMockRes();
      await routes.handleDeleteSession(createJsonReq('DELETE', '/x'), del, 'commandcode-1');
      expect(del.statusCode).toBe(200);
      expect(commandCodeService.deleteSession).toHaveBeenCalledWith('commandcode-1');
    });

    it('abort (stop a running turn) succeeds at the critical floor', async () => {
      const routes = makeRoutes(admissionWith(criticalFloor()));
      const res = createMockRes();
      await routes.handleAbort(createJsonReq('POST', '/x'), res, 'claude-1');
      expect(res.statusCode).toBe(200);
      expect(claudeService.abort).toHaveBeenCalledWith('claude-1');
    });

    it('DELETE succeeds under heap pressure, lag and draining', async () => {
      const admission = lagged(admissionWith(heapPressure()));
      admission.setDraining({ since: Date.now(), reason: 'deploy' });
      const routes = makeRoutes(admission);
      const del = createMockRes();
      await routes.handleDeleteSession(createJsonReq('DELETE', '/x'), del, 'claude-1');
      expect(del.statusCode).toBe(200);
    });

    it('DELETE has its own lane: a saturated control lane cannot starve disposal', async () => {
      const controlLane = new BoundedControlLane(1, 5000, 0);
      const held = await controlLane.acquire(); // control lane full, no queue
      const disposalLane = new BoundedControlLane(2, 5000, 4);
      const routes = makeRoutes(admissionWith(), { controlLane, disposalLane });

      const evidence = createMockRes();
      await routes.handleGetSessionEvidence(createJsonReq('GET', '/x'), evidence, 'claude-1');
      expect(json(evidence).code).toBe('CONTROL_LANE_FULL');

      let observed = -1;
      claudeService.abort.mockImplementation(() => { observed = disposalLane.inFlight; });
      const del = createMockRes();
      await routes.handleDeleteSession(createJsonReq('DELETE', '/x'), del, 'claude-1');
      expect(del.statusCode).toBe(200);
      expect(observed).toBe(1); // ran inside the disposal lane
      expect(disposalLane.inFlight).toBe(0);
      held.release();
    });
  });

  describe('creates and prompts are refused under heap and lag pressure', () => {
    it('POST /sessions under heap_pressure → 503 ADMISSION_CAPACITY_EXHAUSTED + reason + Retry-After, nothing created', async () => {
      const routes = makeRoutes(admissionWith(heapPressure()));
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude' }), res);
      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'heap_pressure', retryAfterSeconds: 30 });
      expect(res.headers['retry-after']).toBe('30');
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('POST /sessions under event_loop_lag → 503 with reason event_loop_lag', async () => {
      const routes = makeRoutes(lagged(admissionWith()));
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude' }), res);
      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'event_loop_lag' });
      expect(res.headers['retry-after']).toBe('30');
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('POST /sessions is not refused for turn-slot saturation (a create holds no turn)', async () => {
      const admission = admissionWith({ maxActiveTurns: 2, interactiveReserve: 1 });
      const held = await admission.acquire('pi', 'P2');
      const routes = makeRoutes(admission);
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude' }), res);
      expect(res.statusCode).toBe(201);
      held.release();
    });

    it('batch create refuses each entry under heap_pressure with the contracted error shape', async () => {
      const routes = makeRoutes(admissionWith(heapPressure()));
      const res = createMockRes();
      await routes.handleBatchCreate(createJsonReq('POST', '/api/v1/sessions/batch', { sessions: [{ runtime: 'claude' }, { runtime: 'claude' }] }), res);
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body).toMatchObject({ createdCount: 0, failedCount: 2 });
      for (const item of body.created) {
        expect(item).toMatchObject({
          success: false,
          error: { code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'heap_pressure', retryAfterSeconds: 30 },
        });
      }
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('transfer with createNew is gated like a create', async () => {
      const routes = makeRoutes(admissionWith(heapPressure()));
      const res = createMockRes();
      await routes.handleSessionTransfer(createJsonReq('POST', '/x', { createNew: true, targetRuntime: 'claude' }), res, 'claude-1');
      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'heap_pressure' });
    });

    it('prompt under heap_pressure → 503 + Retry-After; prompt under event_loop_lag → 503 (not 429)', async () => {
      const heapRoutes = makeRoutes(admissionWith(heapPressure()));
      const a = createMockRes();
      await heapRoutes.handleSendPrompt(createJsonReq('POST', '/x', { message: 'hello' }), a, 'claude-1');
      expect(a.statusCode).toBe(503);
      expect(json(a)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'heap_pressure', retryAfterSeconds: 30 });
      expect(a.headers['retry-after']).toBe('30');

      const lagRoutes = makeRoutes(lagged(admissionWith()));
      const b = createMockRes();
      await lagRoutes.handleSendPrompt(createJsonReq('POST', '/x', { message: 'hello' }), b, 'claude-1');
      expect(b.statusCode).toBe(503);
      expect(json(b)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'event_loop_lag' });
      expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    });

    it('Command Code prompt under heap_pressure → 503 (pressure), not 429', async () => {
      const routes = makeRoutes(admissionWith(heapPressure()));
      const res = createMockRes();
      await routes.handleSendPrompt(createJsonReq('POST', '/x', { message: 'hello' }), res, 'commandcode-1');
      expect(res.statusCode).toBe(503);
      expect(json(res)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'heap_pressure' });
      expect(commandCodeService.sendPrompt).not.toHaveBeenCalled();
    });

    it('P0/P1 control keeps working while P2 is refused under heap pressure and lag', async () => {
      const admission = lagged(admissionWith(heapPressure()));
      const routes = makeRoutes(admission);
      const prompt = createMockRes();
      await routes.handleSendPrompt(createJsonReq('POST', '/x', { message: 'hello' }), prompt, 'claude-1');
      expect(prompt.statusCode).toBe(503);

      const control = createMockRes();
      await routes.handleSessionControl(createJsonReq('POST', '/x', { action: 'pin' }), control, 'claude-1');
      expect(control.statusCode).toBe(200);
      expect(claudeService.pinSession).toHaveBeenCalled();
      const abort = createMockRes();
      await routes.handleAbort(createJsonReq('POST', '/x'), abort, 'claude-1');
      expect(abort.statusCode).toBe(200);
    });
  });

  it('GET /capacity exposes heap, event-loop lag, draining and the disposal lane', async () => {
    const admission = lagged(admissionWith(heapPressure()));
    admission.setDraining({ since: Date.parse('2026-09-29T12:00:00Z'), reason: 'deploy' });
    const routes = makeRoutes(admission);
    const res = createMockRes();
    await routes.handleCapacity(createJsonReq('GET', '/api/v1/capacity'), res);
    const body = json(res);
    expect(body).toMatchObject({
      available: false,
      reason: 'draining',
      controlAvailable: true,
      heap: { usedBytes: 900 * MiB, limitBytes: 1000 * MiB, pressure: true, pressureFraction: 0.75, recoveryFraction: 0.65 },
      eventLoopLag: { pressure: true, thresholdMs: 300, recoveryMs: 150, sustainedReadings: 2, lastP99Ms: 800 },
      draining: { since: '2026-09-29T12:00:00.000Z', reason: 'deploy' },
      disposalLane: { inFlight: 0, queued: 0 },
    });
  });
});

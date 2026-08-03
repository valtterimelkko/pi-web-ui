import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { BoundedControlLane } from '../../../src/internal-api/control-lane.js';
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

  function makeRoutes(admissionController?: AdmissionController, controlLane?: BoundedControlLane) {
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
      admissionController,
      controlLane,
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
    expect(claudeService.pinSession).toHaveBeenCalledWith('claude-1', expect.stringMatching(/^internal-api:/));
  });

  it('creates a required resident retention lease independently and returns its lease id', async () => {
    const routes = makeRoutes();
    const req = createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'claude',
      retention: { mode: 'resident', ttlSeconds: 3600, ownerId: 'attempt-123' },
    });
    const res = createMockRes();
    await routes.handleCreateSession(req, res, 'claude-1');

    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      sessionId: 'claude-1',
      pinned: true,
      retention: { mode: 'resident', ownerId: 'attempt-123' },
    });
    expect(json(res).retention.leaseId).toEqual(expect.any(String));
    expect(claudeService.pinSession).toHaveBeenCalledWith('claude-1', expect.stringMatching(/^internal-api:/));
  });

  it('creates a durable lease without consuming runtime residency', async () => {
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'claude',
      retention: { mode: 'durable', ttlSeconds: 3600, ownerId: 'attempt-123' },
    }), res, 'claude-1');

    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({ pinned: false, retention: { mode: 'durable', ownerId: 'attempt-123' } });
    expect(json(res).pinnedUntil).toBeUndefined();
    expect(json(res).retention.leaseId).toEqual(expect.any(String));
    expect(claudeService.pinSession).not.toHaveBeenCalled();
  });

  it('atomically cleans up a newly-created session when required resident retention cannot be applied', async () => {
    claudeService.pinSession.mockReturnValue(false);
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'claude', retention: { mode: 'resident', ttlSeconds: 3600, ownerId: 'attempt-123' },
    }), res, 'claude-1');

    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('RETENTION_RESIDENT_CAPACITY_EXHAUSTED');
    expect(registry.delete).toHaveBeenCalledWith('claude-1');
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

  it('control acquire_retention adds an independently owned lease to an existing session', async () => {
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleSessionControl(createJsonReq('POST', '/x', {
      action: 'acquire_retention',
      retention: { mode: 'resident', ttlSeconds: 3600, ownerId: 'conductor-b' },
    }), res, 'claude-1');

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true, action: 'acquire_retention', retention: { mode: 'resident', ownerId: 'conductor-b' } });
    expect(json(res).retention.leaseId).toEqual(expect.any(String));
    expect(claudeService.pinSession).toHaveBeenCalledWith('claude-1', expect.stringMatching(/^internal-api:/));
  });

  it('control release_retention releases only the named lease', async () => {
    const routes = makeRoutes();
    const createRes = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'claude', retention: { mode: 'resident', ttlSeconds: 3600, ownerId: 'attempt-123' },
    }), createRes, 'claude-1');
    const leaseId = json(createRes).retention.leaseId;

    const releaseRes = createMockRes();
    await routes.handleSessionControl(createJsonReq('POST', '/x', {
      action: 'release_retention', retentionLeaseId: leaseId, ownerId: 'attempt-123',
    }), releaseRes, 'claude-1');

    expect(json(releaseRes)).toMatchObject({ success: true, action: 'release_retention', pinned: false });
    expect(claudeService.unpinSession).toHaveBeenCalledWith('claude-1', `internal-api:${leaseId}`);
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
    expect(claudeService.unpinSession).toHaveBeenCalledWith('claude-1', expect.stringMatching(/^internal-api:/));
  });

  it('legacy unpin leaves named retention leases intact', async () => {
    const routes = makeRoutes();
    const namedRes = createMockRes();
    await routes.handleSessionControl(createJsonReq('POST', '/x', {
      action: 'acquire_retention', retention: { mode: 'resident', ownerId: 'named-owner' },
    }), namedRes, 'claude-1');
    const namedLeaseId = json(namedRes).retention.leaseId;
    await routes.handleSessionControl(createJsonReq('POST', '/x', { action: 'pin' }), createMockRes(), 'claude-1');
    await routes.handleSessionControl(createJsonReq('POST', '/x', { action: 'unpin' }), createMockRes(), 'claude-1');

    expect(claudeService.unpinSession).not.toHaveBeenCalledWith('claude-1', `internal-api:${namedLeaseId}`);
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

  it('/info does not project a durable-only lease as a legacy pin deadline', async () => {
    const routes = makeRoutes();
    await routes.handleSessionControl(createJsonReq('POST', '/x', {
      action: 'acquire_retention', retention: { mode: 'durable', ownerId: 'durable-owner' },
    }), createMockRes(), 'claude-1');

    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/x'), infoRes, 'claude-1');
    expect(json(infoRes)).toMatchObject({ sessionId: 'claude-1', pinned: false });
    expect(json(infoRes).pinnedUntil).toBeUndefined();
  });

  it('exposes a bounded capacity snapshot and rejects prompt admission with Retry-After', async () => {
    const admission = new AdmissionController({
      maxActiveTurns: 2,
      interactiveReserve: 1,
      minimumHeadroomBytes: 1,
      reservedBytesPerTurn: 1,
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
    });
    const held = await admission.acquire('pi');
    const routes = makeRoutes(admission);

    const capacityRes = createMockRes();
    await routes.handleCapacity(createJsonReq('GET', '/api/v1/capacity'), capacityRes);
    expect(json(capacityRes)).toMatchObject({ available: false, activeTurns: 1, apiTurnLimit: 1, interactiveReserve: 1, controlAvailable: true });

    const promptRes = createMockRes();
    await routes.handleSendPrompt(createJsonReq('POST', '/x', { message: 'hello' }), promptRes, 'claude-1');
    expect(promptRes.statusCode).toBe(429);
    expect(json(promptRes)).toMatchObject({ code: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'global_limit' });
    expect(promptRes.setHeader).toHaveBeenCalledWith('Retry-After', '2');
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();

    // §11 invariant at the route level: while execution admission is saturated
    // (a P2 prompt is refused 429), a P1 control/read operation still succeeds
    // and does NOT touch execution admission (control bypasses it).
    const controlRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/x'), controlRes, 'claude-1');
    expect(controlRes.statusCode).toBe(200);
    expect(admission.snapshot().activeTurns).toBe(1); // control acquired nothing
    held.release();
  });

  it('control handlers acquire and release the bounded control lane', async () => {
    const lane = new BoundedControlLane(1, 5000, 4);
    const routes = makeRoutes(undefined, lane);
    let observedInFlight = 0;
    registry.get.mockImplementation(async () => {
      // Captured inside the handler body, which runs inside the lane (wrapControl).
      observedInFlight = lane.inFlight;
      return { id: 'claude-1', path: 'claude-1', sdkType: 'claude', cwd: '/root/proj', status: 'idle' };
    });
    await routes.handleGetSessionEvidence(createJsonReq('GET', '/x'), createMockRes(), 'claude-1');
    expect(observedInFlight).toBe(1); // the wrapped handler held the lane while running
    expect(lane.inFlight).toBe(0);    // and released it (try/finally, even on error)
  });

  it('control is refused at the critical memory floor (controlAvailable=false)', async () => {
    const admission = new AdmissionController({
      maxActiveTurns: 4, interactiveReserve: 1,
      memory: () => ({ currentBytes: 9_990, limitBytes: 10_000 }), // projected 9 < critical floor 25
      minimumHeadroomBytes: 100, reservedBytesPerTurn: 1,
    });
    const routes = makeRoutes(admission);
    const res = createMockRes();
    await routes.handleGetSessionEvidence(createJsonReq('GET', '/x'), res, 'claude-1');
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('CONTROL_CRITICAL');
  });

  it('a wrapped control op succeeds under P2 saturation without acquiring execution admission', async () => {
    const admission = new AdmissionController({
      maxActiveTurns: 3, interactiveReserve: 1, runtimeMaxActiveTurns: { claude: 3 },
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
      minimumHeadroomBytes: 1, reservedBytesPerTurn: 1,
    });
    const routes = makeRoutes(admission);
    registry.get.mockResolvedValue({ id: 'claude-1', path: 'claude-1', sdkType: 'claude', cwd: '/x', status: 'idle' });
    const a = await admission.acquire('claude', 'P2');
    const b = await admission.acquire('claude', 'P2'); // execution saturated (executionCapacity=2)
    const before = admission.snapshot().activeTurns;
    await routes.handleGetSessionEvidence(createJsonReq('GET', '/x'), createMockRes(), 'claude-1');
    expect(admission.snapshot().activeTurns).toBe(before); // control touched no execution slot
    a.release(); b.release();
  });

  it('cancel (handleAbort) works under active P2 saturation via the control lane, bypassing execution admission', async () => {
    const admission = new AdmissionController({
      maxActiveTurns: 3, interactiveReserve: 1, runtimeMaxActiveTurns: { claude: 3 },
      memory: () => ({ currentBytes: 0, limitBytes: 10_000 }),
      minimumHeadroomBytes: 1, reservedBytesPerTurn: 1,
    });
    const lane = new BoundedControlLane(8, 5000, 16);
    const routes = makeRoutes(admission, lane);
    let observedInFlight = 0;
    registry.get.mockImplementation(async () => {
      observedInFlight = lane.inFlight; // captured inside handleAbort's body, inside the lane
      return { id: 'claude-1', path: 'claude-1', sdkType: 'claude', cwd: '/x', status: 'running' };
    });
    // Saturate execution capacity with active P2 turns.
    const a = await admission.acquire('claude', 'P2');
    const b = await admission.acquire('claude', 'P2'); // executionCapacity=2 -> saturated
    const before = admission.snapshot().activeTurns;
    const res = createMockRes();
    await routes.handleAbort(createJsonReq('POST', '/x'), res, 'claude-1');
    expect(res.statusCode).toBe(200);                  // cancel completed
    expect(claudeService.abort).toHaveBeenCalledWith('claude-1'); // control regained
    expect(observedInFlight).toBe(1);                  // cancel ran inside the control lane
    expect(lane.inFlight).toBe(0);                     // and released it
    expect(admission.snapshot().activeTurns).toBe(before); // cancel acquired no execution slot
    a.release(); b.release();
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

  it('deleting a session clears its pin ledger record and releases the runtime pin slot', async () => {
    const routes = makeRoutes();
    await routes.handleSessionControl(
      createJsonReq('POST', '/x', { action: 'pin', pinTtlSeconds: 3600 }),
      createMockRes(),
      'claude-1',
    );
    await routes.handleDeleteSession(createJsonReq('DELETE', '/x'), createMockRes(), 'claude-1');

    expect(claudeService.unpinSession).toHaveBeenCalledWith('claude-1', expect.stringMatching(/^internal-api:/));

    // After delete, /info no longer reports a pinnedUntil for this session.
    claudeService.isSessionPinned.mockReturnValue(false);
    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/x'), infoRes, 'claude-1');
    expect(json(infoRes).pinnedUntil).toBeUndefined();
  });
});

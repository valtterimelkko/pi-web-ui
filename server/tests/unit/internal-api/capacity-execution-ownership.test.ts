/* eslint-disable @typescript-eslint/no-explicit-any -- route fixtures exercise heterogeneous runtime seams */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
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

function mockRes(options: { throwOnFirstSetHeader?: boolean } = {}): ServerResponse & {
  body: string;
  statusCode: number;
  headers: Record<string, unknown>;
} {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  let setHeaderCalls = 0;
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = vi.fn((name: string, value: unknown) => {
    setHeaderCalls += 1;
    if (options.throwOnFirstSetHeader && setHeaderCalls === 1) throw new Error('transport unavailable');
    headers[name.toLowerCase()] = value;
  }) as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.write = vi.fn((data: string | Buffer) => {
    chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res) as any;
  return res;
}

function disconnectableRes(): {
  res: ReturnType<typeof mockRes>;
  disconnect: () => void;
} {
  const res = mockRes();
  let closeHandler: (() => void) | undefined;
  res.on = vi.fn((event: string, handler: () => void) => {
    if (event === 'close') closeHandler = handler;
    return res;
  }) as any;
  return { res, disconnect: () => closeHandler?.() };
}

function claudeEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: id,
    sdkType: 'claude',
    cwd: '/tmp/capacity-execution-ownership',
    model: 'sonnet',
    firstMessage: 'fixture',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-09-07T00:00:00.000Z',
    lastActivity: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

type EventObserver = (event: any) => void;

type AdmissionStub = {
  acquire: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
};

function boundedAdmission(): AdmissionController {
  return new AdmissionController({
    maxActiveTurns: 3,
    interactiveReserve: 1,
    runtimeMaxActiveTurns: { claude: 2 },
    minimumHeadroomBytes: 1,
    memoryCriticalBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    memory: () => ({ currentBytes: 0, limitBytes: 10_000, source: 'service' }),
    readPids: () => ({ current: 0, max: 100, source: 'service' }),
    host: () => ({ memAvailableBytes: 10_000, source: 'host' }),
    readMemoryEvents: () => undefined,
  });
}

function admissionStub(release: ReturnType<typeof vi.fn>): AdmissionStub {
  return {
    acquire: vi.fn(async () => ({ release })),
    snapshot: vi.fn(() => ({ controlAvailable: true, retryAfterSeconds: 1 })),
  };
}

interface HarnessOptions {
  admission?: AdmissionController | AdmissionStub;
  isRuntimeQuiescent?: (sessionId: string) => Promise<boolean>;
  turnIdleTimeoutMs?: number;
  entries?: Record<string, Record<string, unknown>>;
  initiallyRunning?: string[];
  sendPrompt?: (sessionId: string, onEvent: EventObserver, onComplete: (error?: Error) => void) => Promise<void>;
}

function makeHarness(options: HarnessOptions = {}) {
  const dirPromise = fs.mkdtemp(path.join(os.tmpdir(), 'pi-capacity-execution-ownership-'));
  let dir: string;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let primaryResolve: (() => void) | undefined;
  let primaryOnEvent: EventObserver | undefined;
  let primaryOnComplete: ((error?: Error) => void) | undefined;
  const running = new Set(options.initiallyRunning ?? []);
  const observers = new Map<string, Set<EventObserver>>();
  const admission = options.admission ?? boundedAdmission();
  const entries = new Map<string, Record<string, unknown>>(
    Object.entries(options.entries ?? {
      primary: claudeEntry('primary'),
      sibling: claudeEntry('sibling'),
      'batch-sibling': claudeEntry('batch-sibling'),
    }),
  );

  const registry = {
    get: vi.fn(async (sessionId: string) => entries.get(sessionId)),
    listAll: vi.fn(async () => [...entries.values()]),
    delete: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    patchSessionMeta: vi.fn().mockResolvedValue(undefined),
  };

  const claudeService: any = {
    isRunning: vi.fn((sessionId: string) => running.has(sessionId)),
    getBackendMode: vi.fn(async () => 'sdk'),
    addApiObserver: vi.fn((sessionId: string, observer: EventObserver) => {
      const set = observers.get(sessionId) ?? new Set<EventObserver>();
      set.add(observer);
      observers.set(sessionId, set);
    }),
    removeApiObserver: vi.fn((sessionId: string, observer: EventObserver) => {
      observers.get(sessionId)?.delete(observer);
    }),
    steer: vi.fn(() => true),
    abort: vi.fn(),
    sendPrompt: vi.fn(async (
      sessionId: string,
      _message: string,
      onEvent: EventObserver,
      onComplete: (error?: Error) => void,
    ) => {
      if (options.sendPrompt) return options.sendPrompt(sessionId, onEvent, onComplete);
      if (sessionId === 'primary') {
        running.add(sessionId);
        primaryOnEvent = onEvent;
        primaryOnComplete = onComplete;
        await new Promise<void>((resolve) => { primaryResolve = resolve; });
        running.delete(sessionId);
        onComplete();
        return;
      }
      running.add(sessionId);
      onEvent({ type: 'agent_start', sessionId, timestamp: Date.now(), data: {} });
      onEvent({
        type: 'message_update',
        sessionId,
        timestamp: Date.now(),
        data: { assistantMessageEvent: { type: 'text_delta', delta: `reply-${sessionId}` } },
      });
      onEvent({ type: 'agent_end', sessionId, timestamp: Date.now(), data: {} });
      running.delete(sessionId);
      onComplete();
    }),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getContextUsage: vi.fn().mockResolvedValue(null),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  const multiSessionManager: any = {
    getAgentSession: vi.fn(() => undefined),
    getSessionStatus: vi.fn(() => ({ status: 'idle' })),
    subscribeClient: vi.fn().mockResolvedValue(undefined),
    unsubscribeClient: vi.fn().mockResolvedValue(undefined),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
  };

  const setup = (async () => {
    dir = await dirPromise;
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir),
      idFactory: (() => {
        let next = 0;
        return () => `capacity-run-${++next}`;
      })(),
      turnIdleTimeoutMs: options.turnIdleTimeoutMs ?? 60_000,
      isRuntimeQuiescent: options.isRuntimeQuiescent,
      drainPollMs: 5,
      drainTimeoutMs: 10_000,
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false), isEnabled: vi.fn(() => true), abort: vi.fn() } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager: multiSessionManager as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry as any,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) } as any,
      internalClientId: 'capacity-test',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: manager,
      admissionController: admission as any,
    });
  })();

  const completePrimary = (): void => {
    primaryOnComplete?.();
    primaryOnComplete = undefined;
    primaryResolve?.();
    primaryResolve = undefined;
  };

  return {
    ready: setup,
    get routes() { return routes; },
    get manager() { return manager; },
    claudeService,
    admission,
    observers,
    emitPrimaryEvent: (event: any) => {
      primaryOnEvent?.(event);
      for (const observer of [...(observers.get('primary') ?? [])]) observer(event);
    },
    completePrimary,
    running,
    async cleanup() {
      await setup;
      completePrimary();
      for (const observer of [...(observers.get('primary') ?? [])]) {
        // A joined receipt may be waiting for its turn boundary in a test that
        // deliberately leaves the runtime running.
        observer({ type: 'agent_end', sessionId: 'primary', timestamp: Date.now(), data: {} });
      }
      await manager.shutdown();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    },
  };
}

describe('capacity execution ownership on actual Internal API routes', () => {
  const harnesses: Array<ReturnType<typeof makeHarness>> = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  it('keeps a busy joined steer at one execution permit and leaves a sibling admissible through direct and batch routes', async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    await harness.ready;

    const primaryResponse = mockRes();
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'primary work', detach: true }),
      primaryResponse,
      'primary',
    );
    await vi.waitFor(() => expect(harness.claudeService.sendPrompt).toHaveBeenCalledWith(
      'primary',
      'primary work',
      expect.any(Function),
      expect.any(Function),
    ));

    const steerResponse = mockRes();
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'change direction', mode: 'steer', detach: true }),
      steerResponse,
      'primary',
    );
    await vi.waitFor(() => expect(harness.claudeService.steer).toHaveBeenCalledWith('primary', 'change direction'));

    const admission = harness.admission as AdmissionController;
    expect(admission.snapshot().classes.P2.active).toBe(1);
    expect(JSON.parse(steerResponse.body)).toMatchObject({ status: 'accepted', mode: 'steer', dispatchMode: 'steer' });

    const siblingResponse = mockRes();
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/sibling/prompt', { message: 'sibling work' }),
      siblingResponse,
      'sibling',
    );
    expect(siblingResponse.statusCode).toBe(200);
    expect(JSON.parse(siblingResponse.body)).toMatchObject({ turnComplete: true, sessionId: 'sibling' });

    const batchResponse = mockRes();
    await harness.routes.handleBatchPrompt(
      jsonReq('POST', '/api/v1/sessions/batch/prompt', {
        prompts: [{ sessionId: 'batch-sibling', message: 'batch sibling work' }],
      }),
      batchResponse,
    );
    expect(batchResponse.statusCode).toBe(200);
    expect(JSON.parse(batchResponse.body)).toMatchObject({ successCount: 1, failedCount: 0 });
  });

  it('publishes one broker event when a joined Claude steer observes an event already published by the primary API turn', async () => {
    const harness = makeHarness();
    harnesses.push(harness);
    await harness.ready;

    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'primary work', detach: true }),
      mockRes(),
      'primary',
    );
    await vi.waitFor(() => expect(harness.claudeService.sendPrompt).toHaveBeenCalled());
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'joined steer', mode: 'steer', detach: true }),
      mockRes(),
      'primary',
    );
    await vi.waitFor(() => expect(harness.claudeService.steer).toHaveBeenCalled());

    const event = {
      type: 'message_update',
      sessionId: 'primary',
      timestamp: Date.now(),
      data: { marker: 'one-underlying-event', assistantMessageEvent: { type: 'text_delta', delta: 'joined' } },
    };
    harness.emitPrimaryEvent(event);

    const snapshot = mockRes();
    await harness.routes.handleSessionEvents(
      jsonReq('GET', '/api/v1/sessions/primary/events?mode=snapshot'),
      snapshot,
      'primary',
      new URLSearchParams([['mode', 'snapshot']]),
    );
    const events = JSON.parse(snapshot.body).events.filter((candidate: any) => candidate.data?.marker === event.data.marker);
    expect(events).toHaveLength(1);
  });

  it('does not let a disconnected joined steer abort the underlying turn', async () => {
    const harness = makeHarness({ initiallyRunning: ['primary'] });
    harnesses.push(harness);
    await harness.ready;

    const streaming = disconnectableRes();
    const request = harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'observe the joined turn', mode: 'steer', verbosity: 'full' }),
      streaming.res,
      'primary',
    );
    await vi.waitFor(() => expect(harness.claudeService.steer).toHaveBeenCalledWith('primary', 'observe the joined turn'));
    streaming.disconnect();
    await vi.waitFor(() => expect(harness.manager.listBySession('primary')).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'cancelled', dispatchMode: 'steer' })]),
    ));

    expect(harness.claudeService.abort).not.toHaveBeenCalled();
    harness.emitPrimaryEvent({ type: 'agent_end', sessionId: 'primary', timestamp: Date.now(), data: {} });
    await request;
  });

  it('does not let a timed-out joined steer abort or observe a later turn', async () => {
    const harness = makeHarness({ initiallyRunning: ['primary'], turnIdleTimeoutMs: 20 });
    harnesses.push(harness);
    await harness.ready;

    const response = mockRes();
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'monitor this turn', mode: 'steer', detach: true }),
      response,
      'primary',
    );
    const runId = JSON.parse(response.body).runId as string;
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(harness.manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'TURN_STALLED' });
    expect(harness.manager.getDrainingCount()).toBe(0);
    expect(harness.claudeService.abort).not.toHaveBeenCalled();
    expect(harness.claudeService.removeApiObserver).toHaveBeenCalledTimes(2);
  });

  it('leaves a failed uncertain run fenced when the receipt manager owns the admission lease', async () => {
    const release = vi.fn();
    const harness = makeHarness({
      admission: admissionStub(release),
      isRuntimeQuiescent: async () => false,
      sendPrompt: async (_sessionId, _onEvent, onComplete) => {
        onComplete(new Error('runtime failed before cessation acknowledgement'));
      },
    });
    harnesses.push(harness);
    await harness.ready;

    const response = mockRes();
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'fail uncertainly' }),
      response,
      'primary',
    );
    const runId = JSON.parse(response.body).runId as string;

    expect(response.statusCode).toBe(500);
    expect(harness.manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_ERROR' });
    expect(harness.manager.getDrainingCount()).toBe(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('releases a lease once for a failure before runtime dispatch without retaining drain debt', async () => {
    const release = vi.fn();
    const harness = makeHarness({
      admission: admissionStub(release),
      isRuntimeQuiescent: async () => false,
    });
    harnesses.push(harness);
    await harness.ready;

    const response = mockRes({ throwOnFirstSetHeader: true });
    await harness.routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/primary/prompt', { message: 'transport setup failure', verbosity: 'full' }),
      response,
      'primary',
    );
    const runId = JSON.parse(response.body).runId as string;

    expect(response.statusCode).toBe(500);
    expect(harness.claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(harness.manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_ERROR' });
    expect(harness.manager.getDrainingCount()).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

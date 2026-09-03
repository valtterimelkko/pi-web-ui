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

const INTENDED = 'commandcode/meta/muse-spark-1.3-contributor';

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
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; });
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  });
  res.getHeader = vi.fn();
  return res;
}

function json(res: { body: string }): any {
  return JSON.parse(res.body);
}

/**
 * Agent session mock whose model/thinkingLevel state is mutable, simulating
 * both sides of the incident: a rehydrated session that starts on the runtime
 * default (zai/glm-5.3 + high) and a setModel that re-binds it.
 */
function createAgentSessionMock(overrides: {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  /** Simulate a model clamp: the applied level differs from the requested one. */
  clampThinkingLevelTo?: string;
} = {}) {
  const state = {
    provider: overrides.provider ?? 'zai',
    id: overrides.modelId ?? 'glm-5.3',
    thinkingLevel: overrides.thinkingLevel ?? 'high',
  };
  const session: any = {
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.jsonl',
    prompt: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    get model() {
      return state.provider ? { provider: state.provider, id: state.id } : null;
    },
    get thinkingLevel() {
      return state.thinkingLevel;
    },
    setThinkingLevel: vi.fn((level: string) => {
      state.thinkingLevel = overrides.clampThinkingLevelTo ?? level;
    }),
    /** Test hook: simulate a successful piService.setModel read-back. */
    __setLiveModel: (provider: string, modelId: string) => {
      state.provider = provider;
      state.id = modelId;
    },
  };
  return session;
}

describe('Pi model binding durability across rehydration (contract 1.33.0)', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;
  let agentSession: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let now: number;
  const intervals: NodeJS.Timeout[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-model-binding-'));
    now = Date.parse('2026-09-03T20:00:00.000Z');
    agentSession = createAgentSessionMock();
    registry = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        path: sessionId,
        sdkType: 'pi',
        cwd: '/root/proj',
        model: INTENDED,
        thinkingLevel: 'xhigh',
        firstMessage: '',
        messageCount: 0,
        status: 'idle',
        createdAt: '2026-09-03T19:00:00.000Z',
        lastActivity: '2026-09-03T19:00:00.000Z',
      })),
      listAll: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(),
      createSession: vi.fn(async () => ({ sessionId: 'claude-1' })),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      isEnabled: vi.fn(() => true),
      createSession: vi.fn(async () => 'oc-1'),
      setModel: vi.fn().mockResolvedValue(undefined),
      setThinkingLevel: vi.fn().mockResolvedValue(undefined),
      disposeSession: vi.fn(),
    };
    antigravityService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
    };
    multiSessionManager = {
      createAndSubscribe: vi.fn(async () => ({ sessionId: 'pi-new', sessionPath: path.join(dir, 'pi-new') })),
      getAgentSession: vi.fn(() => agentSession),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      disposeLoadedSession: vi.fn(),
      getAllSessionStatuses: vi.fn(() => []),
    };
    // setModel mutates the mock session's live model, mirroring the real
    // read-back-verified piService.setModel. The depth guard is the deadlock
    // regression pin (contract 1.33.0): the re-bind must run OUTSIDE the
    // shared withSessionModelLock lease — the real piService takes the
    // exclusive model-change lock inside setModel, and calling it under the
    // shared lease self-deadlocks (caught by live validation, not mocks).
    let modelLockDepth = 0;
    piService = {
      setModel: vi.fn(async (_sessionId: string, modelId: string) => {
        if (modelLockDepth > 0) {
          throw new Error('DEADLOCK: setModel called while holding the shared model lease');
        }
        const [provider, ...rest] = modelId.split('/');
        if (provider === 'gone') throw new Error(`Model not found: ${modelId}`);
        agentSession.__setLiveModel(provider, rest.join('/'));
      }),
      withSessionModelLock: vi.fn(async (_sessionId: string, operation: () => Promise<unknown>) => {
        modelLockDepth += 1;
        try {
          return await operation();
        } finally {
          modelLockDepth -= 1;
        }
      }),
    };
  });

  afterEach(async () => {
    intervals.splice(0).forEach(clearInterval);
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes(deps: Partial<SessionRoutesDeps> = {}) {
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    routes = createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
      runReceiptManager: manager,
      ...deps,
    });
    return routes;
  }

  /** Fire agent_end from every attached observer so detached turns complete. */
  function completeTurnOnObserverAttach(): void {
    multiSessionManager.addApiObserver.mockImplementation((_path: string, observer: (event: any) => void) => {
      process.nextTick(() => {
        observer({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} });
      });
    });
  }

  async function dispatchDetached(): Promise<{ status: number; body: any }> {
    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', {
      message: 'run the benchmark task',
      detach: true,
      idempotencyKey: `bind-${Math.random().toString(36).slice(2)}`,
    });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');
    return { status: res.statusCode, body: json(res) };
  }

  // ── C1: create persists the binding ──────────────────────────────────────

  it('create with model + thinkingLevel persists both to the registry after a successful bind', async () => {
    makeRoutes();
    const res = mockRes();
    await routes.handleCreateSession(jsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/root/proj', model: INTENDED, thinkingLevel: 'xhigh',
    }), res, 'create-1');

    expect(res.statusCode).toBe(201);
    expect(registry.patchSessionMeta).toHaveBeenCalledWith('pi-new', {
      model: INTENDED,
      thinkingLevel: 'xhigh',
    });
  });

  it('create with a model but no thinkingLevel persists only the model', async () => {
    makeRoutes();
    const res = mockRes();
    await routes.handleCreateSession(jsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/root/proj', model: INTENDED,
    }), res, 'create-2');

    expect(res.statusCode).toBe(201);
    expect(registry.patchSessionMeta).toHaveBeenCalledWith('pi-new', { model: INTENDED });
  });

  // ── C3+C5: dispatch re-binds from the registry and reports served truth ──

  it('dispatch to a rehydrated session re-applies the binding before prompting and records servedModel', async () => {
    makeRoutes();
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    expect(body.detached).toBe(true);
    await manager.waitForTerminal(body.runId);

    // The drift was corrected on the live session before any prompt ran.
    expect(piService.setModel).toHaveBeenCalledWith('session-1', INTENDED);
    expect(agentSession.setThinkingLevel).toHaveBeenCalledWith('xhigh');
    expect(piService.setModel.mock.invocationCallOrder[0])
      .toBeLessThan(agentSession.prompt.mock.invocationCallOrder[0]);
    expect(agentSession.prompt).toHaveBeenCalledTimes(1);

    const receipt = manager.get(body.runId);
    expect(receipt?.servedModel).toBe(INTENDED);
    expect(receipt?.modelRebound).toBe(true);
  });

  it('dispatch publishes a model_rebound broker event visible via the events snapshot', async () => {
    makeRoutes();
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    await manager.waitForTerminal(body.runId);

    const snapRes = mockRes();
    await routes.handleSessionEvents(
      jsonReq('GET', '/api/v1/sessions/session-1/events?mode=snapshot'),
      snapRes,
      'session-1',
      new URLSearchParams('mode=snapshot'),
    );
    expect(snapRes.statusCode).toBe(200);
    const events = json(snapRes).events as Array<{ type: string; data: any }>;
    const rebound = events.find((e) => e.type === 'model_rebound');
    expect(rebound).toBeDefined();
    expect(rebound?.data).toMatchObject({ intended: INTENDED, served: INTENDED, thinkingLevel: 'xhigh' });
  });

  it('dispatch with a matching live model performs no rebind', async () => {
    registry.get.mockImplementation(async (sessionId: string) => ({
      id: sessionId, path: sessionId, sdkType: 'pi', cwd: '/root/proj',
      model: 'zai/glm-5.3', firstMessage: '', messageCount: 0, status: 'idle',
      createdAt: '2026-09-03T19:00:00.000Z', lastActivity: '2026-09-03T19:00:00.000Z',
    }));
    makeRoutes();
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    await manager.waitForTerminal(body.runId);

    expect(piService.setModel).not.toHaveBeenCalled();
    expect(agentSession.prompt).toHaveBeenCalledTimes(1);
    const receipt = manager.get(body.runId);
    expect(receipt?.servedModel).toBe('zai/glm-5.3');
    expect(receipt?.modelRebound).toBe(false);
  });

  it('dispatch with no stored binding keeps legacy behaviour and records the live model', async () => {
    registry.get.mockImplementation(async (sessionId: string) => ({
      id: sessionId, path: sessionId, sdkType: 'pi', cwd: '/root/proj',
      firstMessage: '', messageCount: 0, status: 'idle',
      createdAt: '2026-09-03T19:00:00.000Z', lastActivity: '2026-09-03T19:00:00.000Z',
    }));
    makeRoutes();
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    await manager.waitForTerminal(body.runId);

    expect(piService.setModel).not.toHaveBeenCalled();
    expect(agentSession.prompt).toHaveBeenCalledTimes(1);
    const receipt = manager.get(body.runId);
    expect(receipt?.servedModel).toBe('zai/glm-5.3');
    expect(receipt?.modelRebound).toBe(false);
  });

  // ── C4: loud failure, never silent default ───────────────────────────────

  it('unresolvable stored binding fails the run with MODEL_NOT_APPLIED and never prompts', async () => {
    registry.get.mockImplementation(async (sessionId: string) => ({
      id: sessionId, path: sessionId, sdkType: 'pi', cwd: '/root/proj',
      model: 'gone/missing-model', thinkingLevel: 'xhigh',
      firstMessage: '', messageCount: 0, status: 'idle',
      createdAt: '2026-09-03T19:00:00.000Z', lastActivity: '2026-09-03T19:00:00.000Z',
    }));
    makeRoutes();
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    await vi.waitFor(() => {
      expect(manager.get(body.runId)?.status).toBe('failed');
    });

    const receipt = manager.get(body.runId);
    expect(receipt?.errorCode).toBe('MODEL_NOT_APPLIED');
    expect(agentSession.prompt).not.toHaveBeenCalled();
    expect(receipt?.servedModel).toBeUndefined();
  });

  it('blocked-provider stored binding fails with PROVIDER_NOT_ALLOWED and never prompts', async () => {
    makeRoutes({ blockedPiProviders: ['commandcode'] });
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    await vi.waitFor(() => {
      expect(manager.get(body.runId)?.status).toBe('failed');
    });

    const receipt = manager.get(body.runId);
    expect(receipt?.errorCode).toBe('PROVIDER_NOT_ALLOWED');
    expect(piService.setModel).not.toHaveBeenCalled();
    expect(agentSession.prompt).not.toHaveBeenCalled();
  });

  // ── C2: control rebinds persist ──────────────────────────────────────────

  it('control set_model on a pi session persists the binding', async () => {
    makeRoutes();
    const res = mockRes();
    await routes.handleSessionControl(jsonReq('POST', '/control', {
      action: 'set_model', modelId: INTENDED,
    }), res, 'session-1');

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true, action: 'set_model' });
    expect(registry.patchSessionMeta).toHaveBeenCalledWith('session-1', { model: INTENDED });
  });

  it('control set_thinking_level persists the clamped read-back level', async () => {
    agentSession = createAgentSessionMock({ clampThinkingLevelTo: 'high' });
    makeRoutes();
    const res = mockRes();
    await routes.handleSessionControl(jsonReq('POST', '/control', {
      action: 'set_thinking_level', level: 'max',
    }), res, 'session-1');

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true, action: 'set_thinking_level', level: 'high' });
    expect(registry.patchSessionMeta).toHaveBeenCalledWith('session-1', { thinkingLevel: 'high' });
  });

  // ── C5: receipt manager surface ──────────────────────────────────────────

  it('recordServedModel persists served model truth and no-ops for unknown runs', async () => {
    makeRoutes();
    completeTurnOnObserverAttach();
    const { body } = await dispatchDetached();
    await manager.waitForTerminal(body.runId);

    const updated = await manager.recordServedModel(body.runId, INTENDED, true);
    expect(updated?.servedModel).toBe(INTENDED);
    expect(updated?.modelRebound).toBe(true);
    expect(manager.get(body.runId)?.servedModel).toBe(INTENDED);

    const unknown = await manager.recordServedModel('run-does-not-exist', INTENDED, true);
    expect(unknown).toBeUndefined();
  });
});

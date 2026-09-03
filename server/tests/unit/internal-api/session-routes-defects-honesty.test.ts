import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { deriveRunWorkState } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';

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

describe('Internal API orchestration honesty (contract 1.25.0 defect fixes)', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;
  let commandCodeService: any;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-honesty-routes-'));

    registry = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        path: sessionId,
        sdkType: 'pi',
        cwd: '/root/proj',
        model: 'zai/glm-5.3',
        firstMessage: '',
        messageCount: 0,
        status: 'idle',
        createdAt: '2026-08-25T00:00:00.000Z',
        lastActivity: '2026-08-25T00:00:00.000Z',
      })),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };

    claudeService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      hasSession: vi.fn(() => true),
      createSession: vi.fn(async () => ({ sessionId: 'claude-1' })),
      setModel: vi.fn().mockResolvedValue('sonnet'),
      getProfiles: vi.fn(() => []),
      sendPrompt: vi.fn(),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('direct'),
      getReplayEvents: vi.fn().mockResolvedValue([]),
      abort: vi.fn(),
    };
    opencodeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      hasSession: vi.fn(() => true),
      isEnabled: vi.fn(() => true),
      createSession: vi.fn(async () => 'oc-1'),
      setModel: vi.fn().mockResolvedValue(undefined),
      setThinkingLevel: vi.fn().mockResolvedValue(undefined),
      disposeSession: vi.fn(),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn(() => null),
      isSessionPinned: vi.fn(() => false),
      getReplayEvents: vi.fn().mockResolvedValue([]),
    };
    antigravityService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      hasSession: vi.fn(() => true),
      getReplayEvents: vi.fn().mockResolvedValue([]),
    };
    multiSessionManager = {
      createAndSubscribe: vi.fn(async () => ({ sessionId: 'pi-new', sessionPath: path.join(dir, 'pi-new') })),
      getAgentSession: vi.fn(() => ({
        model: { provider: 'zai', id: 'glm-5.3' },
        sessionId: 'pi-native',
        sessionFile: path.join(dir, 'pi-new', 'session.jsonl'),
        getSessionStats: () => ({ tokens: { input: 0, output: 0 }, cost: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0 }),
        getContextUsage: () => ({ contextWindow: 200000, tokens: 0, percent: 0 }),
      })),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      hasSession: vi.fn(() => true),
      disposeLoadedSession: vi.fn(),
      isSessionPinned: vi.fn(() => false),
      unsubscribeClient: vi.fn(),
    };
    piService = { setModel: vi.fn().mockResolvedValue(undefined) };
    commandCodeService = undefined;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes() {
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
      pinExpiryIntervalMs: 60_000,
    });
  }

  // ── §1: model binding must never silently fall back ──────────────────────

  it('returns 422 MODEL_NOT_APPLIED and cleans up when the requested Pi model cannot be applied', async () => {
    piService.setModel.mockRejectedValue(new Error('Invalid model ID format: gpt-5.6-sol. Expected "provider/model-name"'));
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/root/proj', model: 'gpt-5.6-sol',
    }), res, 'run-1');

    expect(res.statusCode).toBe(422);
    expect(json(res).code).toBe('MODEL_NOT_APPLIED');
    // No half-created session may survive.
    expect(multiSessionManager.disposeLoadedSession).toHaveBeenCalled();
    expect(registry.delete).toHaveBeenCalledWith('pi-new');
  });

  it('reports the actually-bound model as resolvedModel on Pi create success', async () => {
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/root/proj', model: 'zai/glm-5.3',
    }), res, 'run-2');

    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.resolvedModel).toBe('zai/glm-5.3');
    expect(body.modelBinding).toMatchObject({ requested: 'zai/glm-5.3', resolved: 'zai/glm-5.3', fallbackApplied: false });
  });

  it('labels the binding as a fallback when no model was requested and reports what bound', async () => {
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/root/proj',
    }), res, 'run-3');

    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.resolvedModel).toBe('zai/glm-5.3');
    expect(body.modelBinding.fallbackApplied).toBe(true);
    expect(body.modelBinding.resolved).toBe('zai/glm-5.3');
  });

  it('returns 422 MODEL_NOT_APPLIED when OpenCode refuses the requested model', async () => {
    opencodeService.setModel.mockRejectedValue(new Error('model not found'));
    // The created session resolves through the registry as an OpenCode session.
    registry.get = vi.fn(async (id: string) => ({
      id, path: id, sdkType: 'opencode', cwd: '/root/proj', model: 'nope/missing',
      firstMessage: '', messageCount: 0, status: 'idle',
      createdAt: '2026-08-25T00:00:00.000Z', lastActivity: '2026-08-25T00:00:00.000Z',
    }));
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'opencode', cwd: '/root/proj', model: 'nope/missing',
    }), res, 'run-4');

    expect(res.statusCode).toBe(422);
    expect(json(res).code).toBe('MODEL_NOT_APPLIED');
    expect(registry.delete).toHaveBeenCalled();
  });

  // ── §2: /info must answer "is this session protected, until when?" ───────

  it('surfaces the durable retention lease on GET /sessions/:id/info', async () => {
    const routes = makeRoutes();
    // Create with required durable retention (same flow the consumer used).
    const createRes = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'claude', cwd: '/root/proj', retention: { mode: 'durable', ttlSeconds: 28_800, ownerId: 'orchestrator' },
    }), createRes, 'run-5');
    expect(createRes.statusCode).toBe(201);
    const leaseId = json(createRes).retention.leaseId;
    expect(leaseId).toEqual(expect.any(String));

    // The very next /info must agree with the create response.
    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', `/api/v1/sessions/${json(createRes).sessionId}`), infoRes, json(createRes).sessionId);

    expect(infoRes.statusCode).toBe(200);
    const detail = json(infoRes);
    expect(detail.retention).toBeDefined();
    expect(detail.retention.protected).toBe(true);
    expect(detail.retention.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ leaseId, mode: 'durable' }),
    ]));
    expect(detail.retention.latestExpiryAt).toEqual(expect.any(String));
  });

  // ── §6: dependable per-session liveness ──────────────────────────────────

  it('reports a demonstrably-busy Pi session as running/busy on /info instead of stale idle', async () => {
    multiSessionManager.getSessionStatus = vi.fn(() => ({ status: 'busy' }));
    const routes = makeRoutes();
    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/api/v1/sessions/pi-1'), infoRes, 'pi-1');

    expect(infoRes.statusCode).toBe(200);
    expect(json(infoRes).status).toBe('running');
    expect(json(infoRes).busy).toBe(true);
  });

  it('marks idle sessions as not busy on /info', async () => {
    const routes = makeRoutes();
    const infoRes = createMockRes();
    await routes.handleGetSessionInfo(createJsonReq('GET', '/api/v1/sessions/pi-1'), infoRes, 'pi-1');

    expect(json(infoRes).status).toBe('idle');
    expect(json(infoRes).busy).toBe(false);
  });

  // ── §8: transcript limit must be honoured ────────────────────────────────

  it('honours a caller-supplied limit larger than the recent window', async () => {
    const events = Array.from({ length: 30 }, (_, i) => ([
      {
        type: 'message_start',
        sessionId: 'ag-1',
        timestamp: Date.now() + i,
        message: { id: `m-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: '' },
      },
      {
        type: 'message_end',
        sessionId: 'ag-1',
        timestamp: Date.now() + i + 0.5,
        message: { id: `m-${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` },
      },
    ])).flat();
    antigravityService.getReplayEvents.mockResolvedValue(events);

    const routes = makeRoutes();
    registry.get = vi.fn(async (id: string) => ({
      id, path: id, sdkType: 'antigravity', cwd: '/root/proj', firstMessage: '',
      messageCount: 0, status: 'idle',
      createdAt: '2026-08-25T00:00:00.000Z', lastActivity: '2026-08-25T00:00:00.000Z',
    }));

    // Without limit: historical behaviour — capped at 20.
    const defaultRes = createMockRes();
    await routes.handleSessionTranscript(createJsonReq('GET', '/api/v1/sessions/ag-1/transcript'), defaultRes, 'ag-1', new URLSearchParams());
    expect(json(defaultRes).itemCount).toBe(20);

    // With limit=30: all 30 items are returned.
    const limitedRes = createMockRes();
    await routes.handleSessionTranscript(createJsonReq('GET', '/api/v1/sessions/ag-1/transcript?limit=30'), limitedRes, 'ag-1', new URLSearchParams('limit=30'));
    const limited = json(limitedRes);
    expect(limited.itemCount).toBe(30);
    expect(limited.limit).toBe(30);
  });

  it('caps the transcript limit to a sane maximum and rejects junk', async () => {
    const routes = makeRoutes();

    const junkRes = createMockRes();
    await routes.handleSessionTranscript(createJsonReq('GET', '/api/v1/sessions/ag-1/transcript?limit=banana'), junkRes, 'ag-1', new URLSearchParams('limit=banana'));
    expect(junkRes.statusCode).toBe(400);

    const hugeRes = createMockRes();
    await routes.handleSessionTranscript(createJsonReq('GET', '/api/v1/sessions/ag-1/transcript?limit=99999'), hugeRes, 'ag-1', new URLSearchParams('limit=99999'));
    expect(hugeRes.statusCode).toBe(400);
  });

  // ── §5: headline run status must distinguish turn-end from work-finish ───

  describe('deriveRunWorkState', () => {
    it('keeps completed only when cessation is confirmed', () => {
      expect(deriveRunWorkState('completed', { state: 'confirmed', basis: 'terminal_signal', observedAt: 'x' })).toBe('completed');
    });

    it('flags turn-ended-but-work-unconfirmed rather than claiming completed', () => {
      expect(deriveRunWorkState('completed', { state: 'unconfirmed', basis: 'terminal_signal', observedAt: 'x' })).toBe('turn_ended_unconfirmed');
      expect(deriveRunWorkState('completed', { state: 'unknown', basis: 'no_terminal_signal', observedAt: 'x' })).toBe('turn_ended_unconfirmed');
    });

    it('maps non-terminal and failure states honestly', () => {
      expect(deriveRunWorkState('accepted', undefined)).toBe('running');
      expect(deriveRunWorkState('started', undefined)).toBe('running');
      expect(deriveRunWorkState('failed', undefined)).toBe('failed');
      expect(deriveRunWorkState('cancelled', undefined)).toBe('cancelled');
    });
  });
});

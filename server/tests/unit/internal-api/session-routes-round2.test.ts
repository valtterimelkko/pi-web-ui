import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = url;
  (req as { headers?: Record<string, string> }).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) (req as PassThrough).emit('data', Buffer.from(JSON.stringify(body)));
    (req as PassThrough).emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { statusCode: number; written: string[]; ended: boolean; status: number } {
  const state = { statusCode: 200, written: [] as string[], ended: false, status: 0 };
  const res = new Writable({
    write(chunk: Buffer, _enc: unknown, cb: (e?: Error | null) => void) {
      state.written.push(String(chunk));
      cb();
    },
  }) as unknown as ServerResponse & typeof state;
  Object.assign(res, state);
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.status = code; return res; }) as never;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data !== undefined) res.written.push(typeof data === 'string' ? data : String(data));
    res.ended = true;
    return res;
  }) as never;
  res.on = vi.fn(() => res) as never;
  res.getHeader = vi.fn();
  return res;
}

function jsonOf(res: { written: string[] }): any {
  return JSON.parse(res.written.filter((c) => c.trim().startsWith('{')).join(''));
}

const mkEntry = (id: string) => ({
  id,
  path: id,
  sdkType: 'pi',
  cwd: '/tmp',
  firstMessage: '',
  messageCount: 0,
  status: 'idle',
  createdAt: '',
  lastActivity: '',
});

describe('Round-2 defect fixes (contract 1.26.0)', () => {
  let dir: string;
  let registry: Record<string, ReturnType<typeof vi.fn>>;
  let multiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
  let piService: Record<string, ReturnType<typeof vi.fn>>;
  let routes: ReturnType<typeof createSessionRoutes>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-round2-routes-'));
    registry = {
      get: vi.fn().mockResolvedValue(mkEntry('pi-1')),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockResolvedValue([]),
    };
    multiSessionManager = {
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      createAndSubscribe: vi.fn(async () => ({ sessionId: 'pi-new', sessionPath: path.join(dir, 'pi-new') })),
      getAgentSession: vi.fn(() => ({
        model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
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
    piService = {
      setModel: vi.fn().mockResolvedValue(undefined),
      getAvailableModels: vi.fn().mockResolvedValue([
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex', contextWindow: 372000 },
        { id: 'glm-5.3', name: 'GLM-5.3', provider: 'zai', contextWindow: 200000 },
      ]),
    };
    routes = createSessionRoutes({
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: registry as never,
      piService: piService as never,
      internalClientId: 'test',
      watchDir: dir,
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  // ── §1: bare model ids that resolve unambiguously must bind again ────────

  it('§1 resolves an unambiguous bare model id to its qualified selector and reports the binding honestly', async () => {
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/tmp', model: 'gpt-5.6-sol',
    }), res, 'r2-bare-1');

    expect(res.status).toBe(201);
    const body = jsonOf(res);
    expect(body.resolvedModel).toBe('openai-codex/gpt-5.6-sol');
    expect(body.modelBinding).toMatchObject({
      requested: 'gpt-5.6-sol',
      resolved: 'openai-codex/gpt-5.6-sol',
      fallbackApplied: false,
    });
    expect(piService.setModel).toHaveBeenCalledWith('pi-new', 'openai-codex/gpt-5.6-sol');
  });

  it('§1 rejects an ambiguous bare model id with 422 listing every candidate and creates nothing', async () => {
    piService.getAvailableModels.mockResolvedValue([
      { id: 'dup-model', name: 'Dup A', provider: 'alpha' },
      { id: 'dup-model', name: 'Dup B', provider: 'beta' },
    ]);
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/tmp', model: 'dup-model',
    }), res, 'r2-bare-2');

    expect(res.status).toBe(422);
    const body = jsonOf(res);
    expect(body.code).toBe('MODEL_NOT_APPLIED');
    expect(body.error).toContain('alpha/dup-model');
    expect(body.error).toContain('beta/dup-model');
    expect(piService.setModel).not.toHaveBeenCalled();
    expect(multiSessionManager.disposeLoadedSession).toHaveBeenCalled();
    expect(registry.delete).toHaveBeenCalledWith('pi-new');
  });

  it('§1 still fails loudly for a bare id matching no catalogue entry', async () => {
    piService.setModel.mockRejectedValue(new Error('Invalid model ID format: nope. Expected "provider/model-name"'));
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/tmp', model: 'nope',
    }), res, 'r2-bare-3');

    expect(res.status).toBe(422);
    expect(jsonOf(res).code).toBe('MODEL_NOT_APPLIED');
  });

  it('§1 excludes blocked providers from bare-id resolution', async () => {
    const blockedRoutes = createSessionRoutes({
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: multiSessionManager as never,
      sessionRegistry: registry as never,
      piService: piService as never,
      internalClientId: 'test',
      watchDir: dir,
      blockedPiProviders: ['zai'],
    });
    piService.setModel.mockRejectedValue(new Error('Invalid model ID format: glm-5.3. Expected "provider/model-name"'));
    const res = createMockRes();
    await blockedRoutes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/tmp', model: 'glm-5.3',
    }), res, 'r2-bare-4');

    // zai is blocked, so glm-5.3 has no admissible unique match → loud failure.
    expect(res.status).toBe(422);
    expect(jsonOf(res).code).toBe('MODEL_NOT_APPLIED');
    expect(piService.setModel).not.toHaveBeenCalledWith('pi-new', 'zai/glm-5.3');
  });

  it('§1 passes fully qualified selectors through unchanged', async () => {
    const res = createMockRes();
    await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', {
      runtime: 'pi', cwd: '/tmp', model: 'zai/glm-5.3',
    }), res, 'r2-bare-5');

    expect(res.status).toBe(201);
    expect(piService.setModel).toHaveBeenCalledWith('pi-new', 'zai/glm-5.3');
  });

  // ── §3: long-poll wait over one or many watches ─────────────────────────

  function makeLiveRoutes() {
    const observersByPath = new Map<string, Array<(e: unknown) => void>>();
    const msm = {
      ...multiSessionManager,
      addApiObserver: vi.fn((p: string, o: (e: unknown) => void) => {
        const list = observersByPath.get(p) ?? [];
        list.push(o);
        observersByPath.set(p, list);
      }),
    };
    const liveRoutes = createSessionRoutes({
      claudeService: {} as never,
      opencodeService: {} as never,
      antigravityService: {} as never,
      multiSessionManager: msm as never,
      sessionRegistry: registry as never,
      piService: piService as never,
      internalClientId: 'test',
      watchDir: dir,
    });
    const emitFor = (subjectPath: string, event: unknown) => {
      for (const o of observersByPath.get(subjectPath) ?? []) o(event);
    };
    return { liveRoutes, emitFor };
  }

  async function registerWatchOn(
    target: ReturnType<typeof createSessionRoutes>,
    sessionId: string,
    conditions: unknown[],
  ): Promise<any> {
    const reg = createMockRes();
    await target.handleRegisterWatch(
      createJsonReq('POST', `/api/v1/sessions/${sessionId}/watch`, { conditions }),
      reg,
      sessionId,
    );
    expect(reg.status).toBe(201);
    return jsonOf(reg);
  }

  it('§3 returns 204 after a bounded wait when nothing fired', async () => {
    await registerWatchOn(routes, 'pi-1', [{ type: 'event_type', eventType: 'agent_end' }]);
    const res = createMockRes();
    await routes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait?ids=watch-pi-1&timeout=60'),
      res,
      new URLSearchParams('ids=watch-pi-1&timeout=60'),
    );
    expect(res.status).toBe(204);
    expect(res.ended).toBe(true);
  });

  it('§3 blocks until one of several watches fires, then returns fired watches and nextCursor', async () => {
    const { liveRoutes, emitFor } = makeLiveRoutes();
    registry.get.mockImplementation(async (id: string) => mkEntry(id));

    await registerWatchOn(liveRoutes, 'child-a', [{ type: 'event_type', eventType: 'agent_end' }]);
    await registerWatchOn(liveRoutes, 'child-b', [{ type: 'event_type', eventType: 'agent_end' }]);

    const res = createMockRes();
    const pending = liveRoutes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait?ids=watch-child-a,watch-child-b&timeout=4000'),
      res,
      new URLSearchParams('ids=watch-child-a,watch-child-b&timeout=4000'),
    );

    // Fire child B shortly after the wait begins; child A stays silent.
    await new Promise((r) => setTimeout(r, 150));
    emitFor('child-b', { type: 'agent_end', timestamp: Date.now(), data: {} });

    await pending;
    expect(res.status).toBe(200);
    const body = jsonOf(res);
    expect(body.fired).toBe(true);
    const hitWatches = body.watches.filter((w: any) => w.firings.length > 0);
    expect(hitWatches).toHaveLength(1);
    expect(hitWatches[0].sessionId).toBe('child-b');
    expect(hitWatches[0].firings[0].eventType).toBe('agent_end');
    expect(typeof body.nextCursor).toBe('string');

    // Resuming with the returned cursor must not replay old firings.
    const res2 = createMockRes();
    await liveRoutes.handleWatchesWait(
      createJsonReq('GET', `/api/v1/watches/wait?ids=watch-child-a,watch-child-b&timeout=80&cursor=${encodeURIComponent(body.nextCursor)}`),
      res2,
      new URLSearchParams(`ids=watch-child-a,watch-child-b&timeout=80&cursor=${body.nextCursor}`),
    );
    expect(res2.status).toBe(204);
  });

  it('§3 accepts bare session ids as well as watch-<id> forms', async () => {
    const created = await registerWatchOn(routes, 'pi-1', [{ type: 'event_type', eventType: 'agent_end' }]);
    expect(created.watchId).toBe('watch-pi-1');
    const res = createMockRes();
    await routes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait?ids=pi-1&timeout=60'),
      res,
      new URLSearchParams('ids=pi-1&timeout=60'),
    );
    expect(res.status).toBe(204);
  });

  it('§3 validates ids and cursor parameters', async () => {
    const missing = createMockRes();
    await routes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait?ids=watch-absent'),
      missing,
      new URLSearchParams('ids=watch-absent'),
    );
    expect(missing.status).toBe(404);

    const noIds = createMockRes();
    await routes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait'),
      noIds,
      new URLSearchParams(''),
    );
    expect(noIds.status).toBe(400);

    const badCursor = createMockRes();
    await routes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait?ids=watch-pi-1&cursor=%21%21notbase64'),
      badCursor,
      new URLSearchParams('ids=watch-pi-1&cursor=!!notbase64'),
    );
    expect(badCursor.status).toBe(400);

    const badTimeout = createMockRes();
    await routes.handleWatchesWait(
      createJsonReq('GET', '/api/v1/watches/wait?ids=watch-pi-1&timeout=junk'),
      badTimeout,
      new URLSearchParams('ids=watch-pi-1&timeout=junk'),
    );
    expect(badTimeout.status).toBe(400);
  });
});

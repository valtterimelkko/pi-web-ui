import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { toDevinCatalogEntries, type DevinModelsFamily } from '../../../src/devin/devin-models.js';

/**
 * Lane D3 (devin-parity): `POST /api/v1/sessions` with `runtime: "devin"`
 * must honour `thinkingLevel` (sibling-model swap), accept a family base id,
 * refuse an unavailable level with 400 INVALID_REQUEST (never substitute) and
 * flag axis-less models with a `thinkingLevelNote`. Same rule on the batch
 * create path. Owner input 2026-11-08: "I would not like 9 different
 * selectors for one thing."
 */

// ─── Test helpers (modelled on session-routes-orchestration.test.ts) ─────────

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
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.getHeader = vi.fn();
  return res;
}

/** Catalogue shape mirrored from the live CLI output (see
 *  tests/unit/devin/devin-models.test.ts for the faithful fixture). */
const catalogueFamilies: DevinModelsFamily[] = [
  {
    family_label: 'SWE-2 Flash', family_uid: 'swe-2-flash', slug: 'swe-2-flash', aliases: [],
    variants: [
      { model_uid: 'swe-2-flash-medium', label: 'SWE-2 Flash Medium', cost_tier: 'Free' },
      { model_uid: 'swe-2-flash-high', label: 'SWE-2 Flash High', cost_tier: 'Free' },
      { model_uid: 'swe-2-flash-max', label: 'SWE-2 Flash Max', cost_tier: 'Free' },
    ],
  },
  {
    family_label: 'SWE-2', family_uid: 'swe-2', slug: 'swe-2', aliases: [],
    variants: [
      { model_uid: 'swe-2-medium', label: 'SWE-2 Medium', cost_tier: 'Free' },
      { model_uid: 'swe-2-high', label: 'SWE-2 High', cost_tier: 'Free' },
      { model_uid: 'swe-2-max', label: 'SWE-2 Max', cost_tier: 'Free' },
    ],
  },
  {
    family_label: 'Kimi K2.6', family_uid: 'kimi-k2.6', slug: 'kimi-k2.6', aliases: [],
    variants: [
      { model_uid: 'kimi-k2-6', label: 'Kimi K2.6', cost_tier: 'High cost' },
    ],
  },
];

describe('devin create honours the requested thinking level (lane D3)', () => {
  let registry: any;
  let devinService: any;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-d3-'));
    registry = {
      get: vi.fn(),
      getByPath: vi.fn(),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    devinService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'new-devin' }),
      getAvailableModels: vi.fn().mockResolvedValue(toDevinCatalogEntries(catalogueFamilies)),
      isRunning: vi.fn(() => false),
      setModel: vi.fn().mockResolvedValue('swe-2-flash-medium'),
      setThinkingLevel: vi.fn().mockResolvedValue('swe-2-flash-high'),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      sendPrompt: vi.fn((_id: string, _m: string, _b: unknown, complete: (e?: Error) => void) => {
        complete();
        return Promise.resolve();
      }),
      followUp: vi.fn(() => Promise.resolve(true)),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
      getLastCompletedTurn: vi.fn(async () => null),
      getSessionCwd: vi.fn(async () => '/root/proj'),
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeRoutes() {
    return createSessionRoutes({
      claudeService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn(), isRunning: vi.fn(() => false), getSessionStats: vi.fn(), getReplayEvents: vi.fn().mockResolvedValue([]), setModel: vi.fn(), setThinkingLevel: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), isSessionPinned: vi.fn(() => false), loadSessionHistory: vi.fn().mockResolvedValue([]), abort: vi.fn(), executionBackend: vi.fn(() => 'sdk-subscription'), sendPrompt: vi.fn(), sendPermissionResponse: vi.fn(), listPendingAskUserQuestionsForSession: vi.fn(() => []), getBackendMode: vi.fn().mockResolvedValue('channel'), getContextUsage: vi.fn() },
      opencodeService: { isEnabled: vi.fn().mockReturnValue(true), isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn(), isRunning: vi.fn(() => false), getSessionStats: vi.fn(), getReplayEvents: vi.fn().mockResolvedValue([]), setModel: vi.fn(), setThinkingLevel: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), isSessionPinned: vi.fn(() => false), abort: vi.fn(), sendPrompt: vi.fn(), replyPermission: vi.fn(), getContextUsage: vi.fn() },
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn(), isRunning: vi.fn(() => false), getSessionStats: vi.fn(), getReplayEvents: vi.fn().mockResolvedValue([]), setModel: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), isSessionPinned: vi.fn(() => false), abort: vi.fn(), sendPrompt: vi.fn(), getContextUsage: vi.fn() },
      devinService,
      multiSessionManager: {
        subscribeClient: vi.fn().mockResolvedValue(undefined),
        unsubscribeClient: vi.fn(),
        getAgentSession: vi.fn(() => null),
        addApiObserver: vi.fn(),
        removeApiObserver: vi.fn(),
        createAndSubscribe: vi.fn().mockResolvedValue({ sessionId: 'new-pi', sessionPath: '/tmp/new-pi.jsonl' }),
        prompt: vi.fn().mockResolvedValue(undefined),
        disposeLoadedSession: vi.fn(),
        pinSession: vi.fn(() => true),
        unpinSession: vi.fn(() => true),
        isSessionPinned: vi.fn(() => false),
      },
      sessionRegistry: registry,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) },
      internalClientId: 'test-client',
      watchDir: path.join(tempDir, 'watches'),
      devinSessionDir: path.join(tempDir, 'devin-sessions'),
    });
  }

  async function createDevin(body: Record<string, unknown>) {
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleCreateSession(
      createJsonReq('POST', '/api/v1/sessions', { runtime: 'devin', cwd: tempDir as string, ...body }),
      res,
    );
    return { status: res.statusCode, json: JSON.parse(res.body || '{}') as any };
  }

  it('variant + thinkingLevel creates on the sibling id and echoes the resolved model', async () => {
    const { status, json } = await createDevin({ model: 'swe-2-flash-medium', thinkingLevel: 'high' });
    expect(status).toBe(201);
    expect(json.model).toBe('swe-2-flash-high');
    expect(devinService.createSession).toHaveBeenCalledWith(tempDir, 'swe-2-flash-high');
    expect(json.thinkingLevelNote).toBeUndefined();
  });

  it('a level the family does not have is a 400 INVALID_REQUEST naming the levels; nothing is created', async () => {
    const { status, json } = await createDevin({ model: 'swe-2-flash-medium', thinkingLevel: 'xhigh' });
    expect(status).toBe(400);
    expect(json.code).toBe('INVALID_REQUEST');
    expect(json.error).toContain('medium, high, max');
    expect(devinService.createSession).not.toHaveBeenCalled();
  });

  it('an axis-less model creates unchanged and carries the no-axis thinkingLevelNote', async () => {
    const { status, json } = await createDevin({ model: 'kimi-k2-6', thinkingLevel: 'high' });
    expect(status).toBe(201);
    expect(json.model).toBe('kimi-k2-6');
    expect(json.thinkingLevelNote).toContain('no thinking-level axis');
    expect(devinService.createSession).toHaveBeenCalledWith(tempDir, 'kimi-k2-6');
  });

  it('a variant with no level creates unchanged (today\u2019s behaviour)', async () => {
    const { status, json } = await createDevin({ model: 'swe-2-flash-max' });
    expect(status).toBe(201);
    expect(json.model).toBe('swe-2-flash-max');
    expect(json.thinkingLevelNote).toBeUndefined();
  });

  it('a family base id resolves to medium by default and to the requested level when given', async () => {
    const noLevel = await createDevin({ model: 'swe-2-flash' });
    expect(noLevel.status).toBe(201);
    expect(noLevel.json.model).toBe('swe-2-flash-medium');

    const withLevel = await createDevin({ model: 'swe-2', thinkingLevel: 'max' });
    expect(withLevel.status).toBe(201);
    expect(withLevel.json.model).toBe('swe-2-max');
  });

  it('a family base id with an unavailable level is a 400 naming the levels', async () => {
    const { status, json } = await createDevin({ model: 'swe-2', thinkingLevel: 'low' });
    expect(status).toBe(400);
    expect(json.code).toBe('INVALID_REQUEST');
    expect(json.error).toContain('medium, high, max');
  });

  it('an unknown id passes through unchanged (today\u2019s refusal stays with the runtime)', async () => {
    const { status, json } = await createDevin({ model: 'totally-unknown' });
    expect(status).toBe(201);
    expect(json.model).toBe('totally-unknown');
  });
});

describe('devin batch create honours the requested thinking level (lane D3)', () => {
  let registry: any;
  let devinService: any;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-d3-batch-'));
    registry = {
      get: vi.fn(),
      getByPath: vi.fn(),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    devinService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      createSession: vi.fn(async (_cwd: string, model?: string) => ({ sessionId: `batch-devin-${model ?? 'default'}` })),
      getAvailableModels: vi.fn().mockResolvedValue(toDevinCatalogEntries(catalogueFamilies)),
      isRunning: vi.fn(() => false),
      setModel: vi.fn().mockResolvedValue('swe-2-flash-medium'),
      setThinkingLevel: vi.fn().mockResolvedValue('swe-2-flash-high'),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      sendPrompt: vi.fn((_id: string, _m: string, _b: unknown, complete: (e?: Error) => void) => {
        complete();
        return Promise.resolve();
      }),
      followUp: vi.fn(() => Promise.resolve(true)),
      getServedModel: vi.fn(async () => 'swe-2-flash-medium'),
      getLastCompletedTurn: vi.fn(async () => null),
      getSessionCwd: vi.fn(async () => '/root/proj'),
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeRoutes() {
    return createSessionRoutes({
      claudeService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn(), isRunning: vi.fn(() => false), getSessionStats: vi.fn(), getReplayEvents: vi.fn().mockResolvedValue([]), setModel: vi.fn(), setThinkingLevel: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), isSessionPinned: vi.fn(() => false), loadSessionHistory: vi.fn().mockResolvedValue([]), abort: vi.fn(), executionBackend: vi.fn(() => 'sdk-subscription'), sendPrompt: vi.fn(), sendPermissionResponse: vi.fn(), listPendingAskUserQuestionsForSession: vi.fn(() => []), getBackendMode: vi.fn().mockResolvedValue('channel'), getContextUsage: vi.fn() },
      opencodeService: { isEnabled: vi.fn().mockReturnValue(true), isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn(), isRunning: vi.fn(() => false), getSessionStats: vi.fn(), getReplayEvents: vi.fn().mockResolvedValue([]), setModel: vi.fn(), setThinkingLevel: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), isSessionPinned: vi.fn(() => false), abort: vi.fn(), sendPrompt: vi.fn(), replyPermission: vi.fn(), getContextUsage: vi.fn() },
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn(), isRunning: vi.fn(() => false), getSessionStats: vi.fn(), getReplayEvents: vi.fn().mockResolvedValue([]), setModel: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), isSessionPinned: vi.fn(() => false), abort: vi.fn(), sendPrompt: vi.fn(), getContextUsage: vi.fn() },
      devinService,
      multiSessionManager: {
        subscribeClient: vi.fn().mockResolvedValue(undefined),
        unsubscribeClient: vi.fn(),
        getAgentSession: vi.fn(() => null),
        addApiObserver: vi.fn(),
        removeApiObserver: vi.fn(),
        createAndSubscribe: vi.fn().mockResolvedValue({ sessionId: 'new-pi', sessionPath: '/tmp/new-pi.jsonl' }),
        prompt: vi.fn().mockResolvedValue(undefined),
        disposeLoadedSession: vi.fn(),
        pinSession: vi.fn(() => true),
        unpinSession: vi.fn(() => true),
        isSessionPinned: vi.fn(() => false),
      },
      sessionRegistry: registry,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) },
      internalClientId: 'test-client',
      watchDir: path.join(tempDir, 'watches'),
      devinSessionDir: path.join(tempDir, 'devin-sessions'),
    });
  }

  it('batch entries resolve model+level like single create: sibling id, family id, 400, no-axis note', async () => {
    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleBatchCreate(
      createJsonReq('POST', '/api/v1/sessions/batch', {
        sessions: [
          { runtime: 'devin', cwd: tempDir as string, model: 'swe-2-flash-medium', thinkingLevel: 'high' },
          { runtime: 'devin', cwd: tempDir as string, model: 'swe-2-flash' },
          { runtime: 'devin', cwd: tempDir as string, model: 'swe-2-flash-medium', thinkingLevel: 'xhigh' },
          { runtime: 'devin', cwd: tempDir as string, model: 'kimi-k2-6', thinkingLevel: 'high' },
        ],
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as { created: Array<any> };
    expect(json.created).toHaveLength(4);

    const [resolved, family, badLevel, noAxis] = json.created;
    expect(resolved.success).toBe(true);
    expect(resolved.model).toBe('swe-2-flash-high');
    expect(family.success).toBe(true);
    expect(family.model).toBe('swe-2-flash-medium');
    expect(badLevel.success).toBe(false);
    expect(badLevel.error?.code).toBe('INVALID_REQUEST');
    expect(badLevel.error?.message).toContain('medium, high, max');
    expect(noAxis.success).toBe(true);
    expect(noAxis.model).toBe('kimi-k2-6');
    expect(noAxis.thinkingLevelNote).toContain('no thinking-level axis');
    expect(json.createdCount).toBe(3);
    expect(json.failedCount).toBe(1);
  });
});

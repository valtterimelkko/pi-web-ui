import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { BATCH_CONCURRENCY_LIMIT, MAX_BATCH_ITEMS } from '../../../src/internal-api/session-validation.js';

// ─── helpers (mirror session-routes-orchestration.test.ts) ────────────────────

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as unknown as Record<string, unknown>).method = method;
  (req as unknown as Record<string, unknown>).url = url;
  (req as unknown as Record<string, unknown>).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _e: BufferEncoding, cb: (error?: Error | null) => void) {
      chunks.push(chunk); cb();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code; return this;
  });
  res.write = vi.fn(() => true);
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  } as never);
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res);
  return res;
}

// ─── mocks ────────────────────────────────────────────────────────────────────

let tempDir: string;
let registry: ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
let multiSessionManager: Record<string, ReturnType<typeof vi.fn>>;
let createAndSubscribeActive = 0;
let createAndSubscribePeak = 0;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-val-'));
  createAndSubscribeActive = 0;
  createAndSubscribePeak = 0;

  registry = Object.assign(vi.fn(), {
    get: vi.fn(),
    getByPath: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
  });

  multiSessionManager = {
    subscribeClient: vi.fn().mockResolvedValue(undefined),
    getAgentSession: vi.fn(() => ({ setThinkingLevel: vi.fn(), getSessionStats: vi.fn(), sessionFile: '/tmp/p.jsonl' })),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    createAndSubscribe: vi.fn(async () => {
      createAndSubscribeActive += 1;
      createAndSubscribePeak = Math.max(createAndSubscribePeak, createAndSubscribeActive);
      // Vary latency so completion order differs from input order; the runner
      // must still return results in input order.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
      createAndSubscribeActive -= 1;
      return { sessionId: `pi-${Math.random().toString(36).slice(2)}`, sessionPath: '/tmp/p.jsonl' };
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
    pinSession: vi.fn(() => true),
    unpinSession: vi.fn(() => true),
    isSessionPinned: vi.fn(() => false),
  };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function makeRoutes() {
  // Cast the whole deps object once (the mocks are partial by design); avoids
  // per-field `any` casts that would inflate the lint-warning count.
  return createSessionRoutes({
    claudeService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn().mockResolvedValue({ sessionId: 'claude-x' }) },
    opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn().mockResolvedValue({ sessionId: 'oc-x' }), setThinkingLevel: vi.fn() },
    antigravityService: { isAvailable: vi.fn().mockResolvedValue(true), createSession: vi.fn().mockResolvedValue({ sessionId: 'agy-x' }) },
    multiSessionManager,
    sessionRegistry: registry,
    piService: { setModel: vi.fn().mockResolvedValue(undefined) },
    internalClientId: 's3-test',
    watchDir: path.join(tempDir, 'watches'),
  } as never);
}

describe('S3: Internal API session/batch validation + bounded fan-out', () => {
  describe('POST /sessions — runtime validation', () => {
    it('rejects an unknown runtime with 400 and creates no Pi session', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'not-a-runtime' }), res, 's3-test');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toMatch(/INVALID_REQUEST/);
      expect(multiSessionManager.createAndSubscribe).not.toHaveBeenCalled();
    });

    it.each([
      ['case-mangled', 'Claude'],
      ['numeric', 5],
      ['null', null],
      ['missing', undefined],
    ])('rejects a %s runtime with 400 and creates no Pi session', async (_label, runtime) => {
      const routes = makeRoutes();
      const res = createMockRes();
      const body: Record<string, unknown> = { cwd: '/tmp' };
      if (runtime !== undefined) body.runtime = runtime;
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', body), res, 's3-test');
      expect(res.statusCode).toBe(400);
      expect(multiSessionManager.createAndSubscribe).not.toHaveBeenCalled();
    });

    it('accepts a valid pi runtime and creates the session', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'pi' }), res, 's3-test');
      expect(res.statusCode).toBe(201);
      expect(multiSessionManager.createAndSubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /sessions/batch — atomic validation', () => {
    it('rejects an unknown runtime in any entry with 400 and creates nothing', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', {
          sessions: [
            { runtime: 'pi' },
            { runtime: 'bogus' },
          ],
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toMatch(/INVALID_REQUEST/);
      expect(multiSessionManager.createAndSubscribe).not.toHaveBeenCalled();
    });

    it('rejects an empty batch with 400', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(createJsonReq('POST', '/api/v1/sessions/batch', { sessions: [] }), res);
      expect(res.statusCode).toBe(400);
    });

    it('rejects a batch over the max with 400', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', {
          sessions: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ runtime: 'pi' })),
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(multiSessionManager.createAndSubscribe).not.toHaveBeenCalled();
    });

    it('rejects an entry with a malformed thinkingLevel with 400 and creates nothing', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', {
          sessions: [{ runtime: 'pi', thinkingLevel: 'ultra' }],
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(multiSessionManager.createAndSubscribe).not.toHaveBeenCalled();
    });

    it('creates all entries for a valid batch and preserves input order', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', {
          sessions: [
            { runtime: 'pi' },
            { runtime: 'claude' },
            { runtime: 'pi' },
          ],
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.createdCount).toBe(3);
      expect(body.created.map((r: { index: number }) => r.index)).toEqual([0, 1, 2]);
      expect(body.created.map((r: { runtime: string }) => r.runtime)).toEqual(['pi', 'claude', 'pi']);
    });
  });

  describe('POST /sessions/batch — bounded concurrency', () => {
    it('never exceeds the concurrency limit under a max-size batch', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', {
          sessions: Array.from({ length: MAX_BATCH_ITEMS }, () => ({ runtime: 'pi' })),
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.createdCount).toBe(MAX_BATCH_ITEMS);
      // Peak concurrent createAndSubscribe invocations must not exceed the limit.
      expect(createAndSubscribePeak).toBeLessThanOrEqual(BATCH_CONCURRENCY_LIMIT);
      expect(createAndSubscribePeak).toBeGreaterThan(1); // proves it actually fanned out
      // Results preserved in input order despite out-of-order completion.
      expect(body.created.map((r: { index: number }) => r.index)).toEqual(
        Array.from({ length: MAX_BATCH_ITEMS }, (_, i) => i),
      );
    });
  });

  describe('POST /sessions/batch/prompt — validation', () => {
    it('rejects an entry with an empty message with 400', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchPrompt(
        createJsonReq('POST', '/api/v1/sessions/batch/prompt', {
          prompts: [{ sessionId: 's1', message: '' }],
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects an entry missing sessionId with 400', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchPrompt(
        createJsonReq('POST', '/api/v1/sessions/batch/prompt', {
          prompts: [{ message: 'hi' }],
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
    });
  });
});

/**
 * C4 dispatch preflight (contract 1.53.0) at the route level.
 *
 * POST /sessions, POST /sessions/batch and the optional `preflight` field on
 * POST /sessions/:id/prompt must refuse with 400 PREFLIGHT_FAILED BEFORE any
 * runtime work: no session created, no runtime service call, no receipt. A
 * valid request proceeds exactly as before (backward compatible: absent
 * preflight fields change nothing except the default-on cwd check).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { AdmissionController, type AdmissionControllerOptions } from '../../../src/internal-api/admission-controller.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const REAL_PATH = process.env.PATH;

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

describe('C4 dispatch preflight at the route level', () => {
  let dir: string;
  let goodDir: string;
  let registry: any;
  let claudeService: any;
  const pending: Array<Promise<unknown>> = [];

  let createdCount = 0;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-routes-'));
    goodDir = await fs.mkdtemp(path.join(dir, 'cwd-'));
    createdCount = 0;
    registry = {
      get: vi.fn(async (sessionId: string) => ({
        id: sessionId, path: sessionId, sdkType: 'claude', cwd: goodDir, model: 'sonnet',
        firstMessage: '', messageCount: 0, status: 'idle',
        createdAt: '2026-09-29T00:00:00.000Z', lastActivity: '2026-09-29T00:00:00.000Z',
      })),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      // Unique id per create: a runtime never hands out the same session twice.
      createSession: vi.fn(async () => ({ sessionId: `claude-new-${++createdCount}` })),
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
  });

  afterEach(async () => {
    await Promise.all(pending.splice(0));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes() {
    const routes = createSessionRoutes({
      claudeService,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), abort: vi.fn() } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(true), abort: vi.fn() } as any,
      commandCodeService: undefined,
      multiSessionManager: {} as any,
      sessionRegistry: registry,
      piService: { setModel: vi.fn() } as any,
      internalClientId: 'internal-test',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
      admissionController: admissionWith(),
      runReceiptManager: new RunReceiptManager({ store: new RunReceiptStore(path.join(dir, 'receipts')) }),
    } as any);
    pending.push(routes.ready.catch(() => undefined));
    return routes;
  }

  describe('POST /sessions', () => {
    it('declared missing path → 400 PREFLIGHT_FAILED listing the item; runtime create NOT called', async () => {
      const routes = makeRoutes();
      const missing = path.join(dir, 'declared-missing');
      const res = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', cwd: goodDir, preflight: { paths: [missing] } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      const body = json(res);
      expect(body.code).toBe('PREFLIGHT_FAILED');
      expect(body.error).toContain(missing);
      expect(body.failures).toEqual([{ kind: 'path', item: missing, problem: 'does not exist' }]);
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('declared missing tool → 400 PREFLIGHT_FAILED; runtime create NOT called', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', cwd: goodDir, preflight: { tools: ['c4-no-such-tool'] } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('PREFLIGHT_FAILED');
      expect(json(res).failures[0]).toEqual({ kind: 'tool', item: 'c4-no-such-tool', problem: 'not found on PATH' });
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('cwd that does not exist → 400 PREFLIGHT_FAILED even with no preflight field (default-on cwd check)', async () => {
      const routes = makeRoutes();
      const missingCwd = path.join(dir, 'no-such-cwd');
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', cwd: missingCwd }), res);
      expect(res.statusCode).toBe(400);
      const body = json(res);
      expect(body.code).toBe('PREFLIGHT_FAILED');
      expect(body.failures).toEqual([{ kind: 'cwd', item: missingCwd, problem: 'does not exist' }]);
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('every declared problem is listed together (cwd + path + tool)', async () => {
      const routes = makeRoutes();
      const missingCwd = path.join(dir, 'no-cwd');
      const missingPath = path.join(dir, 'no-path');
      const res = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', {
          runtime: 'claude',
          cwd: missingCwd,
          preflight: { paths: [missingPath], tools: ['c4-none'] },
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      const kinds = json(res).failures.map((f: { kind: string }) => f.kind).sort();
      expect(kinds).toEqual(['cwd', 'path', 'tool']);
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });

    it('valid cwd + passing preflight → 201 and create proceeds (positive control)', async () => {
      const routes = makeRoutes();
      const existing = path.join(dir, 'exists.md');
      await fs.writeFile(existing, 'x');
      const res = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', {
          runtime: 'claude',
          cwd: goodDir,
          preflight: { paths: [existing], tools: ['sh'] },
        }),
        res,
      );
      expect(res.statusCode).toBe(201);
      expect(claudeService.createSession).toHaveBeenCalledTimes(1);
    });

    it('no preflight field + existing cwd → 201 unchanged (backward compatible)', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleCreateSession(createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', cwd: goodDir }), res);
      expect(res.statusCode).toBe(201);
      expect(claudeService.createSession).toHaveBeenCalledTimes(1);
    });

    it('malformed preflight shape → 400 INVALID_REQUEST before any runtime call', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', { runtime: 'claude', cwd: goodDir, preflight: { paths: ['relative/path'] } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('INVALID_REQUEST');
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /sessions/batch', () => {
    function batchEntryBody(overrides: Record<string, unknown> = {}) {
      return {
        sessions: [
          { runtime: 'claude', cwd: goodDir },
          { runtime: 'claude', cwd: goodDir, preflight: { paths: [path.join(dir, 'missing-in-batch')] } },
          ...Object.entries(overrides).map(([k, v]) => ({ runtime: 'claude', cwd: goodDir, [k]: v })),
        ],
      };
    }

    it('failing entry → per-item PREFLIGHT_FAILED, other entries still created, failing entry never reaches the runtime', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleBatchCreate(createJsonReq('POST', '/api/v1/sessions/batch', batchEntryBody()), res);
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.createdCount).toBe(1);
      expect(body.failedCount).toBe(1);
      const failed = body.created.find((item: any) => !item.success);
      expect(failed.error.code).toBe('PREFLIGHT_FAILED');
      expect(failed.error.failures[0].kind).toBe('path');
      expect(failed.error.failures[0].problem).toBe('does not exist');
      expect(claudeService.createSession).toHaveBeenCalledTimes(1);
    });

    it('cwd missing on an entry → per-item PREFLIGHT_FAILED (default-on cwd check)', async () => {
      const routes = makeRoutes();
      const missingCwd = path.join(dir, 'batch-no-cwd');
      const res = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', { sessions: [{ runtime: 'claude', cwd: missingCwd }] }),
        res,
      );
      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.failedCount).toBe(1);
      expect(body.created[0].error.code).toBe('PREFLIGHT_FAILED');
      expect(body.created[0].error.failures[0]).toEqual({ kind: 'cwd', item: missingCwd, problem: 'does not exist' });
      expect(claudeService.createSession).not.toHaveBeenCalled();
    });
  });

  describe('correction 01 — runtime PATH and batch cwd parity', () => {
    afterEach(() => {
      process.env.PATH = REAL_PATH;
      delete process.env.PI_WEB_UI_VALIDATION_DEFAULT_CWD;
    });

    it('tool lookup uses the runtime child PATH: agy resolves for antigravity, not for pi (item 1)', async () => {
      // Shrink the server PATH so /root/.local/bin (agy) is invisible to plain
      // children; only the antigravity prepend may find it.
      const bin = path.join(dir, 'bare-bin');
      await fs.mkdir(bin);
      process.env.PATH = bin;
      const antigravityService = {
        isRunning: vi.fn(() => false),
        isAvailable: vi.fn().mockResolvedValue(true),
        createSession: vi.fn(async () => ({ sessionId: 'agy-new' })),
      };
      const routes = createSessionRoutes({
        claudeService,
        opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), abort: vi.fn() } as any,
        antigravityService: antigravityService as any,
        commandCodeService: undefined,
        multiSessionManager: {} as any,
        sessionRegistry: registry,
        piService: { setModel: vi.fn() } as any,
        internalClientId: 'internal-test',
        watchDir: path.join(dir, 'watches'),
        pinDir: path.join(dir, 'pins'),
        pinExpiryIntervalMs: 60_000,
        admissionController: admissionWith(),
        runReceiptManager: new RunReceiptManager({ store: new RunReceiptStore(path.join(dir, 'receipts-corr1')) }),
      } as any);
      pending.push(routes.ready.catch(() => undefined));

      const agyCreate = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', { runtime: 'antigravity', cwd: goodDir, preflight: { tools: ['agy'] } }),
        agyCreate,
      );
      expect(agyCreate.statusCode).toBe(201);
      expect(antigravityService.createSession).toHaveBeenCalledTimes(1);

      const piCreate = createMockRes();
      await routes.handleCreateSession(
        createJsonReq('POST', '/api/v1/sessions', { runtime: 'pi', cwd: goodDir, preflight: { tools: ['agy'] } }),
        piCreate,
      );
      expect(piCreate.statusCode).toBe(400);
      expect(json(piCreate).code).toBe('PREFLIGHT_FAILED');
      expect(json(piCreate).failures[0]).toEqual({ kind: 'tool', item: 'agy', problem: 'not found on PATH' });
    });

    it('prompt preflight resolves tools on the session runtime PATH, not the host PATH (item 1)', async () => {
      const bin = path.join(dir, 'bare-bin');
      await fs.mkdir(bin);
      process.env.PATH = bin;
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleSendPrompt(
        createJsonReq('POST', '/api/v1/sessions/claude-1/prompt', { message: 'go', preflight: { tools: ['agy'] } }),
        res,
        'claude-1',
      );
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('PREFLIGHT_FAILED');
      expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    });

    it('batch entries without cwd preflight the REQUEST-TIME validation default, same as single create (item 5)', async () => {
      const envDefault = path.join(dir, 'env-default-cwd');
      process.env.PI_WEB_UI_VALIDATION_DEFAULT_CWD = envDefault;
      const routes = makeRoutes();

      // Missing dir → per-item refusal naming exactly the env-var dir.
      const refused = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', { sessions: [{ runtime: 'claude' }] }),
        refused,
      );
      expect(refused.statusCode).toBe(200);
      const body = json(refused);
      expect(body.failedCount).toBe(1);
      expect(body.created[0].error.code).toBe('PREFLIGHT_FAILED');
      expect(body.created[0].error.failures[0]).toEqual({ kind: 'cwd', item: envDefault, problem: 'does not exist' });
      expect(claudeService.createSession).not.toHaveBeenCalled();

      // Existing dir → create proceeds against it.
      await fs.mkdir(envDefault, { recursive: true });
      const ok = createMockRes();
      await routes.handleBatchCreate(
        createJsonReq('POST', '/api/v1/sessions/batch', { sessions: [{ runtime: 'claude' }] }),
        ok,
      );
      expect(ok.statusCode).toBe(200);
      expect(json(ok).createdCount).toBe(1);
      expect(claudeService.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /sessions/:id/prompt optional preflight', () => {
    it('declared missing path → 400 PREFLIGHT_FAILED before the session is even resolved (no dispatch)', async () => {
      const routes = makeRoutes();
      const missing = path.join(dir, 'prompt-missing');
      const res = createMockRes();
      await routes.handleSendPrompt(
        createJsonReq('POST', '/api/v1/sessions/claude-1/prompt', { message: 'go', preflight: { paths: [missing] } }),
        res,
        'claude-1',
      );
      expect(res.statusCode).toBe(400);
      const body = json(res);
      expect(body.code).toBe('PREFLIGHT_FAILED');
      expect(body.failures).toEqual([{ kind: 'path', item: missing, problem: 'does not exist' }]);
      expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    });

    it('passing preflight → request proceeds past the hook (404 for an unknown session, not a preflight refusal)', async () => {
      registry.get.mockResolvedValue(null);
      const routes = makeRoutes();
      const existing = path.join(dir, 'exists-prompt.md');
      await fs.writeFile(existing, 'x');
      const res = createMockRes();
      await routes.handleSendPrompt(
        createJsonReq('POST', '/api/v1/sessions/unknown-1/prompt', { message: 'go', preflight: { paths: [existing], tools: ['sh'] } }),
        res,
        'unknown-1',
      );
      expect(res.statusCode).toBe(404);
      expect(json(res).code).toBe('SESSION_NOT_FOUND');
    });

    it('malformed preflight shape on prompt → 400 INVALID_REQUEST', async () => {
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleSendPrompt(
        createJsonReq('POST', '/api/v1/sessions/claude-1/prompt', { message: 'go', preflight: { tools: ['/bin/sh'] } }),
        res,
        'claude-1',
      );
      expect(res.statusCode).toBe(400);
      expect(json(res).code).toBe('INVALID_REQUEST');
      expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    });

    it('no preflight field → behaviour unchanged', async () => {
      registry.get.mockResolvedValue(null);
      const routes = makeRoutes();
      const res = createMockRes();
      await routes.handleSendPrompt(
        createJsonReq('POST', '/api/v1/sessions/unknown-1/prompt', { message: 'go' }),
        res,
        'unknown-1',
      );
      expect(res.statusCode).toBe(404);
    });
  });
});

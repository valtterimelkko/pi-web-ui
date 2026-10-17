/**
 * Contract 1.65.0 (command-centre step 1k) — Internal API archive/unarchive.
 *
 * `POST /api/v1/sessions/:id/archive` and `/unarchive` behind the Internal
 * API's own bearer auth, reusing the browser route's prefs-lock + LWW logic:
 * archive stamps `archived` + `archivedAt` (re-archive keeps the original
 * stamp), unarchive clears both, pinned sessions refuse archive with a
 * documented 409 code, a session with a live turn refuses archive with 409,
 * both are idempotent, and the list's existing `archived` flag reflects it.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { createAuthMiddleware } from '../../../src/internal-api/middleware/auth.js';
import { sessionArchiveBodySchema } from '../../../src/internal-api/session-validation.js';

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
  res.setHeader = vi.fn() as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.write = vi.fn((data: string | Buffer) => { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res) as any;
  return res;
}

describe('archive/unarchive — body schema', () => {
  it('accepts an empty object or an optional epoch-ms updatedAt only', () => {
    expect(sessionArchiveBodySchema.safeParse({}).success).toBe(true);
    expect(sessionArchiveBodySchema.safeParse({ updatedAt: 1700000000000 }).success).toBe(true);
    expect(sessionArchiveBodySchema.safeParse({ updatedAt: 'soon' }).success).toBe(false);
    expect(sessionArchiveBodySchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('archive/unarchive — routes', () => {
  let dir: string;
  let prefsPath: string;
  let registry: any;
  let entries: Map<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let claudeService: any;
  let commandCodeService: any;
  let commandCodeRecords: Map<string, any>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-archive-'));
    prefsPath = path.join(dir, 'prefs.json');
    entries = new Map();
    registry = {
      get: vi.fn(async (id: string) => entries.get(id)),
      getByPath: vi.fn(async () => undefined),
      listAll: vi.fn(async () => Array.from(entries.values())),
      upsert: vi.fn(async (e: any) => { entries.set(e.id, { ...(entries.get(e.id) ?? {}), ...e }); return entries.get(e.id); }),
      patchSessionMeta: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    claudeService = {
      isRunning: vi.fn(() => false),
      pinSession: vi.fn(async () => true),
      unpinSession: vi.fn(async () => true),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn(async () => null),
      getContextUsage: vi.fn(async () => null),
      getBackendMode: vi.fn(async () => 'sdk'),
    };
    commandCodeRecords = new Map();
    commandCodeService = {
      isEnabled: vi.fn(() => true),
      isAvailable: vi.fn(() => true),
      init: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => Array.from(commandCodeRecords.values())),
      getSession: vi.fn(async (id: string) => commandCodeRecords.get(id)),
      findSession: vi.fn(async () => null),
      isRunning: vi.fn(() => false),
      pinSession: vi.fn(async () => true),
      unpinSession: vi.fn(async () => true),
    };
    routes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false), isSessionPinned: vi.fn(() => false), getSessionStats: vi.fn(async () => null) } as any,
      multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      preferencesPath: prefsPath,
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      commandCodeService,
    });
    entries.set('claude-1', {
      id: 'claude-1', path: 'claude-1', sdkType: 'claude', cwd: '/tmp', firstMessage: '', messageCount: 0,
      status: 'idle', createdAt: '2026-10-01T00:00:00.000Z', lastActivity: '2026-10-01T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await routes.shutdown?.();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function archive(id = 'claude-1', body?: unknown) {
    const res = mockRes();
    await routes.handleArchiveSession(jsonReq('POST', `/api/v1/sessions/${id}/archive`, body ?? {}), res, id);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  async function unarchive(id = 'claude-1', body?: unknown) {
    const res = mockRes();
    await routes.handleUnarchiveSession(jsonReq('POST', `/api/v1/sessions/${id}/unarchive`, body ?? {}), res, id);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  async function listArchived(id: string): Promise<boolean | undefined> {
    const res = mockRes();
    await routes.handleListSessions(jsonReq('GET', '/api/v1/sessions'), res);
    const body = JSON.parse(res.body);
    return body.sessions.find((s: any) => s.sessionId === id)?.archived;
  }

  async function readPrefs(): Promise<any> {
    try { return JSON.parse(await fs.readFile(prefsPath, 'utf8')); } catch { return { version: 2, sessions: {} }; }
  }

  it('requires the Internal API bearer auth (middleware covers the archive route)', async () => {
    const auth = createAuthMiddleware('secret-token');
    const run = (headers: Record<string, unknown>): { res: ReturnType<typeof mockRes>; passed: Promise<boolean> } => {
      const res = mockRes();
      let passed = false;
      const settle = new Promise<boolean>((resolve) => {
        (res.end as any).mockImplementation((data?: string | Buffer) => {
          if (data) (res as any).body = Buffer.concat([Buffer.from((res as any).body ?? ''), Buffer.isBuffer(data) ? data : Buffer.from(data)]).toString();
          resolve(false);
          return res;
        });
        (res.writeHead as any).mockImplementation(function (this: any, code: number) { res.statusCode = code; return this; });
      });
      const req = jsonReq('POST', '/api/v1/sessions/claude-1/archive', {}) as IncomingMessage;
      (req as any).headers = headers;
      const passedThrough = new Promise<boolean>((resolve) => {
        auth(req, res as unknown as ServerResponse, () => { passed = true; resolve(true); });
      });
      // Whichever fires first: a refusal ends the response, a pass-through
      // calls next().
      return { res, passed: Promise.race([settle, passedThrough]).then(() => passed) };
    };
    // No token → 401 before any handler runs.
    const refused = run({ 'content-type': 'application/json' });
    expect((await refused.passed)).toBe(false);
    expect(refused.res.statusCode).toBe(401);
    expect((refused.res as any).body).toContain('UNAUTHORIZED');
    // Wrong token → 401.
    const wrong = run({ authorization: 'Bearer nope' });
    expect((await wrong.passed)).toBe(false);
    expect(wrong.res.statusCode).toBe(401);
    // Correct token → passes through (next() called; the handler would run).
    const ok = run({ authorization: 'Bearer secret-token' });
    expect(await ok.passed).toBe(true);
  });

  it('404s an unknown session', async () => {
    const out = await archive('nope');
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('SESSION_NOT_FOUND');
    const out2 = await unarchive('nope');
    expect(out2.status).toBe(404);
  });

  it('400s a malformed body', async () => {
    const out = await archive('claude-1', { updatedAt: 'yesterday' });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('INVALID_REQUEST');
  });

  it('archive stamps archived + archivedAt in prefs and the list reflects it', async () => {
    const out = await archive();
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, sessionId: 'claude-1', archived: true });
    expect(typeof out.body.archivedAt).toBe('number');
    const prefs = await readPrefs();
    const rec = Object.values(prefs.sessions)[0] as any;
    expect(rec.archived).toBe(true);
    expect(rec.archivedAt).toBe(out.body.archivedAt);
    expect(await listArchived('claude-1')).toBe(true);
  });

  it('re-archive is idempotent and keeps the original archivedAt stamp', async () => {
    const first = await archive();
    await new Promise((r) => setTimeout(r, 5));
    const second = await archive();
    expect(second.status).toBe(200);
    expect(second.body.archived).toBe(true);
    expect(second.body.archivedAt).toBe(first.body.archivedAt);
  });

  it('unarchive clears the archive and is idempotent; LWW rejects a stale updatedAt', async () => {
    const stamped = await archive(undefined, { updatedAt: 2_000_000_000_000 });
    expect(stamped.status).toBe(200);
    // A stale unarchive (older than the archive record) is rejected by LWW.
    const stale = await unarchive(undefined, { updatedAt: 1_000_000_000_000 });
    expect(stale.status).toBe(200);
    expect(await listArchived('claude-1')).toBe(true);
    // A fresh unarchive clears it.
    const cleared = await unarchive(undefined, { updatedAt: 3_000_000_000_000 });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ ok: true, sessionId: 'claude-1', archived: false });
    expect(await listArchived('claude-1')).toBe(false);
    const prefs = await readPrefs();
    const rec = Object.values(prefs.sessions)[0] as any;
    expect(rec.archived).toBeUndefined();
    expect(rec.archivedAt).toBeUndefined();
    // Unarchiving something never archived is a no-op success.
    const again = await unarchive();
    expect(again.status).toBe(200);
  });

  it('refuses archive of a prefs-pinned session with 409 SESSION_PINNED', async () => {
    const prefs = await readPrefs();
    prefs.sessions['claude:claude-1'] = { pinned: true, updatedAt: 1, legacyKey: 'claude-1' };
    await fs.writeFile(prefsPath, JSON.stringify(prefs), 'utf8');
    const out = await archive();
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('SESSION_PINNED');
    expect(await listArchived('claude-1')).toBe(false);
  });

  it('refuses archive of an API-pinned session with 409 SESSION_PINNED', async () => {
    // Pin through the API's own control surface (real PinExpiryManager lease).
    const res = mockRes();
    await routes.handleSessionControl(jsonReq('POST', '/api/v1/sessions/claude-1/control', { action: 'pin' }), res, 'claude-1');
    expect(res.statusCode).toBe(200);
    const out = await archive();
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('SESSION_PINNED');
  });

  it('refuses archive of a session with a live turn with 409 SESSION_BUSY', async () => {
    claudeService.isRunning.mockReturnValue(true);
    const out = await archive();
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('SESSION_BUSY');
    expect(await listArchived('claude-1')).toBe(false);
    // Unarchive stays allowed (it only restores visibility).
    claudeService.isRunning.mockReturnValue(false);
    await archive();
    claudeService.isRunning.mockReturnValue(true);
    const undone = await unarchive();
    expect(undone.status).toBe(200);
  });

  it('archives a Command Code session through its service record', async () => {
    commandCodeRecords.set('cc-1', {
      sessionId: 'cc-1', executionInstanceId: 'default', cwd: '/tmp', modelSelector: 'm', effort: 'low', defaultEffort: 'low',
      state: 'idle', messageCount: 0, firstMessage: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const out = await archive('cc-1');
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, sessionId: 'cc-1', archived: true });
    expect(await listArchived('cc-1')).toBe(true);
    const undone = await unarchive('cc-1');
    expect(undone.status).toBe(200);
    expect(await listArchived('cc-1')).toBe(false);
  });

  it('refuses archive of a running Command Code session', async () => {
    commandCodeRecords.set('cc-2', {
      sessionId: 'cc-2', executionInstanceId: 'default', cwd: '/tmp', modelSelector: 'm', effort: 'low', defaultEffort: 'low',
      state: 'idle', messageCount: 0, firstMessage: '', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    commandCodeService.isRunning.mockReturnValue(true);
    const out = await archive('cc-2');
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('SESSION_BUSY');
  });
});

/**
 * Contract 1.65.0 (command-centre step 1k) — `sessionClass` on the Internal API.
 *
 * The class is recorded ONCE at creation: a caller may declare
 * `sessionClass: "validation"` (any other value is a 400 with a clear code) or
 * the server derives it from the validation-server marker
 * (`PI_WEB_UI_VALIDATION_MODE`, the same marker the existing validation mode
 * uses). `ephemeral`/`scenarioId` deliberately do NOT derive a class — they are
 * accepted-but-unused body fields today, and the validation harness runs
 * against a server that carries the marker anyway. "child" is never stored:
 * readers derive it from parentSessionId. The stored value is additive on
 * create responses, GET /sessions items, GET /sessions/:id and /native.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import {
  createSessionBodySchema,
  batchCreateBodySchema,
  adoptNativeBodySchema,
  sessionControlBodySchema,
  adoptSessionBodySchema,
} from '../../../src/internal-api/session-validation.js';

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

describe('sessionClass — schema validation (only "validation" is storable)', () => {
  it('accepts "validation" on single create, batch entries and adopt-native', () => {
    expect(createSessionBodySchema.safeParse({ runtime: 'claude', sessionClass: 'validation' }).success).toBe(true);
    expect(batchCreateBodySchema.safeParse({ sessions: [{ runtime: 'pi', sessionClass: 'validation' }] }).success).toBe(true);
    expect(adoptNativeBodySchema.safeParse({ runtime: 'claude', nativeId: 'abc123', sessionClass: 'validation' }).success).toBe(true);
  });

  it('rejects every other value with a message naming the only storable value', () => {
    for (const v of ['child', 'mine', 'real', true, '', 'VALIDATION']) {
      const parsed = createSessionBodySchema.safeParse({ runtime: 'claude', sessionClass: v });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => /sessionClass/.test(i.message))).toBe(true);
      }
      expect(batchCreateBodySchema.safeParse({ sessions: [{ runtime: 'pi', sessionClass: v }] }).success).toBe(false);
      expect(adoptNativeBodySchema.safeParse({ runtime: 'claude', nativeId: 'abc123', sessionClass: v }).success).toBe(false);
    }
    expect(createSessionBodySchema.safeParse({ runtime: 'claude' }).success).toBe(true);
  });

  it('offers no post-create surface: adopt and control schemas reject the field (recorded once at creation)', () => {
    expect(adoptSessionBodySchema.safeParse({ parentSessionId: 'p1', sessionClass: 'validation' }).success).toBe(false);
    expect(sessionControlBodySchema.safeParse({ action: 'pin', sessionClass: 'validation' }).success).toBe(false);
  });
});

describe('sessionClass — create, batch, adopt-native and echoing', () => {
  let dir: string;
  let registry: any;
  let entries: Map<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let antigravityService: any;
  let claudeProjectsDir: string;
  let antigravityConversationsDir: string;
  let antigravityDesktopConversationsDir: string;
  let commandCodeCliHomeDir: string;
  let commandCodeNativeHomeDir: string;
  let opencodeStorageDir: string;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-session-class-'));
    claudeProjectsDir = path.join(dir, 'claude-projects');
    antigravityConversationsDir = path.join(dir, 'agy-conversations');
    antigravityDesktopConversationsDir = path.join(dir, 'agy-desktop-conversations');
    commandCodeCliHomeDir = path.join(dir, 'commandcode-home');
    commandCodeNativeHomeDir = path.join(dir, 'commandcode-native-home');
    opencodeStorageDir = path.join(dir, 'opencode-storage');
    entries = new Map();
    registry = {
      get: vi.fn(async (id: string) => entries.get(id)),
      getByPath: vi.fn(async () => undefined),
      listAll: vi.fn(async () => Array.from(entries.values())),
      upsert: vi.fn(async (e: any) => { entries.set(e.id, { ...(entries.get(e.id) ?? {}), ...e }); return entries.get(e.id); }),
      patchSessionMeta: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    let n = 0;
    antigravityService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn().mockResolvedValue(null),
      createSession: vi.fn(async () => {
        n += 1;
        const id = `agy-${n}`;
        entries.set(id, { id, path: id, sdkType: 'antigravity', cwd: os.tmpdir(), firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '' });
        return { sessionId: id };
      }),
    };
    routes = createSessionRoutes({
      claudeService: {
        isRunning: vi.fn(() => false),
        getSessionStats: vi.fn(async () => null),
        getContextUsage: vi.fn(async () => null),
        getBackendMode: vi.fn(async () => 'sdk'),
        isSessionPinned: vi.fn(() => false),
      } as any,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService,
      multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      preferencesPath: path.join(dir, 'prefs.json'),
      watchDir: path.join(dir, 'watches'),
      claudeProjectsDir,
      commandCodeCliHomeDir,
      commandCodeNativeHomeDir,
      opencodeStorageDir,
      antigravityConversationsDir,
      antigravityDesktopConversationsDir,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function create(body: unknown) {
    const res = mockRes();
    await routes.handleCreateSession(jsonReq('POST', '/api/v1/sessions', body), res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function list() {
    const res = mockRes();
    await routes.handleListSessions(jsonReq('GET', '/api/v1/sessions'), res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function detail(id: string) {
    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', `/api/v1/sessions/${id}`), res, id);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('stores and echoes a caller-declared class on create', async () => {
    const out = await create({ runtime: 'antigravity', cwd: os.tmpdir(), sessionClass: 'validation' });
    expect(out.status).toBe(201);
    expect(out.body.sessionClass).toBe('validation');
    expect(entries.get(out.body.sessionId).sessionClass).toBe('validation');
    expect(entries.get(out.body.sessionId).origin).toBe('internal-api');
  });

  it('leaves the class absent when omitted outside validation mode', async () => {
    const out = await create({ runtime: 'antigravity', cwd: os.tmpdir() });
    expect(out.status).toBe(201);
    expect('sessionClass' in out.body).toBe(false);
    expect('sessionClass' in entries.get(out.body.sessionId)).toBe(false);
    const listed = await list();
    const item = listed.body.sessions.find((s: any) => s.sessionId === out.body.sessionId);
    expect('sessionClass' in item).toBe(false);
    const d = await detail(out.body.sessionId);
    expect(d.status).toBe(200);
    expect('sessionClass' in d.body).toBe(false);
  });

  it('400s a non-validation value before creating anything, with a clear message', async () => {
    const out = await create({ runtime: 'antigravity', cwd: os.tmpdir(), sessionClass: 'child' });
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(out.body)).toMatch(/sessionClass/);
    expect(antigravityService.createSession).not.toHaveBeenCalled();
  });

  it('derives the class from the validation-server marker (PI_WEB_UI_VALIDATION_MODE)', async () => {
    vi.stubEnv('PI_WEB_UI_VALIDATION_MODE', 'true');
    const out = await create({ runtime: 'antigravity', cwd: os.tmpdir() });
    expect(out.status).toBe(201);
    expect(out.body.sessionClass).toBe('validation');
    expect(entries.get(out.body.sessionId).sessionClass).toBe('validation');
    const listed = await list();
    const item = listed.body.sessions.find((s: any) => s.sessionId === out.body.sessionId);
    expect(item.sessionClass).toBe('validation');
    const d = await detail(out.body.sessionId);
    expect(d.body.sessionClass).toBe('validation');
  });

  it('does not derive the class from ephemeral or scenarioId (documented choice)', async () => {
    const out = await create({ runtime: 'antigravity', cwd: os.tmpdir(), ephemeral: true, scenarioId: 'some-scenario' });
    expect(out.status).toBe(201);
    expect('sessionClass' in out.body).toBe(false);
    expect('sessionClass' in entries.get(out.body.sessionId)).toBe(false);
  });

  it('batch create stamps and echoes the class per entry', async () => {
    const res = mockRes();
    await routes.handleBatchCreate(jsonReq('POST', '/api/v1/sessions/batch', {
      sessions: [
        { runtime: 'antigravity', cwd: os.tmpdir(), sessionClass: 'validation' },
        { runtime: 'antigravity', cwd: os.tmpdir() },
      ],
    }), res);
    const body = JSON.parse(res.body);
    expect(body.createdCount).toBe(2);
    const [a, b] = body.created;
    expect(a.sessionClass).toBe('validation');
    expect(entries.get(a.sessionId).sessionClass).toBe('validation');
    expect('sessionClass' in b).toBe(false);
    expect('sessionClass' in entries.get(b.sessionId)).toBe(false);
  });

  it('GET /sessions items and GET /sessions/:id echo the stored class additively', async () => {
    entries.set('claude-1', {
      id: 'claude-1', path: 'claude-1', sdkType: 'claude', cwd: os.tmpdir(), firstMessage: '', messageCount: 0,
      status: 'idle', createdAt: '', lastActivity: '', origin: 'internal-api', sessionClass: 'validation',
    });
    entries.set('claude-2', {
      id: 'claude-2', path: 'claude-2', sdkType: 'claude', cwd: os.tmpdir(), firstMessage: '', messageCount: 0,
      status: 'idle', createdAt: '', lastActivity: '',
    });
    const listed = await list();
    const byId = Object.fromEntries(listed.body.sessions.map((s: any) => [s.sessionId, s]));
    expect(byId['claude-1'].sessionClass).toBe('validation');
    expect('sessionClass' in byId['claude-2']).toBe(false);
    const d1 = await detail('claude-1');
    expect(d1.body.sessionClass).toBe('validation');
    const d2 = await detail('claude-2');
    expect('sessionClass' in d2.body).toBe(false);
  });

  it('a parentSessionId never stores a class ("child" is derived by readers)', async () => {
    const out = await create({ runtime: 'antigravity', cwd: os.tmpdir(), parentSessionId: 'some-parent' });
    expect(out.status).toBe(201);
    expect('sessionClass' in out.body).toBe(false);
    expect('sessionClass' in entries.get(out.body.sessionId)).toBe(false);
  });

  it('adopt-native stamps the class on a CREATED entry and refuses it on an existing one', async () => {
    // Seed a native claude artefact on disk for adopt-native to resolve.
    const nativeId = 'bbbbbbbb-2222-4222-8222-000000000001';
    const cwdDir = `/tmp/classscan${Math.floor(Math.random() * 1e9).toString(36)}`;
    const encoded = cwdDir.split(path.sep).filter(Boolean).join('-');
    const jsonl = path.join(claudeProjectsDir, encoded, `${nativeId}.jsonl`);
    await fs.mkdir(path.dirname(jsonl), { recursive: true });
    await fs.writeFile(jsonl, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n', 'utf-8');

    const created = mockRes();
    await routes.handleAdoptNativeSession(jsonReq('POST', '/api/v1/sessions/adopt-native', {
      runtime: 'claude', nativeId, cwd: cwdDir, sessionClass: 'validation',
    }), created);
    expect(created.statusCode).toBe(200);
    const createdBody = JSON.parse(created.body);
    expect(createdBody.adopted).toBe('created');
    expect(createdBody.sessionClass).toBe('validation');
    expect(entries.get(createdBody.sessionId).sessionClass).toBe('validation');

    // Same native id again: the entry exists, its class was recorded at ITS
    // creation — a new adopt-native cannot change it.
    const again = mockRes();
    await routes.handleAdoptNativeSession(jsonReq('POST', '/api/v1/sessions/adopt-native', {
      runtime: 'claude', nativeId, sessionClass: 'validation',
    }), again);
    expect(again.statusCode).toBe(400);
    expect(JSON.parse(again.body).error).toMatch(/sessionClass/);
  });

  it('GET /sessions/native echoes the class for registry-known native sessions', async () => {
    const nativeId = 'cccccccc-3333-4333-8333-000000000001';
    entries.set('claude-known', {
      id: 'claude-known', path: 'claude-known', sdkType: 'claude', claudeSessionId: nativeId,
      cwd: os.tmpdir(), firstMessage: '', messageCount: 0, status: 'idle',
      createdAt: '', lastActivity: '', sessionClass: 'validation',
    });
    const cwdDir = `/tmp/classscan${Math.floor(Math.random() * 1e9).toString(36)}`;
    const encoded = cwdDir.split(path.sep).filter(Boolean).join('-');
    const jsonl = path.join(claudeProjectsDir, encoded, `${nativeId}.jsonl`);
    await fs.mkdir(path.dirname(jsonl), { recursive: true });
    await fs.writeFile(jsonl, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n', 'utf-8');

    const res = mockRes();
    await routes.handleListNativeSessions(jsonReq('GET', '/api/v1/sessions/native?runtime=claude'), res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const item = body.sessions.find((s: any) => s.registrySessionId === 'claude-known');
    expect(item).toBeDefined();
    expect(item.sessionClass).toBe('validation');
  });
});

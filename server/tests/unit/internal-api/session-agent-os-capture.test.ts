/**
 * Contract 1.47.0 — Amendment 1 (owner decision 2026-09-25): per-session
 * `agentOsCapture` opt-in ("enabled" | "disabled"; absent = unspecified).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { createSessionBodySchema, batchCreateBodySchema } from '../../../src/internal-api/session-validation.js';
import { SessionRegistryManager } from '../../../src/session-registry.js';
import {
  PI_WEB_UI_AGENT_OS_CAPTURE_ENV,
  applySessionIdentityEnv,
  sessionIdentityFromEntry,
} from '../../../src/session-env-identity.js';

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


describe('agentOsCapture — validation, env and registry', () => {
  it('accepts enabled/disabled on single and batch create, rejects anything else', () => {
    for (const v of ['enabled', 'disabled']) {
      expect(createSessionBodySchema.safeParse({ runtime: 'claude', agentOsCapture: v }).success).toBe(true);
      expect(batchCreateBodySchema.safeParse({ sessions: [{ runtime: 'pi', agentOsCapture: v }] }).success).toBe(true);
    }
    for (const v of ['maybe', true, '', 'ENABLED']) {
      expect(createSessionBodySchema.safeParse({ runtime: 'claude', agentOsCapture: v }).success).toBe(false);
      expect(batchCreateBodySchema.safeParse({ sessions: [{ runtime: 'pi', agentOsCapture: v }] }).success).toBe(false);
    }
    expect(createSessionBodySchema.safeParse({ runtime: 'claude' }).success).toBe(true);
  });

  it('exports PI_WEB_UI_AGENT_OS_CAPTURE only when set, never an inherited value', () => {
    expect(PI_WEB_UI_AGENT_OS_CAPTURE_ENV).toBe('PI_WEB_UI_AGENT_OS_CAPTURE');
    const set = applySessionIdentityEnv({}, { sessionId: 's', agentOsCapture: 'disabled' });
    expect(set.PI_WEB_UI_AGENT_OS_CAPTURE).toBe('disabled');
    const unset = applySessionIdentityEnv({ PI_WEB_UI_AGENT_OS_CAPTURE: 'enabled' }, { sessionId: 's' });
    expect('PI_WEB_UI_AGENT_OS_CAPTURE' in unset).toBe(false);
    expect(sessionIdentityFromEntry({ id: 'x', agentOsCapture: 'enabled' })).toEqual({ sessionId: 'x', agentOsCapture: 'enabled' });
    expect(sessionIdentityFromEntry({ id: 'x', agentOsCapture: 'bogus' } as never)).toEqual({ sessionId: 'x' });
  });

  it('persists agentOsCapture on a new registry entry and survives reload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-os-capture-reg-'));
    const file = path.join(dir, 'registry.json');
    const reg = new SessionRegistryManager(file);
    await reg.upsert({ id: 'cap-1', sdkType: 'claude', cwd: '/tmp', origin: 'internal-api', agentOsCapture: 'enabled' });
    await reg.upsert({ id: 'cap-2', sdkType: 'claude', cwd: '/tmp' });
    await reg.upsert({ id: 'cap-2', sdkType: 'claude', cwd: '/tmp', agentOsCapture: 'disabled' });
    const reloaded = new SessionRegistryManager(file);
    expect((await reloaded.get('cap-1'))?.agentOsCapture).toBe('enabled');
    expect((await reloaded.get('cap-2'))?.agentOsCapture).toBe('disabled');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('agentOsCapture — create, batch create and GET session', () => {
  let dir: string;
  let registry: any;
  let entries: Map<string, any>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let antigravityService: any;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-os-capture-'));
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
      createSession: vi.fn(async () => {
        n += 1;
        const id = `agy-${n}`;
        entries.set(id, { id, path: id, sdkType: 'antigravity', cwd: '/root/proj', firstMessage: '', messageCount: 0, status: 'idle', createdAt: '', lastActivity: '' });
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
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function create(body: unknown) {
    const res = mockRes();
    await routes.handleCreateSession(jsonReq('POST', '/api/v1/sessions', body), res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('stores and echoes agentOsCapture on create', async () => {
    const out = await create({ runtime: 'antigravity', cwd: '/root/proj', agentOsCapture: 'disabled' });
    expect(out.status).toBe(201);
    expect(out.body.agentOsCapture).toBe('disabled');
    expect(entries.get(out.body.sessionId).agentOsCapture).toBe('disabled');
    expect(entries.get(out.body.sessionId).origin).toBe('internal-api');
  });

  it('leaves the create response and registry untouched when omitted', async () => {
    const out = await create({ runtime: 'antigravity', cwd: '/root/proj' });
    expect(out.status).toBe(201);
    expect('agentOsCapture' in out.body).toBe(false);
    expect('agentOsCapture' in entries.get(out.body.sessionId)).toBe(false);
  });

  it('400s an invalid value before creating anything', async () => {
    const out = await create({ runtime: 'antigravity', cwd: '/root/proj', agentOsCapture: 'maybe' });
    expect(out.status).toBe(400);
    expect(antigravityService.createSession).not.toHaveBeenCalled();
  });

  it('batch create stores and echoes it per entry', async () => {
    const res = mockRes();
    await routes.handleBatchCreate(jsonReq('POST', '/api/v1/sessions/batch', {
      sessions: [
        { runtime: 'antigravity', cwd: '/root/proj', agentOsCapture: 'enabled' },
        { runtime: 'antigravity', cwd: '/root/proj' },
      ],
    }), res);
    const body = JSON.parse(res.body);
    expect(body.createdCount).toBe(2);
    const [a, b] = body.created;
    expect(a.agentOsCapture).toBe('enabled');
    expect(entries.get(a.sessionId).agentOsCapture).toBe('enabled');
    expect('agentOsCapture' in b).toBe(false);
    expect('agentOsCapture' in entries.get(b.sessionId)).toBe(false);
  });

  it('GET /sessions/:id reports the stored value', async () => {
    entries.set('claude-1', {
      id: 'claude-1', path: 'claude-1', sdkType: 'claude', cwd: '/root/proj', firstMessage: '', messageCount: 0,
      status: 'idle', createdAt: '', lastActivity: '', origin: 'internal-api', agentOsCapture: 'enabled',
    });
    entries.set('claude-2', {
      id: 'claude-2', path: 'claude-2', sdkType: 'claude', cwd: '/root/proj', firstMessage: '', messageCount: 0,
      status: 'idle', createdAt: '', lastActivity: '',
    });
    const r1 = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/claude-1'), r1, 'claude-1');
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body).agentOsCapture).toBe('enabled');
    const r2 = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/claude-2'), r2, 'claude-2');
    expect('agentOsCapture' in JSON.parse(r2.body)).toBe(false);
  });
});

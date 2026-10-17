// Contract 1.64.0 — native session id surfacing (census Q1 / step 1i):
// Pi Web UI's registry ids are not the ids the runtimes' own processes and
// transcripts run under. A Claude session's registry claudeSessionId is a
// Pi Web UI-minted resume hint until the CLI reports its real id; an
// Antigravity entry carries no conversation id until a turn finalises.
// The Internal API now exposes the runtime-native id additively as
// `nativeSessionId` on GET /sessions items and GET /sessions/:id, so a
// supervisor (e.g. the command centre) can join a registry session to its
// process/transcript row by an exact token instead of folder+start-time
// heuristics (BUGS.md rows 2 and 18).
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';

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

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    path: 'session-1',
    sdkType: 'claude',
    cwd: '/root/proj',
    model: 'sonnet',
    firstMessage: 'first',
    messageCount: 1,
    status: 'idle',
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivity: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const CLAUDE_CONFIRMED_NATIVE = '16226315-runtime-minted-claude-id';
const AGY_CONV = '6ed85b11-antigravity-conversation';

describe('Internal API native session id surfacing (contract 1.64.0)', () => {
  let dir: string;
  let prefsPath: string;
  let registry: any;
  let commandCodeService: any;
  let claudeService: any;
  let antigravityService: any;
  let routes: ReturnType<typeof createSessionRoutes>;

  const getList = async (url = '/api/v1/sessions'): Promise<{ status: number; body: any }> => {
    const res = mockRes();
    await routes.handleListSessions(jsonReq('GET', url), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  const getDetail = async (sessionId: string): Promise<{ status: number; body: any }> => {
    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', `/api/v1/sessions/${sessionId}`), res, sessionId);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-native-sid-'));
    prefsPath = path.join(dir, 'prefs.json');
    registry = {
      get: vi.fn(async (id: string) => {
        const all = await registry.listAll();
        return all.find((e: any) => e.id === id);
      }),
      getByPath: vi.fn(),
      listAll: vi.fn().mockResolvedValue([
        // Claude: confirmed — claudeSessionId already rewritten to the runtime
        // id and nativeSessionId recorded at the same moment.
        entry({ id: 'claude-confirmed', path: 'claude-confirmed', claudeSessionId: CLAUDE_CONFIRMED_NATIVE, nativeSessionId: CLAUDE_CONFIRMED_NATIVE, lastActivity: '2026-08-05T00:00:00.000Z' }),
        // Claude: created but never prompted — only the minted placeholder.
        entry({ id: 'claude-fresh', path: 'claude-fresh', claudeSessionId: 'db0cbcc2-minted-placeholder', lastActivity: '2026-08-04T00:00:00.000Z' }),
        // Antigravity: conversation id known (init or turn end).
        entry({ id: 'agy-known', path: 'agy-known', sdkType: 'antigravity', antigravityConversationId: AGY_CONV, lastActivity: '2026-08-03T00:00:00.000Z' }),
        // OpenCode: the server-side session id IS native and present from creation.
        entry({ id: 'oc-1', path: 'oc-1', sdkType: 'opencode', opencodeSessionId: 'oc-native-1', lastActivity: '2026-08-02T00:00:00.000Z' }),
      ]),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    commandCodeService = {
      isEnabled: vi.fn(() => false),
      listSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue(null),
      findSession: vi.fn().mockResolvedValue(null),
    };
    claudeService = {
      isRunning: vi.fn(() => false),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn(async (id: string) => ({
        sessionId: id,
        cwd: '/root/proj',
        sessionFile: id,
        model: 'sonnet',
        userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
        cost: 0, pinned: false, lastActivityAt: 1,
      })),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    antigravityService = {
      isRunning: vi.fn(() => false),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn().mockResolvedValue(null),
    };
    routes = createSessionRoutes({
      claudeService,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService,
      multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      preferencesPath: prefsPath,
      commandCodeService,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('GET /sessions items carry nativeSessionId per runtime (additive)', async () => {
    const { status, body } = await getList();
    expect(status).toBe(200);
    const byId = Object.fromEntries(body.sessions.map((s: any) => [s.sessionId, s]));
    expect(byId['claude-confirmed'].nativeSessionId).toBe(CLAUDE_CONFIRMED_NATIVE);
    expect(byId['claude-fresh'].nativeSessionId).toBeUndefined();
    expect(byId['agy-known'].nativeSessionId).toBe(AGY_CONV);
    expect(byId['oc-1'].nativeSessionId).toBe('oc-native-1');
  });

  it('GET /sessions/:id reports the Claude NATIVE session id, not the Pi Web UI registry uuid (correction)', async () => {
    const { status, body } = await getDetail('claude-confirmed');
    expect(status).toBe(200);
    expect(body.nativeSessionId).toBe(CLAUDE_CONFIRMED_NATIVE);
    expect(body.nativeSessionId).not.toBe('claude-confirmed');
  });

  it('GET /sessions/:id leaves nativeSessionId absent for a never-prompted Claude session', async () => {
    const { status, body } = await getDetail('claude-fresh');
    expect(status).toBe(200);
    expect(body.nativeSessionId).toBeUndefined();
  });

  it('GET /sessions/:id carries the Antigravity conversation id as nativeSessionId', async () => {
    const { status, body } = await getDetail('agy-known');
    expect(status).toBe(200);
    expect(body.nativeSessionId).toBe(AGY_CONV);
  });
});

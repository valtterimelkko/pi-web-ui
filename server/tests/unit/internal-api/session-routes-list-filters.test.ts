// Contract 1.30.0 — GET /api/v1/sessions additive list ergonomics (A1+A2):
//  - A1: server-side filters ?runtime= ?limit= ?since= ?cwd= + deterministic
//    lastActivity-descending order. No params → unchanged back-compat response.
//  - A2: additive per-entry `archived` (from web UI preferences, same key
//    derivation the browser uses) and `source` (registry entry origin:
//    browser | internal-api | native-discovered | unknown for legacy entries).
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

const PI_UUID_A = '11111111-1111-4111-8111-111111111111';
const PI_UUID_B = '22222222-2222-4222-8222-222222222222';

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

describe('Internal API session list filters and fields (contract 1.30.0)', () => {
  let dir: string;
  let prefsPath: string;
  let registry: any;
  let commandCodeService: any;
  let routes: ReturnType<typeof createSessionRoutes>;

  const getList = async (url = '/api/v1/sessions'): Promise<{ status: number; body: any }> => {
    const res = mockRes();
    await routes.handleListSessions(jsonReq('GET', url), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-list-filters-'));
    prefsPath = path.join(dir, 'prefs.json');
    registry = {
      get: vi.fn(),
      getByPath: vi.fn(),
      listAll: vi.fn().mockResolvedValue([
        // Deliberately unsorted input; oldest first.
        entry({ id: 'old-claude', path: 'old-claude', sdkType: 'claude', cwd: '/root/proj', lastActivity: '2026-08-01T00:00:00.000Z' }),
        entry({
          id: PI_UUID_A, path: `/root/.pi/agent/sessions/--root-proj--/2026-08-02T00-00-00-000Z_${PI_UUID_A}.jsonl`,
          sdkType: 'pi', cwd: '/root/proj', lastActivity: '2026-08-03T00:00:00.000Z', origin: 'native-discovered',
        }),
        entry({ id: 'new-claude', path: 'new-claude', sdkType: 'claude', cwd: '/root/other', lastActivity: '2026-08-05T00:00:00.000Z', origin: 'internal-api' }),
        entry({
          id: PI_UUID_B, path: `/root/.pi/agent/sessions/--root-other--/2026-08-04T00-00-00-000Z_${PI_UUID_B}.jsonl`,
          sdkType: 'pi', cwd: '/root/other', lastActivity: '2026-08-04T00:00:00.000Z', origin: 'browser',
        }),
      ]),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    commandCodeService = {
      isEnabled: vi.fn(() => true),
      listSessions: vi.fn().mockResolvedValue([
        {
          sessionId: 'commandcode-abc', executionInstanceId: 'exec-1', cwd: '/root/proj',
          modelSelector: 'meta/muse-spark-1.2-contributor', state: 'idle', messageCount: 2,
          firstMessage: 'cmdc hello', createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T01:00:00.000Z',
        },
      ]),
    };
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false) } as any,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false) } as any,
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

  describe('A1: server-side filters', () => {
    it('sorts by lastActivity descending by default and keeps the full back-compat payload', async () => {
      const { status, body } = await getList();
      expect(status).toBe(200);
      const ids = body.sessions.map((s: any) => s.sessionId);
      expect(ids).toEqual([
        'commandcode-abc',
        'new-claude',
        PI_UUID_B,
        PI_UUID_A,
        'old-claude',
      ]);
      // Pre-existing fields remain untouched.
      expect(body.sessions[1]).toMatchObject({ sessionId: 'new-claude', runtime: 'claude', cwd: '/root/other', busy: false });
    });

    it('filters by a single runtime', async () => {
      const { body } = await getList('/api/v1/sessions?runtime=pi');
      expect(body.sessions.map((s: any) => s.runtime)).toEqual(['pi', 'pi']);
      expect(body.sessions.map((s: any) => s.sessionId)).toEqual([PI_UUID_B, PI_UUID_A]);
    });

    it('filters by multiple comma-separated runtimes', async () => {
      const { body } = await getList('/api/v1/sessions?runtime=claude,commandcode');
      expect(body.sessions.map((s: any) => s.runtime).sort()).toEqual(['claude', 'claude', 'commandcode']);
    });

    it('rejects an unknown runtime with 400 INVALID_REQUEST', async () => {
      const { status, body } = await getList('/api/v1/sessions?runtime=banana');
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_REQUEST');
      expect(body.error).toMatch(/runtime/i);
    });

    it('caps results with limit', async () => {
      const { body } = await getList('/api/v1/sessions?limit=2');
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions.map((s: any) => s.sessionId)).toEqual(['commandcode-abc', 'new-claude']);
    });

    it('rejects a junk or out-of-range limit with 400', async () => {
      for (const bad of ['0', '-3', 'abc', '1.5']) {
        const { status, body } = await getList(`/api/v1/sessions?limit=${bad}`);
        expect(status, `limit=${bad}`).toBe(400);
        expect(body.code, `limit=${bad}`).toBe('INVALID_REQUEST');
      }
    });

    it('filters by since (ISO and epoch-ms) on lastActivity', async () => {
      const iso = await getList('/api/v1/sessions?since=2026-08-03T12:00:00.000Z');
      expect(iso.body.sessions.map((s: any) => s.sessionId)).toEqual(['commandcode-abc', 'new-claude', PI_UUID_B]);

      const epoch = await getList(`/api/v1/sessions?since=${Date.parse('2026-08-05T00:00:00.000Z')}`);
      expect(epoch.body.sessions.map((s: any) => s.sessionId)).toEqual(['commandcode-abc', 'new-claude']);
    });

    it('rejects a junk since with 400', async () => {
      const { status, body } = await getList('/api/v1/sessions?since=not-a-date');
      expect(status).toBe(400);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('filters by exact cwd', async () => {
      const { body } = await getList('/api/v1/sessions?cwd=%2Froot%2Fother');
      expect(body.sessions.map((s: any) => s.sessionId)).toEqual(['new-claude', PI_UUID_B]);
    });

    it('combines filters (runtime + limit)', async () => {
      const { body } = await getList('/api/v1/sessions?runtime=pi,claude&limit=2');
      expect(body.sessions.map((s: any) => s.sessionId)).toEqual(['new-claude', PI_UUID_B]);
    });
  });

  describe('A2: archived and source fields', () => {
    it('reports archived=true for sessions archived in web UI preferences', async () => {
      // The browser archives by session.path; v2 key derivation:
      //   pi → pi:<uuid-from-path>, non-pi → <runtime>:<path>
      await fs.writeFile(prefsPath, JSON.stringify({
        version: 2,
        sessions: {
          [`pi:${PI_UUID_A}`]: { archived: true, archivedAt: 1754000000000, legacyKey: `/root/.pi/agent/sessions/--root-proj--/x_${PI_UUID_A}.jsonl` },
          'claude:old-claude': { archived: true },
        },
      }), 'utf-8');

      const { body } = await getList();
      const byId = new Map<string, any>(body.sessions.map((s: any) => [s.sessionId, s]));
      expect(byId.get(PI_UUID_A).archived).toBe(true);
      expect(byId.get('old-claude').archived).toBe(true);
      expect(byId.get('new-claude').archived).toBe(false);
      expect(byId.get(PI_UUID_B).archived).toBe(false);
      expect(byId.get('commandcode-abc').archived).toBe(false);
    });

    it('defaults archived=false when no preferences file exists', async () => {
      const { body } = await getList();
      expect(body.sessions.every((s: any) => s.archived === false)).toBe(true);
    });

    it('exposes source from the registry entry origin, unknown for legacy entries', async () => {
      const { body } = await getList();
      const byId = new Map<string, any>(body.sessions.map((s: any) => [s.sessionId, s]));
      expect(byId.get('new-claude').source).toBe('internal-api');
      expect(byId.get(PI_UUID_A).source).toBe('native-discovered');
      expect(byId.get(PI_UUID_B).source).toBe('browser');
      expect(byId.get('old-claude').source).toBe('unknown');
      expect(byId.get('commandcode-abc').source).toBe('unknown');
    });

    it('tags Internal-API-created sessions with origin internal-api via a registry upsert', async () => {
      const antigravityService = {
        isRunning: vi.fn(() => false),
        isAvailable: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ sessionId: 'new-agy-1' }),
      };
      routes = createSessionRoutes({
        claudeService: { isRunning: vi.fn(() => false) } as any,
        opencodeService: { isRunning: vi.fn(() => false) } as any,
        antigravityService: antigravityService as any,
        multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
        sessionRegistry: registry,
        piService: {} as any,
        internalClientId: 'test-client',
        preferencesPath: prefsPath,
      });

      const res = mockRes();
      await routes.handleCreateSession(
        jsonReq('POST', '/api/v1/sessions', { runtime: 'antigravity', cwd: '/root/proj' }),
        res,
      );
      expect(res.statusCode).toBe(201);

      const tagCall = registry.upsert.mock.calls.find(
        (c: any[]) => c[0]?.id === 'new-agy-1' && c[0]?.origin === 'internal-api',
      );
      expect(tagCall, 'expected an upsert carrying origin=internal-api for the created session').toBeTruthy();
    });
  });
});

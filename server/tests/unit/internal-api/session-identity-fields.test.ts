// Contract (next minor) — B5: additive `displayName` + `nativeSessionId` on
// `GET /api/v1/sessions` list items and `GET /api/v1/sessions/:id`.
//
// Red-first: these tests were written before the implementation. They pin:
//  - `nativeSessionId` derived from the registry entry by `sdkType`
//    (claude → claudeSessionId, antigravity → antigravityConversationId,
//    opencode → opencodeSessionId, pi → the Pi session id; commandcode from the
//    Command Code record's nativeSessionId), absent when the runtime has none;
//  - `displayName` live-resolved from the same web UI preferences the
//    notification header uses (a rename shows on the very next request, with no
//    restart);
//  - both fields on list items AND session detail.
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

const PI_UUID = '33333333-3333-4333-8333-333333333333';
const PI_PATH = `/root/.pi/agent/sessions/--root-proj--/2026-09-27T00-00-00-000Z_${PI_UUID}.jsonl`;

describe('Internal API session identity fields: displayName + nativeSessionId', () => {
  let dir: string;
  let prefsPath: string;
  let entries: any[];
  let registry: any;
  let commandCodeService: any;
  let routes: ReturnType<typeof createSessionRoutes>;

  const getList = async (): Promise<{ status: number; body: any }> => {
    const res = mockRes();
    await routes.handleListSessions(jsonReq('GET', '/api/v1/sessions'), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  const getDetail = async (id: string): Promise<{ status: number; body: any }> => {
    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', `/api/v1/sessions/${id}`), res, id);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-session-identity-'));
    prefsPath = path.join(dir, 'prefs.json');
    entries = [
      {
        id: PI_UUID, path: PI_PATH, sdkType: 'pi', cwd: '/root/proj',
        firstMessage: 'pi first', messageCount: 1, status: 'idle',
        createdAt: '2026-09-27T00:00:00.000Z', lastActivity: '2026-09-27T05:00:00.000Z',
      },
      {
        id: 'claude-internal-1', path: '/root/.claude/projects/-root-proj/claude-file.jsonl', sdkType: 'claude',
        claudeSessionId: 'claude-native-abc', cwd: '/root/proj',
        firstMessage: 'claude first', messageCount: 2, status: 'idle',
        createdAt: '2026-09-27T01:00:00.000Z', lastActivity: '2026-09-27T04:00:00.000Z',
      },
      {
        id: 'agy-internal-1', path: '/root/.gemini/antigravity/conversations/agy-1.jsonl', sdkType: 'antigravity',
        antigravityConversationId: 'agy-conv-xyz', cwd: '/root/proj',
        firstMessage: 'agy first', messageCount: 3, status: 'idle',
        createdAt: '2026-09-27T02:00:00.000Z', lastActivity: '2026-09-27T03:00:00.000Z',
      },
      {
        id: 'oc-internal-1', path: 'opencode-session-1', sdkType: 'opencode',
        opencodeSessionId: 'ses_opencode_1', cwd: '/root/proj',
        firstMessage: 'oc first', messageCount: 4, status: 'idle',
        createdAt: '2026-09-27T02:30:00.000Z', lastActivity: '2026-09-27T02:45:00.000Z',
      },
      {
        id: 'claude-no-native', path: 'claude-no-native', sdkType: 'claude', cwd: '/root/proj',
        firstMessage: 'no native', messageCount: 1, status: 'idle',
        createdAt: '2026-09-27T02:40:00.000Z', lastActivity: '2026-09-27T02:41:00.000Z',
      },
    ];
    registry = {
      get: vi.fn(async (id: string) => entries.find((e) => e.id === id || e.path === id)),
      getByPath: vi.fn(async (p: string) => entries.find((e) => e.path === p)),
      listAll: vi.fn(async () => entries),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    commandCodeService = {
      isEnabled: vi.fn(() => true),
      listSessions: vi.fn().mockResolvedValue([
        {
          sessionId: 'commandcode-abc', executionInstanceId: 'exec-1', cwd: '/root/proj',
          modelSelector: 'meta/muse-spark-1.2-contributor', state: 'idle', messageCount: 2,
          firstMessage: 'cmdc hello', createdAt: '2026-09-27T00:30:00.000Z', updatedAt: '2026-09-27T01:30:00.000Z',
          nativeSessionId: 'cmdc-native-9',
        },
      ]),
      getSession: vi.fn().mockResolvedValue(undefined),
      findSession: vi.fn().mockResolvedValue(undefined),
    };
    routes = createSessionRoutes({
      claudeService: {
        isRunning: vi.fn(() => false),
        isSessionPinned: vi.fn(() => false),
        getBackendMode: vi.fn().mockResolvedValue('sdk'),
        getSessionStats: vi.fn().mockResolvedValue(undefined),
        getContextUsage: vi.fn().mockReturnValue(undefined),
      } as any,
      opencodeService: {
        isRunning: vi.fn(() => false),
        isSessionPinned: vi.fn(() => false),
        getSessionStats: vi.fn().mockResolvedValue(undefined),
        getContextUsage: vi.fn().mockReturnValue(undefined),
      } as any,
      antigravityService: {
        isRunning: vi.fn(() => false),
        isSessionPinned: vi.fn(() => false),
        getSessionStats: vi.fn().mockResolvedValue(undefined),
      } as any,
      multiSessionManager: {
        getAgentSession: vi.fn(() => undefined),
        isSessionPinned: vi.fn(() => false),
      } as unknown as SessionRoutesDeps['multiSessionManager'],
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

  describe('nativeSessionId (by sdkType)', () => {
    it('is present on list items for every runtime that has a native id', async () => {
      const { status, body } = await getList();
      expect(status).toBe(200);
      const byId = new Map<string, any>(body.sessions.map((s: any) => [s.sessionId, s]));
      expect(byId.get(PI_UUID).nativeSessionId).toBe(PI_UUID); // Pi: the Pi session id
      expect(byId.get('claude-internal-1').nativeSessionId).toBe('claude-native-abc');
      expect(byId.get('agy-internal-1').nativeSessionId).toBe('agy-conv-xyz');
      expect(byId.get('oc-internal-1').nativeSessionId).toBe('ses_opencode_1');
      expect(byId.get('commandcode-abc').nativeSessionId).toBe('cmdc-native-9');
    });

    it('is absent on a list item whose runtime recorded no native id', async () => {
      const { body } = await getList();
      const item = body.sessions.find((s: any) => s.sessionId === 'claude-no-native');
      expect(item).toBeDefined();
      expect('nativeSessionId' in item).toBe(false);
    });

    it('is present on session detail for Pi even when no agent session is loaded', async () => {
      const { status, body } = await getDetail(PI_UUID);
      expect(status).toBe(200);
      expect(body.nativeSessionId).toBe(PI_UUID);
    });

    it('is present on antigravity session detail (previously absent)', async () => {
      const { status, body } = await getDetail('agy-internal-1');
      expect(status).toBe(200);
      expect(body.nativeSessionId).toBe('agy-conv-xyz');
    });

    it('is present on claude session detail from the registry entry', async () => {
      const { status, body } = await getDetail('claude-internal-1');
      expect(status).toBe(200);
      expect(body.nativeSessionId).toBe('claude-native-abc');
    });
  });

  describe('displayName (live from web UI preferences)', () => {
    it('is absent for every list item when no rename exists', async () => {
      const { body } = await getList();
      for (const item of body.sessions) {
        expect('displayName' in item, `${item.sessionId} should have no displayName`).toBe(false);
      }
    });

    it('resolves a path-keyed rename on list items and detail', async () => {
      await fs.writeFile(prefsPath, JSON.stringify({
        version: 2,
        sessions: {
          'claude:claude-internal-1': { displayName: 'My Claude Rename', updatedAt: 1, legacyKey: '/root/.claude/projects/-root-proj/claude-file.jsonl' },
        },
      }), 'utf-8');

      const list = await getList();
      const item = list.body.sessions.find((s: any) => s.sessionId === 'claude-internal-1');
      expect(item.displayName).toBe('My Claude Rename');
      // Other sessions are unaffected.
      expect('displayName' in list.body.sessions.find((s: any) => s.sessionId === PI_UUID)).toBe(false);

      const detail = await getDetail('claude-internal-1');
      expect(detail.body.displayName).toBe('My Claude Rename');
    });

    it('shows a rename on the very next request (no restart, live read)', async () => {
      const before = await getList();
      expect('displayName' in before.body.sessions.find((s: any) => s.sessionId === PI_UUID)).toBe(false);

      // The front end writes the rename by session path; legacyKey = sessionPath.
      await fs.writeFile(prefsPath, JSON.stringify({
        version: 2,
        sessions: { [`pi:${PI_UUID}`]: { displayName: 'Praxis Budget Check', updatedAt: 2, legacyKey: PI_PATH } },
      }), 'utf-8');

      const after = await getList();
      expect(after.body.sessions.find((s: any) => s.sessionId === PI_UUID).displayName).toBe('Praxis Budget Check');
    });

    it('also resolves a key-based (stable runtime:id) rename by the entry id', async () => {
      await fs.writeFile(prefsPath, JSON.stringify({
        version: 2,
        sessions: { [`pi:${PI_UUID}`]: { displayName: 'Key-based Name', updatedAt: 3 } },
      }), 'utf-8');

      const { body } = await getList();
      expect(body.sessions.find((s: any) => s.sessionId === PI_UUID).displayName).toBe('Key-based Name');
    });

    it('exposes displayName on session detail for the Pi session', async () => {
      await fs.writeFile(prefsPath, JSON.stringify({
        version: 2,
        sessions: { [`pi:${PI_UUID}`]: { displayName: 'Detail Name', updatedAt: 4, legacyKey: PI_PATH } },
      }), 'utf-8');
      const { status, body } = await getDetail(PI_UUID);
      expect(status).toBe(200);
      expect(body.displayName).toBe('Detail Name');
    });
  });
});

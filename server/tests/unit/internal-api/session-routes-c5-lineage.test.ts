// C5 (contract 1.54.0) — "lineage always recorded": route-level behaviour.
//  - Parent linkage on create now has a fourth source: peer-credential caller
//    resolution (parent-resolver.ts) when neither header, body nor in-flight
//    bash correlation can attribute the caller.
//  - Linkage records which source produced it: parentSource header|body|bash|peer.
//  - GET /sessions surfaces additive parentSessionId/parentSource and gains a
//    ?parent=<id-or-path> filter; adopt-native falls back to peer resolution.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { SessionRegistryManager } from '../../../src/session-registry.js';
import { INTERNAL_API_CONTRACT_VERSION } from '../../../src/internal-api/types.js';

function jsonReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json', ...headers };
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

const PARENT_ID = '11111111-1111-4111-8111-000000000001';
const OTHER_PARENT_ID = '11111111-1111-4111-8111-000000000009';

const NATIVE_CWD = `/tmp/c5-lineage${Math.floor(Math.random() * 1e9).toString(36)}`;
const encodeProject = (cwd: string): string => cwd.split(path.sep).filter(Boolean).join('-');

async function writeJsonl(filePath: string, lines: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

describe('C5: lineage always recorded (contract 1.54.0)', () => {
  let dir: string;
  let claudeProjectsDir: string;
  let registry: SessionRegistryManager;
  let registryPath: string;
  let antigravityService: any;
  let peerResolve: ReturnType<typeof createTestResolver>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let createdCount: number;

  function createTestResolver() {
    const calls: Array<{ resolved: boolean }> = [];
    return {
      calls,
      resolve: vi.fn(async () => {
        calls.push({ resolved: true });
        return { sessionId: PARENT_ID, source: 'peer' as const };
      }),
    };
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c5-lineage-'));
    claudeProjectsDir = path.join(dir, 'claude-projects');
    registryPath = path.join(dir, 'session-registry.json');
    registry = new SessionRegistryManager(registryPath);
    await registry.upsert({
      id: PARENT_ID,
      sdkType: 'pi',
      path: '/sessions/parent.jsonl',
      cwd: '/root/proj',
      firstMessage: 'parent',
      messageCount: 1,
      status: 'idle',
      createdAt: '2026-09-29T00:00:00.000Z',
      lastActivity: '2026-09-29T00:00:00.000Z',
    });
    createdCount = 0;
    antigravityService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn(async () => true),
      createSession: vi.fn(async () => {
        createdCount += 1;
        return { sessionId: `agy-child-${createdCount}` };
      }),
    };
    peerResolve = createTestResolver();
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false) } as any,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService,
      multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      claudeProjectsDir,
      preferencesPath: path.join(dir, 'prefs.json'),
      watchDir: path.join(dir, 'watches'),
      peerParentResolver: peerResolve as unknown as SessionRoutesDeps['peerParentResolver'],
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function create(body: unknown, headers: Record<string, string> = {}) {
    const res = mockRes();
    await routes.handleCreateSession(jsonReq('POST', '/api/v1/sessions', body, headers), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  const createBody = { runtime: 'antigravity', cwd: '/root/proj' };

  it('bumps the contract to 1.54.0', () => {
    expect(INTERNAL_API_CONTRACT_VERSION).toBe('1.54.0');
  });

  it('links via the X-Parent-Session header with parentSource "header" (unchanged header path)', async () => {
    const out = await create(createBody, { 'x-parent-session': PARENT_ID });
    expect(out.status).toBe(201);
    expect(out.body.parentSessionId).toBe(PARENT_ID);
    expect(out.body.parentSource).toBe('header');
    const entry = await registry.get(out.body.sessionId);
    expect(entry?.parentSessionId).toBe(PARENT_ID);
    expect(entry?.parentSource).toBe('header');
    expect(peerResolve.resolve).not.toHaveBeenCalled();
  });

  it('links via body parentSessionId with parentSource "body"', async () => {
    const out = await create({ ...createBody, parentSessionId: PARENT_ID });
    expect(out.status).toBe(201);
    expect(out.body.parentSource).toBe('body');
    expect((await registry.get(out.body.sessionId))?.parentSource).toBe('body');
    expect(peerResolve.resolve).not.toHaveBeenCalled();
  });

  it('falls back to peer-credential resolution when header, body and bash correlation are absent', async () => {
    const out = await create(createBody);
    expect(out.status).toBe(201);
    expect(out.body.parentSessionId).toBe(PARENT_ID);
    expect(out.body.parentSource).toBe('peer');
    expect(peerResolve.resolve).toHaveBeenCalledTimes(1);
    expect((await registry.get(out.body.sessionId))?.parentSessionId).toBe(PARENT_ID);
  });

  it('leaves the child unlinked when peer resolution cannot attribute the caller (fail safe)', async () => {
    peerResolve.resolve.mockResolvedValueOnce(null);
    const out = await create(createBody);
    expect(out.status).toBe(201);
    expect('parentSessionId' in out.body).toBe(false);
    expect('parentSource' in out.body).toBe(false);
    expect((await registry.get(out.body.sessionId))?.parentSessionId).toBeUndefined();
  });

  it('never reports a parentSource without a parentSessionId', async () => {
    peerResolve.resolve.mockResolvedValueOnce(null);
    const out = await create(createBody);
    expect('parentSource' in out.body).toBe(false);
  });

  describe('GET /sessions lineage surfacing and ?parent= filter', () => {
    let childA: string;
    let childB: string;

    beforeEach(async () => {
      childA = (await create(createBody, { 'x-parent-session': PARENT_ID })).body.sessionId;
      childB = (await create(createBody)).body.sessionId; // peer-resolved to PARENT_ID
      await create({ ...createBody, parentSessionId: OTHER_PARENT_ID });
      // An unlinked control session, created with peer resolution refusing.
      peerResolve.resolve.mockResolvedValueOnce(null);
      await registry.upsert({
        id: 'unlinked-1',
        sdkType: 'claude',
        path: '/sessions/unlinked.jsonl',
        cwd: '/root/proj',
        firstMessage: 'u',
        messageCount: 0,
        status: 'idle',
        createdAt: '2026-09-29T01:00:00.000Z',
        lastActivity: '2026-09-29T01:00:00.000Z',
      });
    });

    const getList = async (url = '/api/v1/sessions') => {
      const res = mockRes();
      await routes.handleListSessions(jsonReq('GET', url), res);
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
    };

    it('surfaces additive parentSessionId and parentSource on list items', async () => {
      const out = await getList();
      expect(out.status).toBe(200);
      const items = Object.fromEntries(out.body.sessions.map((s: any) => [s.sessionId, s]));
      expect(items[childA].parentSessionId).toBe(PARENT_ID);
      expect(items[childA].parentSource).toBe('header');
      expect(items[childB].parentSessionId).toBe(PARENT_ID);
      expect(items[childB].parentSource).toBe('peer');
      expect(items['unlinked-1'].parentSessionId).toBeUndefined();
      expect(items['unlinked-1'].parentSource).toBeUndefined();
    });

    it('?parent=<id> returns exactly the children of that parent', async () => {
      const out = await getList(`/api/v1/sessions?parent=${PARENT_ID}`);
      expect(out.status).toBe(200);
      const ids = out.body.sessions.map((s: any) => s.sessionId).sort();
      expect(ids).toEqual([childA, childB].sort());
    });

    it('?parent=<session-path> resolves to the canonical id', async () => {
      const out = await getList('/api/v1/sessions?parent=%2Fsessions%2Fparent.jsonl');
      expect(out.status).toBe(200);
      expect(out.body.sessions.map((s: any) => s.sessionId).sort()).toEqual([childA, childB].sort());
    });

    it('?parent=<unresolvable> is a 404, not a silently empty list', async () => {
      const out = await getList('/api/v1/sessions?parent=does-not-exist');
      expect(out.status).toBe(404);
      expect(out.body.code).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('adopt-native peer fallback', () => {
    beforeEach(async () => {
      await writeJsonl(path.join(claudeProjectsDir, encodeProject(NATIVE_CWD), 'native-c5-1.jsonl'), [
        { type: 'user', message: { content: 'native one' } },
      ]);
      await writeJsonl(path.join(claudeProjectsDir, encodeProject(NATIVE_CWD), 'native-c5-2.jsonl'), [
        { type: 'user', message: { content: 'native two' } },
      ]);
    });

    it('links a native session to the resolved caller when no explicit parent is given', async () => {
      const res = mockRes();
      await routes.handleAdoptNativeSession(
        jsonReq('POST', '/api/v1/sessions/adopt-native', {
          runtime: 'claude',
          nativeId: 'native-c5-1',
          cwd: NATIVE_CWD,
        }),
        res,
      );
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.parentSessionId).toBe(PARENT_ID);
      expect(body.parentSource).toBe('peer');
      expect(peerResolve.resolve).toHaveBeenCalledTimes(1);
    });

    it('keeps the explicit header authoritative on adopt-native', async () => {
      const res = mockRes();
      await routes.handleAdoptNativeSession(
        jsonReq('POST', '/api/v1/sessions/adopt-native', { runtime: 'claude', nativeId: 'native-c5-2', cwd: NATIVE_CWD }, { 'x-parent-session': PARENT_ID }),
        res,
      );
      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(200);
      expect(body.parentSessionId).toBe(PARENT_ID);
      expect(body.parentSource).toBe('header');
      expect(peerResolve.resolve).not.toHaveBeenCalled();
    });
  });
});

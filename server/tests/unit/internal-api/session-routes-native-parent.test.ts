// Step 1i.2 B (contract 1.63.0) — native parent linkage, route-level behaviour.
//  - POST /sessions, POST /sessions/batch and adopt accept an explicitly
//    native parent: body `parentSessionId` plus `parentKind: "native"`. The
//    value is an opaque native session id (e.g. a Claude Code session uuid)
//    that must NOT resolve to a registry session.
//  - Persisted as `parentSessionId` + `parentSource: "declared"` (new enum
//    member); echoed on create, listed on GET /sessions items, surfaced on
//    GET /sessions/:id and /info; GET /sessions?parent=<native id> returns
//    the linked children instead of 404ing.
//  - Unchanged: an UNMARKED unresolvable X-Parent-Session or body
//    parentSessionId is still silently ignored (1.34.0 semantics).
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { createCapabilitiesRoutes } from '../../../src/internal-api/routes/capabilities.js';
import { SessionRegistryManager } from '../../../src/session-registry.js';
import { INTERNAL_API_CONTRACT_VERSION } from '../../../src/internal-api/types.js';

// Integration: C4's default-on cwd preflight refuses creates into a
// non-existent cwd, so fixtures use a directory that exists and is writable.
const PROJ = os.tmpdir();

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

// An invented managed parent (registry session) and an invented native parent
// id shaped like a Claude Code session uuid. Fixtures only — never real ids.
const MANAGED_PARENT_ID = '11111111-1111-4111-8111-000000000001';
const NATIVE_PARENT_ID = '22222222-3333-4444-8555-666666666666';

describe('Native parent linkage (contract 1.63.0)', () => {
  let dir: string;
  let registry: SessionRegistryManager;
  let antigravityService: any;
  let peerResolve: { resolve: ReturnType<typeof vi.fn> };
  let onBrowserMessage: ReturnType<typeof vi.fn>;
  let routes: ReturnType<typeof createSessionRoutes>;
  let createdCount: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-parent-'));
    registry = new SessionRegistryManager(path.join(dir, 'session-registry.json'));
    await registry.upsert({
      id: MANAGED_PARENT_ID,
      sdkType: 'pi',
      path: '/sessions/parent.jsonl',
      cwd: PROJ,
      firstMessage: 'parent',
      messageCount: 1,
      status: 'idle',
      createdAt: '2026-10-16T00:00:00.000Z',
      lastActivity: '2026-10-16T00:00:00.000Z',
    });
    createdCount = 0;
    antigravityService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn(async () => true),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn(async () => null),
      createSession: vi.fn(async () => {
        createdCount += 1;
        return { sessionId: `agy-child-${createdCount}` };
      }),
    };
    // Peer resolution refuses by default so unmarked cases stay deterministically
    // unlinked (the tests that want it linked say so).
    peerResolve = { resolve: vi.fn(async () => null) };
    onBrowserMessage = vi.fn();
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false) } as any,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService,
      multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      claudeProjectsDir: path.join(dir, 'claude-projects'),
      preferencesPath: path.join(dir, 'prefs.json'),
      watchDir: path.join(dir, 'watches'),
      peerParentResolver: peerResolve as unknown as SessionRoutesDeps['peerParentResolver'],
      onBrowserMessage: onBrowserMessage as SessionRoutesDeps['onBrowserMessage'],
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

  const createBody = { runtime: 'antigravity', cwd: PROJ };
  const nativeBody = { ...createBody, parentSessionId: NATIVE_PARENT_ID, parentKind: 'native' };

  const getList = async (url = '/api/v1/sessions') => {
    const res = mockRes();
    await routes.handleListSessions(jsonReq('GET', url), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  const getDetail = async (sessionId: string) => {
    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', `/api/v1/sessions/${sessionId}`), res, sessionId);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  const getInfo = async (sessionId: string) => {
    const res = mockRes();
    await routes.handleGetSessionInfo(jsonReq('GET', `/api/v1/sessions/${sessionId}/info`), res, sessionId);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  it('bumps the contract to at least 1.63.0', () => {
    const [maj, min] = INTERNAL_API_CONTRACT_VERSION.split('.').map(Number);
    expect(maj === 1 && min >= 63).toBe(true);
  });

  describe('POST /sessions with parentKind "native"', () => {
    it('links the declared native parent without registry resolution', async () => {
      const out = await create(nativeBody);
      expect(out.status).toBe(201);
      expect(out.body.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(out.body.parentSource).toBe('declared');
      const entry = await registry.get(out.body.sessionId);
      expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(entry?.parentSource).toBe('declared');
      expect(peerResolve.resolve).not.toHaveBeenCalled();
    });

    it('surfaces the declared linkage on GET /sessions/:id', async () => {
      const child = (await create(nativeBody)).body.sessionId;
      const out = await getDetail(child);
      expect(out.status).toBe(200);
      expect(out.body.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(out.body.parentSource).toBe('declared');
    });

    it('surfaces the declared linkage on GET /sessions/:id/info', async () => {
      const child = (await create(nativeBody)).body.sessionId;
      const out = await getInfo(child);
      expect(out.status).toBe(200);
      expect(out.body.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(out.body.parentSource).toBe('declared');
    });

    it('lists the declared linkage on GET /sessions items', async () => {
      const child = (await create(nativeBody)).body.sessionId;
      const out = await getList();
      expect(out.status).toBe(200);
      const item = out.body.sessions.find((s: any) => s.sessionId === child);
      expect(item).toBeDefined();
      expect(item.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(item.parentSource).toBe('declared');
    });

    it('GET /sessions?parent=<native id> returns the declared children (not 404)', async () => {
      const child = (await create(nativeBody)).body.sessionId;
      const out = await getList(`/api/v1/sessions?parent=${NATIVE_PARENT_ID}`);
      expect(out.status).toBe(200);
      expect(out.body.sessions.map((s: any) => s.sessionId)).toEqual([child]);
    });

    it('GET /sessions?parent=<unknown id with no children> is still a 404', async () => {
      const out = await getList('/api/v1/sessions?parent=33333333-3333-4333-8333-333333333333');
      expect(out.status).toBe(404);
      expect(out.body.code).toBe('SESSION_NOT_FOUND');
    });

    it('a resolvable X-Parent-Session header still wins over the native-marked body', async () => {
      const out = await create(nativeBody, { 'x-parent-session': MANAGED_PARENT_ID });
      expect(out.status).toBe(201);
      expect(out.body.parentSessionId).toBe(MANAGED_PARENT_ID);
      expect(out.body.parentSource).toBe('header');
    });
  });

  describe('unchanged 1.34.0 semantics for unmarked values', () => {
    it('ignores an unmarked unresolvable body parentSessionId', async () => {
      const out = await create({ ...createBody, parentSessionId: NATIVE_PARENT_ID });
      expect(out.status).toBe(201);
      expect('parentSessionId' in out.body).toBe(false);
      expect('parentSource' in out.body).toBe(false);
      expect((await registry.get(out.body.sessionId))?.parentSessionId).toBeUndefined();
    });

    it('ignores an unmarked unresolvable X-Parent-Session header', async () => {
      const out = await create(createBody, { 'x-parent-session': NATIVE_PARENT_ID });
      expect(out.status).toBe(201);
      expect('parentSessionId' in out.body).toBe(false);
      expect('parentSource' in out.body).toBe(false);
      expect((await registry.get(out.body.sessionId))?.parentSessionId).toBeUndefined();
    });
  });

  describe('POST /sessions/batch with parentKind "native"', () => {
    const batch = async (sessions: unknown[], headers: Record<string, string> = {}) => {
      const res = mockRes();
      await routes.handleBatchCreate(jsonReq('POST', '/api/v1/sessions/batch', { sessions }, headers), res);
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
    };

    it('links every native-marked entry as declared', async () => {
      const out = await batch([
        { runtime: 'antigravity', cwd: PROJ, parentSessionId: NATIVE_PARENT_ID, parentKind: 'native' },
        { runtime: 'antigravity', cwd: PROJ, parentSessionId: NATIVE_PARENT_ID, parentKind: 'native' },
      ]);
      expect(out.status).toBe(200);
      expect(out.body.createdCount).toBe(2);
      for (const item of out.body.created) {
        expect(item.success).toBe(true);
        expect(item.parentSessionId).toBe(NATIVE_PARENT_ID);
        expect(item.parentSource).toBe('declared');
        const entry = await registry.get(item.sessionId);
        expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
        expect(entry?.parentSource).toBe('declared');
      }
      expect(peerResolve.resolve).not.toHaveBeenCalled();
    });

    it('mixed batch: the unmarked unresolvable entry stays unlinked, the native-marked one links', async () => {
      const out = await batch([
        { runtime: 'antigravity', cwd: PROJ, parentSessionId: NATIVE_PARENT_ID },
        { runtime: 'antigravity', cwd: PROJ, parentSessionId: NATIVE_PARENT_ID, parentKind: 'native' },
      ]);
      expect(out.status).toBe(200);
      expect(out.body.created[0].success).toBe(true);
      expect('parentSessionId' in out.body.created[0]).toBe(false);
      expect(out.body.created[1].parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(out.body.created[1].parentSource).toBe('declared');
    });
  });

  describe('adopt with parentKind "native"', () => {
    let childId: string;

    beforeEach(async () => {
      childId = (await create(createBody)).body.sessionId; // peer refuses → unlinked
      expect((await registry.get(childId))?.parentSessionId).toBeUndefined();
    });

    it('POST /sessions/:id/adopt accepts a native parent and persists declared', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(body.parentSource).toBe('declared');
      const entry = await registry.get(childId);
      expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(entry?.parentSource).toBe('declared');
    });

    it('control-lane adopt accepts a native parent and persists declared', async () => {
      const res = mockRes();
      await routes.handleSessionControl(
        jsonReq('POST', `/api/v1/sessions/${childId}/control`, {
          action: 'adopt',
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.parentSessionId).toBe(NATIVE_PARENT_ID);
      const entry = await registry.get(childId);
      expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(entry?.parentSource).toBe('declared');
    });

    it('adopts children are listed by ?parent=<native id>', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const out = await getList(`/api/v1/sessions?parent=${NATIVE_PARENT_ID}`);
      expect(out.status).toBe(200);
      expect(out.body.sessions.map((s: any) => s.sessionId)).toContain(childId);
    });

    // Correction round 1, blocker 1: an unvalidated X-Parent-Session header must
    // never be persisted as a declared native parent. The marker is body-scoped:
    // an unresolvable header falls through to the native-marked BODY value.
    it('adopt: a path-shaped unresolvable header is never persisted; the native-marked body value links instead', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }, { 'x-parent-session': '../../etc/passwd' }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(body.parentSource).toBe('declared');
      const entry = await registry.get(childId);
      expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(entry?.parentSource).toBe('declared');
    });

    it('control-adopt: a path-shaped unresolvable header is never persisted; the native-marked body value links instead', async () => {
      const res = mockRes();
      await routes.handleSessionControl(
        jsonReq('POST', `/api/v1/sessions/${childId}/control`, {
          action: 'adopt',
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }, { 'x-parent-session': '../../etc/passwd' }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(body.parentSource).toBe('declared');
      const entry = await registry.get(childId);
      expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(entry?.parentSource).toBe('declared');
    });

    it('adopt: an over-long unresolvable header is never persisted; the native-marked body value links instead', async () => {
      const overLong = `x${'a'.repeat(200)}`;
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }, { 'x-parent-session': overLong }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const entry = await registry.get(childId);
      expect(entry?.parentSessionId).toBe(NATIVE_PARENT_ID);
      expect(entry?.parentSource).toBe('declared');
    });

    // Correction round 1, blocker 2: a resolvable header must produce a managed
    // adoption (child_dispatched fan-out) even when the body carries a native
    // marker — mirroring the create path.
    it('adopt: a resolvable X-Parent-Session wins as a managed header adoption (native mark ignored, fan-out fires)', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }, { 'x-parent-session': MANAGED_PARENT_ID }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.parentSessionId).toBe(MANAGED_PARENT_ID);
      expect(body.parentSource).toBe('header');
      const entry = await registry.get(childId);
      expect(entry?.parentSessionId).toBe(MANAGED_PARENT_ID);
      expect(entry?.parentSource).toBe('header');
      // Managed side effect fired: the browser surface saw the child card.
      expect(onBrowserMessage).toHaveBeenCalledTimes(1);
      expect(onBrowserMessage.mock.calls[0][0]).toMatchObject({
        type: 'child_dispatched',
        sessionId: MANAGED_PARENT_ID,
        child: { childSessionId: childId },
      });
    });

    it('control-adopt: a resolvable X-Parent-Session wins as a managed header adoption (native mark ignored, fan-out fires)', async () => {
      const res = mockRes();
      await routes.handleSessionControl(
        jsonReq('POST', `/api/v1/sessions/${childId}/control`, {
          action: 'adopt',
          parentSessionId: NATIVE_PARENT_ID,
          parentKind: 'native',
        }, { 'x-parent-session': MANAGED_PARENT_ID }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.parentSessionId).toBe(MANAGED_PARENT_ID);
      expect(body.parentSource).toBe('header');
      expect(onBrowserMessage).toHaveBeenCalledTimes(1);
      expect(onBrowserMessage.mock.calls[0][0]).toMatchObject({ type: 'child_dispatched' });
    });

    // Master (1.40.0) behaviour preserved: an unresolvable explicit value with
    // no native-marked body stays a 404, never a silent fallback.
    it('adopt: an unresolvable header with no native-marked body keeps the 404', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {}, { 'x-parent-session': 'does-not-resolve' }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).code).toBe('SESSION_NOT_FOUND');
      expect((await registry.get(childId))?.parentSessionId).toBeUndefined();
    });

    it('adopt: an unresolvable header with an UNMARKED body value keeps the 404 (header wins, body not tried)', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', `/api/v1/sessions/${childId}/adopt`, {
          parentSessionId: 'also-does-not-resolve',
        }, { 'x-parent-session': 'does-not-resolve' }),
        res,
        childId,
      );
      expect(res.statusCode).toBe(404);
      expect((await registry.get(childId))?.parentSessionId).toBeUndefined();
    });
  });

  describe('request validation', () => {
    it('rejects parentKind without parentSessionId (400)', async () => {
      const out = await create({ ...createBody, parentKind: 'native' });
      expect(out.status).toBe(400);
    });

    it('rejects a native parentSessionId containing a path separator (400)', async () => {
      const out = await create({ ...createBody, parentSessionId: '../etc/passwd', parentKind: 'native' });
      expect(out.status).toBe(400);
    });

    it('rejects an unknown parentKind value (400)', async () => {
      const out = await create({ ...createBody, parentSessionId: NATIVE_PARENT_ID, parentKind: 'managed' });
      expect(out.status).toBe(400);
    });

    it('rejects a native parentKind on adopt without parentSessionId (400)', async () => {
      const res = mockRes();
      await routes.handleAdoptSession(
        jsonReq('POST', '/api/v1/sessions/some-child/adopt', { parentKind: 'native' }),
        res,
        'some-child',
      );
      expect(res.statusCode).toBe(400);
    });
  });

  describe('capabilities', () => {
    it('advertises features.nativeParentLinkage', async () => {
      const capRoutes = createCapabilitiesRoutes({
        claudeService: {
          isAvailable: vi.fn().mockResolvedValue(true),
          getBackendMode: vi.fn().mockResolvedValue('sdk-subscription'),
          getProfiles: vi.fn().mockReturnValue([]),
        } as unknown as import('../../../src/internal-api/routes/capabilities.js').CapabilitiesRoutesDeps['claudeService'],
        opencodeService: {
          isAvailable: vi.fn().mockResolvedValue(false),
          isEnabled: vi.fn().mockReturnValue(true),
        } as unknown as import('../../../src/internal-api/routes/capabilities.js').CapabilitiesRoutesDeps['opencodeService'],
        antigravityService: {
          isAvailable: vi.fn().mockResolvedValue(false),
        } as unknown as import('../../../src/internal-api/routes/capabilities.js').CapabilitiesRoutesDeps['antigravityService'],
      });
      const res = mockRes();
      await capRoutes.handleGetCapabilities(jsonReq('GET', '/api/v1/capabilities'), res);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.features.nativeParentLinkage).toEqual({
        parentKind: 'native',
        parentSource: 'declared',
        surfaces: ['POST /sessions', 'POST /sessions/batch', 'POST /sessions/:id/adopt', 'POST /sessions/:id/control'],
      });
    });
  });
});

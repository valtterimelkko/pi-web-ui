// Contract 1.40.0 — POST /api/v1/sessions/:id/adopt and POST /api/v1/sessions/adopt-native
// Strict TDD test suite for adopting pre-prompted and native CLI sessions.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
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

const encodeProject = (cwd: string): string => cwd.split(path.sep).filter(Boolean).join('-');

describe('Contract 1.40.0: Session Adoption & Adopt-Native', () => {
  let dir: string;
  let claudeProjectsDir: string;
  let commandCodeCliHomeDir: string;
  let antigravityConversationsDir: string;
  let registry: SessionRegistryManager;
  let registryPath: string;
  let routes: ReturnType<typeof createSessionRoutes>;
  let broadcastEvents: Array<Record<string, unknown>>;

  const PARENT_ID = '11111111-1111-4111-8111-000000000001';
  const CHILD_ID = '22222222-2222-4222-8222-000000000002';
  const NATIVE_CLAUDE_ID = '33333333-3333-4333-8333-000000000003';
  const NATIVE_AGY_ID = '44444444-4444-4444-8444-000000000004';
  const REAL_CWD = '/root/pi-web-ui';

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-adopt-test-'));
    claudeProjectsDir = path.join(dir, 'claude-projects');
    commandCodeCliHomeDir = path.join(dir, 'commandcode-home');
    antigravityConversationsDir = path.join(dir, 'agy-conversations');
    registryPath = path.join(dir, 'session-registry.json');
    registry = new SessionRegistryManager(registryPath);
    broadcastEvents = [];

    // Seed parent session in registry
    await registry.upsert({
      id: PARENT_ID,
      sdkType: 'pi',
      path: '/sessions/parent.jsonl',
      cwd: REAL_CWD,
      firstMessage: 'I am the parent',
      messageCount: 1,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      status: 'idle',
      origin: 'internal-api',
    });

    // Seed unadopted child session in registry
    await registry.upsert({
      id: CHILD_ID,
      sdkType: 'claude',
      path: '/sessions/child.jsonl',
      claudeSessionId: 'claude-seed-id',
      cwd: REAL_CWD,
      firstMessage: 'I am the child',
      messageCount: 2,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      status: 'idle',
      origin: 'browser',
    });

    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false), wasRecentlyResolvedAskUserQuestion: vi.fn(() => false) } as any,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false) } as any,
      commandCodeService: null as any,
      multiSessionManager: { getSession: vi.fn(() => undefined), isSessionStreaming: vi.fn(() => false) } as any,
      sessionRegistry: registry,
      piService: { listAllSessions: vi.fn(async () => []) } as any,
      internalClientId: 'test-internal-client',
      onBrowserMessage: (msg: any) => {
        broadcastEvents.push(msg);
      },
      claudeProjectsDir,
      commandCodeCliHomeDir,
      antigravityConversationsDir,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('Contract version check', () => {
    it('bumps contract version to 1.41.0 (background-shell child surfacing)', () => {
      expect(INTERNAL_API_CONTRACT_VERSION).toBe('1.41.0');
    });
  });

  describe('POST /api/v1/sessions/:id/adopt', () => {
    it('successfully adopts an existing registered session with body parentSessionId', async () => {
      const req = jsonReq('POST', `/api/v1/sessions/${CHILD_ID}/adopt`, {
        parentSessionId: PARENT_ID,
        alias: 'worker-1',
        role: 'database-migration',
      });
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, CHILD_ID);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.childSessionId).toBe(CHILD_ID);
      expect(body.parentSessionId).toBe(PARENT_ID);
      expect(body.runtime).toBe('claude');

      // Verify registry was updated
      const updated = await registry.get(CHILD_ID);
      expect(updated?.parentSessionId).toBe(PARENT_ID);

      // Verify child_dispatched was broadcast
      const dispatched = broadcastEvents.find((e) => e.type === 'child_dispatched');
      expect(dispatched).toBeDefined();
      expect(dispatched?.sessionId).toBe(PARENT_ID);
      expect((dispatched?.child as any)?.childSessionId).toBe(CHILD_ID);
    });

    it('successfully adopts when parentSessionId is provided in X-Parent-Session header', async () => {
      const req = jsonReq('POST', `/api/v1/sessions/${CHILD_ID}/adopt`, {}, {
        'x-parent-session': PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, CHILD_ID);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.parentSessionId).toBe(PARENT_ID);
    });

    it('returns 404 when child session does not exist', async () => {
      const req = jsonReq('POST', '/api/v1/sessions/non-existent-child/adopt', {
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, 'non-existent-child');

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 404 when parent session does not exist', async () => {
      const req = jsonReq('POST', `/api/v1/sessions/${CHILD_ID}/adopt`, {
        parentSessionId: 'non-existent-parent',
      });
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, CHILD_ID);

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 400 when attempting to adopt oneself as child', async () => {
      const req = jsonReq('POST', `/api/v1/sessions/${PARENT_ID}/adopt`, {
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, PARENT_ID);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 when no parent is identifiable (neither body nor header)', async () => {
      const req = jsonReq('POST', `/api/v1/sessions/${CHILD_ID}/adopt`, {});
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, CHILD_ID);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 when adoption would create a parent cycle', async () => {
      // PARENT already has CHILD as its parent → adopting CHILD under PARENT would close the loop.
      await registry.patchSessionMeta(PARENT_ID, { parentSessionId: CHILD_ID });
      const req = jsonReq('POST', `/api/v1/sessions/${CHILD_ID}/adopt`, {
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptSession(req, res, CHILD_ID);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_REQUEST');
      // Linkage unchanged: CHILD must not have gained a parent.
      const unchanged = await registry.get(CHILD_ID);
      expect(unchanged?.parentSessionId).toBeUndefined();
    });
  });

  describe('POST /api/v1/sessions/:id/control with action: adopt', () => {
    it('routes adoption through handleSessionControl', async () => {
      const req = jsonReq('POST', `/api/v1/sessions/${CHILD_ID}/control`, {
        action: 'adopt',
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await routes.handleSessionControl(req, res, CHILD_ID);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.action).toBe('adopt');
      expect(body.childSessionId).toBe(CHILD_ID);
      expect(body.parentSessionId).toBe(PARENT_ID);
    });
  });

  describe('POST /api/v1/sessions/adopt-native', () => {
    it('successfully adopts an unmanaged Claude CLI session on disk', async () => {
      // Create native claude file on disk
      const claudeFile = path.join(claudeProjectsDir, encodeProject(REAL_CWD), `${NATIVE_CLAUDE_ID}.jsonl`);
      await fs.mkdir(path.dirname(claudeFile), { recursive: true });
      await fs.writeFile(claudeFile, JSON.stringify({ type: 'user', message: { content: 'Initial native Claude turn' } }) + '\n', 'utf-8');

      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'claude',
        nativeId: NATIVE_CLAUDE_ID,
        cwd: REAL_CWD,
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.runtime).toBe('claude');
      expect(body.parentSessionId).toBe(PARENT_ID);
      expect(body.sessionId).toBeDefined();

      // Verify it was added to registry
      const created = await registry.get(body.sessionId);
      expect(created).toBeDefined();
      expect(created?.claudeSessionId).toBe(NATIVE_CLAUDE_ID);
      expect(created?.parentSessionId).toBe(PARENT_ID);
      expect(created?.origin).toBe('native-discovered');
      expect(created?.cwd).toBe(REAL_CWD);

      // Verify child_dispatched was broadcast
      const dispatched = broadcastEvents.find((e) => e.type === 'child_dispatched');
      expect(dispatched).toBeDefined();
    });

    it('successfully adopts an unmanaged Antigravity CLI session on disk', async () => {
      // Create native antigravity conversation db on disk
      const agyFile = path.join(antigravityConversationsDir, `${NATIVE_AGY_ID}.db`);
      await fs.mkdir(path.dirname(agyFile), { recursive: true });
      await fs.writeFile(agyFile, 'mock-sqlite-binary', 'utf-8');

      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'antigravity',
        nativeId: NATIVE_AGY_ID,
        cwd: REAL_CWD,
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.runtime).toBe('antigravity');
      expect(body.parentSessionId).toBe(PARENT_ID);

      const created = await registry.get(body.sessionId);
      expect(created?.antigravityConversationId).toBe(NATIVE_AGY_ID);
      expect(created?.parentSessionId).toBe(PARENT_ID);
    });

    it('returns 400 for an unsupported native runtime', async () => {
      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'pi',
        nativeId: NATIVE_CLAUDE_ID,
        cwd: REAL_CWD,
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 when nativeId contains path traversal', async () => {
      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'claude',
        nativeId: '../../etc/passwd',
        cwd: REAL_CWD,
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 when the native session artefact does not exist on disk', async () => {
      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'claude',
        nativeId: 'non-existent-native-id',
        cwd: REAL_CWD,
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('NATIVE_SESSION_NOT_FOUND');
    });

    it('returns 404 when parent session does not exist', async () => {
      const claudeFile = path.join(claudeProjectsDir, encodeProject(REAL_CWD), `${NATIVE_CLAUDE_ID}.jsonl`);
      await fs.mkdir(path.dirname(claudeFile), { recursive: true });
      await fs.writeFile(claudeFile, JSON.stringify({ type: 'user', message: { content: 'test' } }) + '\n', 'utf-8');

      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'claude',
        nativeId: NATIVE_CLAUDE_ID,
        cwd: REAL_CWD,
        parentSessionId: 'non-existent-parent',
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('SESSION_NOT_FOUND');
    });

    it('adopts existing registry entry if native session is already known in registry', async () => {
      // Pre-register a native session
      const EXISTING_ID = '55555555-5555-4555-8555-000000000005';
      await registry.upsert({
        id: EXISTING_ID,
        sdkType: 'claude',
        path: '/sessions/existing.jsonl',
        claudeSessionId: NATIVE_CLAUDE_ID,
        cwd: REAL_CWD,
        firstMessage: 'Already registered native turn',
        messageCount: 1,
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        status: 'idle',
        origin: 'native-discovered',
      });

      const req = jsonReq('POST', '/api/v1/sessions/adopt-native', {
        runtime: 'claude',
        nativeId: NATIVE_CLAUDE_ID,
        cwd: REAL_CWD,
        parentSessionId: PARENT_ID,
      });
      const res = mockRes();
      await (routes as any).handleAdoptNativeSession(req, res);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sessionId).toBe(EXISTING_ID);
      expect(body.parentSessionId).toBe(PARENT_ID);

      const updated = await registry.get(EXISTING_ID);
      expect(updated?.parentSessionId).toBe(PARENT_ID);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';

function createJsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  });
  res.getHeader = vi.fn();
  return res;
}

function json(res: { body: string }): any {
  return JSON.parse(res.body);
}

describe('createSessionRoutes — DELETE file cleanup', () => {
  let dir: string;
  let piDir: string;
  let claudeDir: string;
  let antigravityDir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-delete-routes-'));
    piDir = path.join(dir, 'pi-sessions');
    claudeDir = path.join(dir, 'claude-sessions');
    antigravityDir = path.join(dir, 'antigravity-sessions');

    registry = {
      get: vi.fn(),
      listAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
    };

    claudeService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
      unpinSession: vi.fn(() => true),
      pinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('direct'),
    };

    opencodeService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
      unpinSession: vi.fn(() => true),
      pinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
    };

    antigravityService = {
      isRunning: vi.fn(() => false),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
      unpinSession: vi.fn(() => true),
      pinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      getSessionStats: vi.fn().mockResolvedValue(null),
    };

    multiSessionManager = {
      getAgentSession: vi.fn(() => null),
      unpinSession: vi.fn(() => true),
      disposeLoadedSession: vi.fn(() => true),
    };

    piService = { setModel: vi.fn().mockResolvedValue(undefined) };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function makeRoutes() {
    return createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      piSessionDir: piDir,
      claudeSessionDir: claudeDir,
      antigravitySessionDir: antigravityDir,
    });
  }

  it('releases API and watch claims before deleting registry state', async () => {
    const sessionId = 'claude-claimed';
    registry.get.mockResolvedValue({ id: sessionId, sdkType: 'claude', path: sessionId, cwd: '/root/proj', status: 'idle' });
    const routes = makeRoutes();
    await routes.ready;

    const retentionRes = createMockRes();
    await routes.handleSessionControl(createJsonReq('POST', '/control', {
      action: 'acquire_retention',
      retention: { mode: 'resident', ownerId: 'owner-a' },
    }), retentionRes, sessionId);
    const watchRes = createMockRes();
    await routes.handleRegisterWatch(createJsonReq('POST', '/watch', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }], pin: true,
    }), watchRes, sessionId);

    const deleteRes = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), deleteRes, sessionId);

    expect(deleteRes.statusCode).toBe(200);
    expect(claudeService.unpinSession).toHaveBeenCalledWith(sessionId, expect.stringMatching(/^internal-api:/));
    expect(claudeService.unpinSession).toHaveBeenCalledWith(sessionId, `watch:watch-${sessionId}`);
    const registryDeleteOrder = registry.delete.mock.invocationCallOrder[0];
    for (const order of claudeService.unpinSession.mock.invocationCallOrder) expect(order).toBeLessThan(registryDeleteOrder);
    await routes.shutdown();
  });

  it('deletes a Pi session file on DELETE', async () => {
    const sessionId = 'pi-session-1';
    const sessionFile = path.join(piDir, '--root--', '2026-03-01T00-00-00-000Z_pi-session-1.jsonl');
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, '{"type":"session","id":"pi-session-1"}\n', 'utf-8');

    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'pi',
      path: sessionFile,
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true });
    await expect(fs.stat(sessionFile)).rejects.toThrow();
    expect(multiSessionManager.disposeLoadedSession).toHaveBeenCalledWith(sessionFile);
    expect(registry.delete).toHaveBeenCalledWith(sessionId);
  });

  it('deletes a Pi session directory on DELETE', async () => {
    const sessionId = 'pi-dir-session';
    const sessionDir = path.join(piDir, '--root--');
    const sessionFile = path.join(sessionDir, '2026-03-01T00-00-00-000Z_old.jsonl');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionFile, '{"type":"session","id":"pi-dir-session"}\n', 'utf-8');

    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'pi',
      path: sessionDir,
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true });
    await expect(fs.stat(sessionDir)).rejects.toThrow();
    expect(registry.delete).toHaveBeenCalledWith(sessionId);
  });

  it('deletes a Claude session JSONL on DELETE', async () => {
    const sessionId = 'claude-session-1';
    const jsonlFile = path.join(claudeDir, `${sessionId}.jsonl`);
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(jsonlFile, 'claude data', 'utf-8');

    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'claude',
      path: jsonlFile,
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true });
    await expect(fs.stat(jsonlFile)).rejects.toThrow();
    expect(registry.delete).toHaveBeenCalledWith(sessionId);
  });

  it('deletes an Antigravity session JSONL and agy logs on DELETE', async () => {
    const sessionId = 'antigravity-session-1';
    const jsonlFile = path.join(antigravityDir, `${sessionId}.jsonl`);
    const logsDir = path.join(antigravityDir, 'agy-logs');
    const logFile = path.join(logsDir, `${sessionId}-1780000000000-abc.log`);
    const otherLogFile = path.join(logsDir, 'other-session-1780000000000-abc.log');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(jsonlFile, 'turn', 'utf-8');
    await fs.writeFile(logFile, 'agy output', 'utf-8');
    await fs.writeFile(otherLogFile, 'other output', 'utf-8');

    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'antigravity',
      path: sessionId,
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true });
    await expect(fs.stat(jsonlFile)).rejects.toThrow();
    await expect(fs.stat(logFile)).rejects.toThrow();
    await expect(fs.stat(otherLogFile)).resolves.toBeDefined();
    expect(registry.delete).toHaveBeenCalledWith(sessionId);
  });

  it('returns success when files are already missing', async () => {
    const sessionId = 'missing-claude';
    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'claude',
      path: path.join(claudeDir, `${sessionId}.jsonl`),
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);

    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ success: true });
  });

  it('disposes every registered per-session handle on DELETE and tombstones late callbacks', async () => {
    const sessionId = 'claude-disposal';
    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'claude',
      path: sessionId,
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    await routes.ready;

    // Simulate the per-session surfaces (AUQ timer, extension snapshot,
    // queue correlation, drain-like handle) registering ownership.
    const timer = vi.fn();
    const snapshot = vi.fn();
    const correlation = vi.fn();
    const drain = vi.fn();
    routes.disposal.register(sessionId, 'ask-user-question-timer', timer);
    routes.disposal.register(sessionId, 'extension-snapshot', snapshot);
    routes.disposal.register(sessionId, 'queue-correlation', correlation);
    routes.disposal.register(sessionId, 'drain-handle', drain);
    expect(routes.disposal.getCounts()[sessionId]).toBe(4);

    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);

    expect(res.statusCode).toBe(200);
    expect(timer).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(correlation).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(routes.disposal.getCounts()[sessionId]).toBeUndefined();
    expect(routes.disposal.isDisposed(sessionId)).toBe(true);

    // A late runtime callback attempting to re-register after deletion runs
    // immediately and cannot repopulate the owner map (tombstone).
    const late = vi.fn();
    routes.disposal.register(sessionId, 'late-callback', late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(routes.disposal.getCounts()[sessionId]).toBeUndefined();
  });

  it('a late broker.publish after DELETE cannot recreate the replay buffer (deletion fence)', async () => {
    const sessionId = 'claude-fence';
    registry.get.mockResolvedValue({
      id: sessionId,
      sdkType: 'claude',
      path: sessionId,
      cwd: '/root/proj',
      status: 'idle',
    });

    const routes = makeRoutes();
    await routes.ready;

    // Pre-delete: a real event is buffered for the session.
    const before = { type: 'agent_start', sessionId, timestamp: 1, data: {} } as any;
    routes.broker.publish(sessionId, before);
    expect(routes.broker.getRecentEvents(sessionId)).toHaveLength(1);

    // Delete the session — tombstones it in the disposal registry, which the
    // broker consults via its isSessionDisposed predicate.
    const res = createMockRes();
    await routes.handleDeleteSession(createJsonReq('DELETE', `/api/v1/sessions/${sessionId}`), res, sessionId);
    expect(res.statusCode).toBe(200);

    // A LATE runtime callback (race: event in flight when delete ran) publishes
    // after deletion. It MUST be dropped — the replay buffer must not be
    // recreated, and no subscriber can be notified.
    const lateSub = vi.fn();
    routes.broker.subscribe(sessionId, lateSub);
    const lateEvent = { type: 'agent_end', sessionId, timestamp: 2, data: {} } as any;
    routes.broker.publish(sessionId, lateEvent);

    expect(routes.broker.getRecentEvents(sessionId)).toHaveLength(0); // cleared on delete, not recreated
    expect(lateSub).not.toHaveBeenCalled(); // late subscriber sees nothing
    expect(routes.broker.subscriberCount(sessionId)).toBe(0);
  });
});

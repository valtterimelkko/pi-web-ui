/**
 * Phase 4b (contract 1.45.0) — route-level ownership gate.
 *
 * Incident shape (23 Sep): the server loaded a session owned by a live CLI;
 * every action either silently no-opped or hung. Now: a LIVE foreign owner
 * refuses 409 SESSION_OWNED_BY_OTHER_RUNTIME before any run is created (S6),
 * and a DEAD owner triggers the dispose→rehydrate recovery, restoring pins
 * (owner decision: auto-recover pinned sessions keeping the pin).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OWNERSHIP_STATUS_SYMBOL, defaultOwnershipProbes, piLeasePathForSession } from '../../../src/pi/session-ownership-status.js';

const SESSION_PATH = '/tmp/sessions/session-1.jsonl';

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

function mockRes(): ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> } {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = vi.fn((name: string, value: unknown) => { headers[name.toLowerCase()] = value; }) as any;
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
    path: SESSION_PATH,
    sdkType: 'pi',
    cwd: '/root/pi-web-ui',
    model: 'zai/glm-5.3',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-08-27T12:00:00.000Z',
    lastActivity: '2026-08-27T12:00:00.000Z',
    ...overrides,
  };
}

/** A guaranteed-live owner: this test process itself, with its real start identity. */
function liveLease(): { pid: number; pidStartIdentity: string; state: string; mode: string } {
  return {
    pid: process.pid,
    pidStartIdentity: defaultOwnershipProbes.processStartIdentity(process.pid) as string,
    state: 'owned',
    mode: 'tui',
  };
}

describe('Pi ownership gate (Phase 4b, contract 1.45.0)', () => {
  let dir: string;
  let registry: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let agentSession: Record<string, unknown>;
  let ownershipMap: Map<string, any>;
  let priorLeaseDir: string | undefined;
  let priorSymbolValue: unknown;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ownership-gate-'));
    priorLeaseDir = process.env.PI_SESSION_LEASE_DIR;
    process.env.PI_SESSION_LEASE_DIR = path.join(dir, 'leases');
    const host = globalThis as typeof globalThis & Record<symbol, unknown>;
    priorSymbolValue = host[OWNERSHIP_STATUS_SYMBOL];
    ownershipMap = new Map();
    host[OWNERSHIP_STATUS_SYMBOL] = ownershipMap;

    agentSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      model: { provider: 'zai', id: 'glm-5.3' },
      thinkingLevel: undefined as string | undefined,
      setThinkingLevel: vi.fn(function (this: { thinkingLevel?: string }, level: string) { this.thinkingLevel = level; }),
    };
    registry = {
      get: vi.fn(async (id: string) => entry({ id, path: id === 'session-1' ? SESSION_PATH : id })),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    piService = {
      getAvailableModels: vi.fn().mockResolvedValue([
        { id: 'glm-5.3', name: 'GLM-5.3', provider: 'zai', contextWindow: 200000 },
      ]),
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager = {
      getAgentSession: vi.fn(() => null),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn(async () => {
        multiSessionManager.getAgentSession.mockReturnValue(agentSession);
        // The extension's startup acquisition owns the lease again → publishes owned.
        ownershipMap.set(SESSION_PATH, { status: 'owned', reason: 'this runtime owns the persisted session', updatedAt: Date.now() });
      }),
      unsubscribeClient: vi.fn(),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      isSessionPinned: vi.fn(() => false),
      getPinClaims: vi.fn(() => [] as string[]),
      disposeLoadedSession: vi.fn(() => true),
      // Round 2: recovery moved into the manager (single-flight + browser
      // re-attach). The route delegates; the mock mirrors the extension's
      // post-recovery publication.
      recoverSession: vi.fn(async () => {
        multiSessionManager.getAgentSession.mockReturnValue(agentSession);
        ownershipMap.set(SESSION_PATH, { status: 'owned', reason: 'this runtime owns the persisted session', updatedAt: Date.now() });
        return { subscribers: [], viewers: [], pinClaims: [] };
      }),
      getAllSessionStatuses: vi.fn(() => []),
    };
    manager = new RunReceiptManager({
      store: new RunReceiptStore(path.join(dir, 'receipts'), {}),
      idFactory: (() => { let n = 0; return () => `gate-${++n}`; })(),
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false), abort: vi.fn(), getBackendMode: vi.fn().mockResolvedValue('sdk') } as any,
      opencodeService: { isRunning: vi.fn(() => false), isEnabled: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'internal-test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    const host = globalThis as typeof globalThis & Record<symbol, unknown>;
    if (priorSymbolValue === undefined) delete host[OWNERSHIP_STATUS_SYMBOL];
    else host[OWNERSHIP_STATUS_SYMBOL] = priorSymbolValue;
    if (priorLeaseDir === undefined) delete process.env.PI_SESSION_LEASE_DIR;
    else process.env.PI_SESSION_LEASE_DIR = priorLeaseDir;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function publishConflict(): void {
    ownershipMap.set(SESSION_PATH, {
      status: 'conflict',
      reason: 'session is owned by another live runtime (pid 4242)',
      ownerPid: 4242,
      ownerMode: 'tui',
      updatedAt: Date.now(),
    });
  }

  async function seedLease(lease: Record<string, unknown>): Promise<void> {
    const leasePath = piLeasePathForSession(SESSION_PATH);
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(leasePath, JSON.stringify(lease));
  }

  it('RED: control on a live-owner-fenced session answers 409 SESSION_OWNED_BY_OTHER_RUNTIME and never reaches the runtime (S6)', async () => {
    publishConflict();
    await seedLease(liveLease());

    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'high' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_OWNED_BY_OTHER_RUNTIME');
    expect(body.ownerPid).toBe(process.pid);
    expect(body.ownerMode).toBe('tui');
    expect(agentSession.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('RED: prompt on a live-owner-fenced session refuses 409 with NO run started (S6)', async () => {
    publishConflict();
    await seedLease(liveLease());

    const res = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'should be refused', detach: true }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_OWNED_BY_OTHER_RUNTIME');
    expect(body.runId).toBeUndefined();
    expect(manager.listAll?.() ?? []).toHaveLength(0);
    expect(agentSession.prompt).not.toHaveBeenCalled();
  });

  it('goal on a live-owner-fenced session refuses 409 before dispatching the command', async () => {
    publishConflict();
    await seedLease(liveLease());

    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'must be refused' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('SESSION_OWNED_BY_OTHER_RUNTIME');
    expect(agentSession.prompt).not.toHaveBeenCalled();
  });

  it('RED: a dead owner triggers dispose→rehydrate recovery and the action proceeds', async () => {
    publishConflict();
    // Lease records a dead pid: recovery path.
    await seedLease({
      pid: 999_999_999,
      pidStartIdentity: 'whatever',
      state: 'owned',
      mode: 'tui',
    });

    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'high' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, action: 'set_thinking_level', level: 'high' });
    expect(multiSessionManager.recoverSession).toHaveBeenCalledWith(SESSION_PATH);
    expect(agentSession.setThinkingLevel).toHaveBeenCalledWith('high');
  });

  it('RED: recovery of a PINNED fenced session restores the pin (owner decision)', async () => {
    publishConflict();
    multiSessionManager.getPinClaims.mockReturnValue(['web-ui']);
    await seedLease({
      pid: 999_999_999,
      pidStartIdentity: 'whatever',
      state: 'owned',
      mode: 'tui',
    });

    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'medium' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    expect(multiSessionManager.recoverSession).toHaveBeenCalledWith(SESSION_PATH);
  });

  it('uncertain liveness fails CLOSED with a refusal (correction C1)', async () => {
    publishConflict();
    // Live pid (this process) with a lease identity that CANNOT match: the
    // recorded identity is missing entirely → uncertain.
    await seedLease({
      pid: process.pid,
      state: 'owned',
      mode: 'tui',
    });

    const res = mockRes();
    await routes.handleSessionControl(
      jsonReq('POST', '/api/v1/sessions/session-1/control', { action: 'set_thinking_level', level: 'high' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('SESSION_OWNED_BY_OTHER_RUNTIME');
    expect(agentSession.setThinkingLevel).not.toHaveBeenCalled();
  });

  it('S8: GET /sessions/:id exposes the display-only ownership snapshot for Pi sessions', async () => {
    publishConflict();
    await seedLease(liveLease());

    const res = mockRes();
    await routes.handleGetSession(jsonReq('GET', '/api/v1/sessions/session-1'), res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ownership).toBeDefined();
    expect(body.ownership.status).toBe('conflict');
    expect(body.ownership.ownerPid).toBe(4242);
    expect(body.ownership.leaseState).toBe('owned');
  });
});

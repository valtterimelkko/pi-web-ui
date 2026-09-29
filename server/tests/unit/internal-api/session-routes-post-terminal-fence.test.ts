/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

/**
 * C2 (contract 1.57.0) — the post-terminal response fence.
 *
 * R2 input (plan §6 C2): a synchronous dispatch whose receipt terminalised
 * never got its HTTP response on an otherwise healthy server. The reachable
 * server-side shape: the receipt is terminalised by an EXTERNAL decision
 * (session abort / delete / run cancel) while the runtime adapter never hands
 * the dispatch chain back — `executePromptWithReceipt` then awaits a runtime
 * promise that never settles and the response is never written.
 *
 * The fence: once the receipt is terminal, the remaining wait for the runtime
 * settlement is bounded (`postTerminalSettleMs`); on expiry the execution is
 * fenced (observers detached) and the response is written from the receipt's
 * outcome with a distinct error code, so a terminal receipt can never again
 * mean a silent request.
 */

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

function mockRes(): ServerResponse & { body: string; statusCode: number; ended: boolean } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; ended: boolean };
  res.statusCode = 200;
  res.ended = false;
  res.setHeader = vi.fn() as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    res.ended = true;
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
    sdkType: 'pi',
    cwd: '/root/pi-web-ui',
    model: 'provider/model',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-07-15T12:00:00.000Z',
    lastActivity: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('C2 — post-terminal response fence', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let now: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-c2-fence-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
      getByPath: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(),
      isPendingAskUserQuestion: vi.fn(() => false),
      respondToAskUserQuestion: vi.fn(() => true),
      wasRecentlyResolvedAskUserQuestion: vi.fn(() => false),
      sendPermissionResponse: vi.fn(),
      getSessionStats: vi.fn().mockResolvedValue(null),
      getContextUsage: vi.fn().mockResolvedValue(null),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false), replyPermission: vi.fn() };
    antigravityService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false) };
    piService = { setModel: vi.fn().mockResolvedValue(undefined) };
    multiSessionManager = {
      getAgentSession: vi.fn(() => null),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(), // silence: the runtime never emits another event
      removeApiObserver: vi.fn(),
      getAllSessionStatuses: vi.fn(() => []),
      isSessionPinned: vi.fn(() => false),
    };
  });

  afterEach(async () => {
    await routes?.shutdown();
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function makeRoutes() {
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      pinExpiryIntervalMs: 60_000,
      runReceiptManager: manager,
      postTerminalSettleMs: 150,
    });
  }

  it('a synchronous dispatch whose receipt is terminalised externally still gets its HTTP response', async () => {
    await makeRoutes();
    const agentSession = {
      model: { provider: 'provider', id: 'model' }, // matches entry.model: no rebind
      // The runtime never settles its prompt() and never emits an event:
      // the dispatch chain never hands back.
      prompt: vi.fn(() => new Promise<void>(() => {})),
      followUp: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hello' });
    const res = mockRes();
    const dispatch = routes.handleSendPrompt(req, res, 'session-1');

    // Let the dispatch begin, then terminalise the receipt from the outside
    // (what POST /sessions/:id/abort does) without any runtime completion.
    await new Promise((r) => setTimeout(r, 40));
    expect(manager.get('run-1')?.status).toBe('started');
    await manager.cancelSession('session-1');
    expect(manager.get('run-1')?.status).toBe('cancelled');

    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000));
    const outcome = await Promise.race([dispatch.then(() => 'responded'), timeout]);
    expect(outcome).toBe('responded');
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('RUN_TRANSPORT_LOST');
    expect(body.runId).toBe('run-1');
    // The receipt's external truth is preserved, not overwritten.
    expect(manager.get('run-1')?.status).toBe('cancelled');
  }, 10_000);

  it('a synchronous dispatch that settles normally is unaffected (control)', async () => {
    await makeRoutes();
    const agentSession = {
      model: { provider: 'provider', id: 'model' },
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    // The turn's agent_end arrives right after dispatch: normal settle.
    multiSessionManager.addApiObserver.mockImplementation((_path: string, observer: (event: any) => void) => {
      process.nextTick(() => {
        observer({ type: 'agent_end', sessionId: 'session-1', timestamp: now, data: {} });
      });
    });

    const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'hello' });
    const res = mockRes();
    await routes.handleSendPrompt(req, res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.turnComplete).toBe(true);
  }, 10_000);
});

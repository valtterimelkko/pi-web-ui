/**
 * Phase 1 (contract 1.45.0, INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md)
 * — PROMPT_NOT_EXECUTED fail-fast.
 *
 * Incident shape (23 Sep): an extension input hook (auto-compact-75 fence)
 * returns {action:"handled"}, the Pi SDK prompt() resolves WITHOUT starting a
 * turn, and the run receipt waits for an agent_end that never comes until the
 * 15-minute watchdog declares TURN_STALLED. The conductor lost an hour to a
 * silently swallowed prompt reported as accepted.
 *
 * Rule (mode === 'prompt' only, never steer/follow_up): once prompt() resolves,
 * if no agent_start and no compaction event were observed in the run's window,
 * and the session is not streaming, wait a bounded grace for a late agent_start;
 * if none arrives, fail the run with PROMPT_NOT_EXECUTED.
 *
 * The grace window is tunable via PI_PROMPT_EXECUTION_GRACE_MS so tests stay
 * fast without weakening the production default (2000 ms).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

const GRACE_MS = 40;

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
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number; headers: Record<string, unknown> };
  res.statusCode = 200;
  res.headers = headers;
  res.setHeader = vi.fn((name: string, value: unknown) => { headers[name] = value; }) as any;
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

function createMultiSessionManagerMock() {
  return {
    getAgentSession: vi.fn(() => null),
    subscribeClient: vi.fn().mockResolvedValue(undefined),
    unsubscribeClient: vi.fn(),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    pinSession: vi.fn(() => true),
    unpinSession: vi.fn(() => true),
    isSessionPinned: vi.fn(() => false),
  };
}

function piEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    path: 'session-1',
    sdkType: 'pi',
    cwd: '/root/pi-web-ui',
    model: 'zai/glm-5.3',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-07-15T12:00:00.000Z',
    lastActivity: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('PROMPT_NOT_EXECUTED fail-fast (Phase 1, contract 1.45.0)', () => {
  let dir: string;
  let registry: any;
  let multiSessionManager: ReturnType<typeof createMultiSessionManagerMock>;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let observers: Set<(event: unknown) => void>;
  let priorGrace: string | undefined;

  beforeEach(async () => {
    priorGrace = process.env.PI_PROMPT_EXECUTION_GRACE_MS;
    process.env.PI_PROMPT_EXECUTION_GRACE_MS = String(GRACE_MS);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-prompt-not-executed-'));
    registry = {
      get: vi.fn().mockResolvedValue(piEntry()),
      listAll: vi.fn().mockResolvedValue([piEntry()]),
      delete: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager = createMultiSessionManagerMock();
    observers = new Set();
    multiSessionManager.addApiObserver.mockImplementation((_path: string, observer: (event: unknown) => void) => { observers.add(observer); });
    multiSessionManager.removeApiObserver.mockImplementation((_path: string, observer: (event: unknown) => void) => { observers.delete(observer); });
    manager = new RunReceiptManager({ store: new RunReceiptStore(dir), idFactory: (() => {
      let n = 0;
      return () => `pne-${++n}`;
    })() });
    await manager.init();
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      opencodeService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager: multiSessionManager as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: { setModel: vi.fn().mockResolvedValue(undefined) } as any,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    if (priorGrace === undefined) delete process.env.PI_PROMPT_EXECUTION_GRACE_MS;
    else process.env.PI_PROMPT_EXECUTION_GRACE_MS = priorGrace;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function mockFencedAgentSession(): { prompt: ReturnType<typeof vi.fn>; isStreaming: boolean } {
    // The fenced-worker shape: prompt() resolves (the extension input hook
    // returned "handled") and NOTHING else ever happens.
    const agentSession = {
      model: { provider: 'zai', id: 'glm-5.3' },
      isStreaming: false,
      prompt: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);
    return agentSession;
  }

  it('RED: fails a swallowed detached Pi prompt with PROMPT_NOT_EXECUTED shortly after prompt() resolves', async () => {
    mockFencedAgentSession();

    const acceptedAt = Date.now();
    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'reply PONG if you run', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);
    expect(response.statusCode).toBe(202);

    // The receipt must go terminal-FAILED well inside the 5 s bound (S1).
    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('failed'), { timeout: 3000 });
    const receipt = manager.get(runId);
    expect(receipt).toMatchObject({ status: 'failed', errorCode: 'PROMPT_NOT_EXECUTED' });
    expect(receipt?.terminalAt ? Date.parse(receipt.terminalAt) - acceptedAt : Infinity).toBeLessThan(5000);
  });

  it('RED: fails a swallowed synchronous Pi prompt with PROMPT_NOT_EXECUTED and surfaces the runId', async () => {
    mockFencedAgentSession();

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'reply PONG if you run' }),
      response,
      'session-1',
    );

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.runId).toMatch(/^pne-/);
    const lookup = mockRes();
    await routes.handleGetRunReceipt(jsonReq('GET', `/api/v1/runs/${body.runId}`), lookup, body.runId);
    expect(JSON.parse(lookup.body)).toMatchObject({ status: 'failed', errorCode: 'PROMPT_NOT_EXECUTED' });
  });

  it('does not misfire when agent_start arrives within the grace window (slow but real start)', async () => {
    let releasePrompt!: () => void;
    const promptReturned = new Promise<void>((resolve) => { releasePrompt = resolve; });
    multiSessionManager.getAgentSession.mockReturnValue({
      model: { provider: 'zai', id: 'glm-5.3' },
      isStreaming: false,
      prompt: vi.fn(() => promptReturned),
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'slow start', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);
    await vi.waitFor(() => expect(observers.size).toBeGreaterThanOrEqual(2));

    // The real (slow) sequence: prompt returns, then the turn starts late but
    // inside the grace window, then the turn ends.
    releasePrompt();
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS / 2));
    for (const observer of [...observers]) observer({ type: 'agent_start', sessionId: 'session-1', timestamp: Date.now(), data: {} });

    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(manager.get(runId)?.status).toBe('started');

    const endedAt = Date.now();
    for (const observer of [...observers]) observer({ type: 'agent_end', sessionId: 'session-1', timestamp: endedAt, data: {} });
    await vi.waitFor(() => expect(manager.get(runId)).toMatchObject({ status: 'completed' }));
  });

  it('does not misfire when a compaction event was observed in the run window (compaction exemption)', async () => {
    let releasePrompt!: () => void;
    const promptReturned = new Promise<void>((resolve) => { releasePrompt = resolve; });
    multiSessionManager.getAgentSession.mockReturnValue({
      model: { provider: 'zai', id: 'glm-5.3' },
      isStreaming: false,
      prompt: vi.fn(() => promptReturned),
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'compact then resume', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);
    await vi.waitFor(() => expect(observers.size).toBeGreaterThanOrEqual(2));

    for (const observer of [...observers]) observer({ type: 'session_compaction', sessionId: 'session-1', timestamp: Date.now(), data: {} });
    releasePrompt();

    // prompt() resolved after a compaction event with no agent_start yet: the
    // receipt must stay nonterminal (the resumed agent_start may be late —
    // pinned behaviour eb4d3463) and must NOT be failed by the new check.
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(manager.get(runId)?.status).toBe('started');
    expect(manager.get(runId)?.errorCode).toBeUndefined();
  });

  it('does not misfire when the session is streaming at the decision point', async () => {
    let releasePrompt!: () => void;
    const promptReturned = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const agentSession = {
      model: { provider: 'zai', id: 'glm-5.3' },
      isStreaming: false,
      prompt: vi.fn(() => promptReturned),
    };
    multiSessionManager.getAgentSession.mockReturnValue(agentSession);

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'streaming check', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);
    await vi.waitFor(() => expect(observers.size).toBeGreaterThanOrEqual(2));

    // The turn IS live while prompt() is still pending: the decision point
    // after prompt() resolves must see a streaming session and stay quiet.
    for (const observer of [...observers]) observer({ type: 'agent_start', sessionId: 'session-1', timestamp: Date.now(), data: {} });
    agentSession.isStreaming = true;
    releasePrompt();

    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 3));
    expect(manager.get(runId)?.status).toBe('started');
  });

  it('uses the MultiSessionManager turn-start waiter when the manager provides one', async () => {
    let resolveWaiter!: () => void;
    const waiterStarted = new Promise<void>((resolve) => { resolveWaiter = resolve; });
    const cancel = vi.fn();
    multiSessionManager.observeTurnStart = vi.fn().mockReturnValue({ started: waiterStarted, cancel });
    let releasePrompt!: () => void;
    const promptReturned = new Promise<void>((resolve) => { releasePrompt = resolve; });
    multiSessionManager.getAgentSession.mockReturnValue({
      model: { provider: 'zai', id: 'glm-5.3' },
      isStreaming: false,
      prompt: vi.fn(() => promptReturned),
    });

    const response = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'waiter path', detach: true }),
      response,
      'session-1',
    );
    const { runId } = JSON.parse(response.body);
    await vi.waitFor(() => expect(multiSessionManager.observeTurnStart).toHaveBeenCalledWith('session-1'));

    // Swallowed shape: prompt resolves, the waiter never fires.
    releasePrompt();
    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('failed'), { timeout: 3000 });
    expect(manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'PROMPT_NOT_EXECUTED' });
    expect(cancel).toHaveBeenCalled();

    // A waiter that resolves late (after the failure) must not resurrect the run.
    resolveWaiter();
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2));
    expect(manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'PROMPT_NOT_EXECUTED' });
  });
});

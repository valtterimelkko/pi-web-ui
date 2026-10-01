/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
/**
 * I2 (orchestration-scaling plan): every follow-up drained inside ONE Pi agent
 * loop reaches a terminal receipt.
 *
 * The Pi SDK drains queued follow-ups inside the SAME agent loop
 * (`@earendil-works/pi-agent-core` agent-loop.js: the loop, at its would-stop
 * point, pulls `getFollowUpMessages()` and continues; ONE `agent_end` closes
 * the whole drain). The AgentSession mirror removes a queued text and emits
 * `queue_update` (post-shrink) immediately BEFORE the matching user
 * `message_start` reaches listeners.
 *
 * These tests drive the real queued-run correlation in
 * `routes/sessions.ts` through that exact event order with an SDK simulator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

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

type RawEvent = Record<string, unknown>;

/**
 * The manager's normalizeEventForApi copy-list: raw SDK top-level fields that
 * move into the NormalizedEvent `data` payload for API observers.
 */
const NORMALIZED_DATA_FIELDS = [
  'message', 'assistantMessageEvent', 'steering', 'followUp',
  'toolCallId', 'toolName', 'args', 'result', 'isError', 'reason', 'aborted', 'willRetry',
] as const;

function normalizeSdkEvent(event: RawEvent): RawEvent {
  if (event.data !== undefined && event.timestamp !== undefined) return event;
  const data: Record<string, unknown> = {};
  for (const field of NORMALIZED_DATA_FIELDS) {
    if (field in event) data[field] = event[field];
  }
  return { type: event.type, timestamp: event.timestamp ?? Date.now(), data };
}

/**
 * Minimal AgentSession simulator that reproduces the real queue/delivery event
 * order: enqueue mirrors the queue and emits queue_update; a drained follow-up
 * is spliced from the mirror (queue_update, post-shrink) and THEN emitted as a
 * user message_start; assistant turns stream; agent_end closes the loop.
 */
function createSdkSimulator(emitRaw: (event: RawEvent) => void) {
  const emit = (event: RawEvent): void => emitRaw(normalizeSdkEvent(event));
  const followUpQueue: string[] = [];
  let clock = 1_000;
  const ts = () => (clock += 1);
  const queueUpdate = () => emit({ type: 'queue_update', timestamp: ts(), steering: [], followUp: [...followUpQueue] });
  return {
    agentSession: {
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(async (message: string) => { followUpQueue.push(message); queueUpdate(); }),
      steer: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      getFollowUpMessages: vi.fn(() => [...followUpQueue]),
    },
    /** SDK takes one queued follow-up for delivery: shrink mirror, then user message_start. */
    drainOne(text: string): void {
      const index = followUpQueue.indexOf(text);
      if (index !== -1) followUpQueue.splice(index, 1);
      queueUpdate();
      emit({
        type: 'message_start',
        timestamp: ts(),
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
    },
    /** A drained follow-up whose delivered text does not match what the API caller sent. */
    drainTransformed(actual: string): void {
      const index = followUpQueue.indexOf(actual);
      if (index !== -1) followUpQueue.splice(index, 1);
      queueUpdate();
      emit({
        type: 'message_start',
        timestamp: ts(),
        message: { role: 'user', content: [{ type: 'text', text: `${actual}-transformed` }] },
      });
    },
    /** One assistant answer segment. */
    assistantSay(text: string): void {
      emit({ type: 'message_start', timestamp: ts(), message: { role: 'assistant', content: [] } });
      emit({ type: 'message_update', timestamp: ts(), assistantMessageEvent: { type: 'text_delta', delta: text } });
      emit({
        type: 'message_end',
        timestamp: ts(),
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    },
    agentEnd(): void {
      emit({ type: 'agent_end', timestamp: ts(), data: {} });
    },
    /** clearQueue(): mirror emptied + one queue_update (the SDK's public clear). */
    clearQueue(): void {
      followUpQueue.splice(0, followUpQueue.length);
      queueUpdate();
    },
    queueSnapshot(): string[] {
      return [...followUpQueue];
    },
  };
}

describe('I2: coalesced Pi follow-ups drained in one agent loop', () => {
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
  let agentSession: ReturnType<typeof createSdkSimulator>['agentSession'] | undefined;
  const sweepIntervalMs = 15;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-followup-coalescing-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    registry = {
      get: vi.fn().mockResolvedValue(entry()),
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
      getAgentSession: vi.fn(() => agentSession),
      getSessionStatus: vi.fn(() => ({ status: 'streaming' })),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      getAllSessionStatuses: vi.fn(() => []),
    };
  });

  afterEach(async () => {
    await routes?.shutdown();
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function makeRoutes(): Promise<ReturnType<typeof createSdkSimulator>> {
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    await manager.init();
    const observers: Array<(event: unknown) => void> = [];
    multiSessionManager.addApiObserver.mockImplementation((_sessionPath: string, observer: (event: unknown) => void) => {
      observers.push(observer);
    });
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
      followUpSettleSweepIntervalMs: sweepIntervalMs,
    } as Partial<SessionRoutesDeps> as SessionRoutesDeps);
    const sdk = createSdkSimulator((event) => {
      for (const observer of [...observers]) {
        try { observer(event); } catch { /* non-fatal */ }
      }
    });
    agentSession = sdk.agentSession;
    multiSessionManager.getAgentSession.mockReturnValue(sdk.agentSession);
    return sdk;
  }

  /** Queue one follow_up behind the live turn; returns its runId. */
  async function queueFollowUp(message: string): Promise<string> {
    const res = mockRes();
    await routes.handleSendPrompt(
      jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message, mode: 'follow_up', detach: true }),
      res,
      'session-1',
    );
    expect(res.statusCode).toBe(202);
    return JSON.parse(res.body).runId as string;
  }

  const settle = async () => new Promise((resolve) => setImmediate(resolve));

  it('A. two follow-ups drained in ONE agent loop both reach completed with their own final text', async () => {
    const sdk = await makeRoutes();
    const runOne = await queueFollowUp('FIRST');
    const runTwo = await queueFollowUp('SECOND');

    // One agent loop drains both: m1 -> answer -> m2 -> answer -> single agent_end.
    sdk.drainOne('FIRST');
    sdk.assistantSay('ANSWER-ONE');
    sdk.drainOne('SECOND');
    sdk.assistantSay('ANSWER-TWO');
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle' });
    sdk.agentEnd();
    await vi.waitFor(() => expect(manager.get(runOne)?.status).toBe('completed'));

    const one = manager.get(runOne);
    const two = manager.get(runTwo);
    expect(one?.status).toBe('completed');
    expect(two?.status).toBe('completed');
    expect(one?.startedAt).toBeDefined();
    expect(two?.startedAt).toBeDefined();
    // Each follow-up owns the assistant text between its own user message and
    // the next follow-up's user message (or the loop's agent_end).
    expect(one?.finalText).toBe('ANSWER-ONE');
    expect(two?.finalText).toBe('ANSWER-TWO');
    expect(one?.terminalAt).toBeDefined();
    expect(two?.terminalAt).toBeDefined();
  });

  it('B. an armed follow-up whose user message never matches is terminalised, never left queued', async () => {
    const sdk = await makeRoutes();
    const runId = await queueFollowUp('PLANNED');

    // The SDK consumed the queue entry but delivered a different text: the
    // correlation is armed (queue shrink observed) yet never matches.
    sdk.drainTransformed('PLANNED');
    sdk.assistantSay('ANSWER-TO-SOMETHING-ELSE');
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle' });
    sdk.agentEnd();
    await vi.waitFor(() => expect(manager.get(runId)?.status).not.toBe('queued'));

    const receipt = manager.get(runId);
    expect(receipt?.status).not.toBe('queued');
    expect(receipt?.status).toBe('failed');
    expect(receipt?.errorCode).toBe('NEVER_STARTED');
    expect(receipt?.startedAt).toBeUndefined();
    expect(receipt?.terminalAt).toBeDefined();
  });

  it('C. abort does not drop a queued follow-up: it stays queued and completes when a later loop drains it', async () => {
    const sdk = await makeRoutes();
    const runOne = await queueFollowUp('FIRST');
    const runTwo = await queueFollowUp('SECOND');

    // The loop delivers FIRST, answers, then ABORTS: the early return emits
    // agent_end without draining SECOND, and the SDK queue keeps SECOND.
    sdk.drainOne('FIRST');
    sdk.assistantSay('ANSWER-ONE');
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle' });
    sdk.agentEnd();
    await vi.waitFor(() => expect(manager.get(runOne)?.status).toBe('completed'));

    // The aborted loop did not consume SECOND: still queued, still deliverable.
    expect(manager.get(runTwo)?.status).toBe('queued');
    expect(sdk.queueSnapshot()).toEqual(['SECOND']);
    expect(manager.get(runTwo)?.finalText).toBeUndefined();

    // A later loop (next prompt) drains SECOND inside its own agent loop.
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    sdk.drainOne('SECOND');
    sdk.assistantSay('ANSWER-TWO');
    sdk.agentEnd();
    await vi.waitFor(() => expect(manager.get(runTwo)?.status).toBe('completed'));
    expect(manager.get(runTwo)?.finalText).toBe('ANSWER-TWO');
  });

  it('D. a cleared follow-up queue (clearQueue semantics) terminalises the undelivered receipt at the loop end', async () => {
    const sdk = await makeRoutes();
    const runId = await queueFollowUp('CLEARED');

    // clearQueue(): mirror emptied, queue_update shrink arms the correlation.
    sdk.clearQueue();
    sdk.assistantSay('ANSWER-WITHOUT-IT');
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle' });
    sdk.agentEnd();
    await vi.waitFor(() => expect(manager.get(runId)?.status).not.toBe('queued'));

    const receipt = manager.get(runId);
    expect(receipt?.status).not.toBe('queued');
    expect(receipt?.status).toBe('failed');
    expect(receipt?.errorCode).toBe('NEVER_STARTED');
  });

  it('E. an unloaded session cannot deliver its queued follow-up: the settle sweep terminalises it', async () => {
    const sdk = await makeRoutes();
    const runId = await queueFollowUp('WAITING');

    // Abort-shaped settle: the follow-up stays queued (still in the SDK queue).
    sdk.agentEnd();
    await settle();
    expect(manager.get(runId)?.status).toBe('queued');

    // The manager unloads the idle session: the agent (and its queue) is gone.
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle' });
    multiSessionManager.getAgentSession.mockReturnValue(undefined);

    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('failed'), { timeout: 2_000 });
    const receipt = manager.get(runId);
    expect(receipt?.errorCode).toBe('NEVER_STARTED');
    expect(receipt?.startedAt).toBeUndefined();
  });

  it('F. a single follow-up drained in its own loop keeps the C2 outcome unchanged', async () => {
    const sdk = await makeRoutes();
    const runId = await queueFollowUp('ONLY');

    sdk.drainOne('ONLY');
    sdk.assistantSay('ANSWER-ONLY');
    sdk.agentEnd();
    await vi.waitFor(() => expect(manager.get(runId)?.status).toBe('completed'));

    const receipt = manager.get(runId);
    expect(receipt?.status).toBe('completed');
    expect(receipt?.finalText).toBe('ANSWER-ONLY');
    expect(receipt?.startedAt).toBeDefined();
  });
});

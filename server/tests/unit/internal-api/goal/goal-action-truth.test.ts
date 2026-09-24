/**
 * Phase 2 (contract 1.45.0, INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md)
 * — goal actions tell the truth at the route boundary.
 *
 * Incident shape (23 Sep): POST /sessions/:id/goal {action:"start"} on a
 * fenced Pi session dispatched the composed /goal command, the goal-engine's
 * ensureMutable() refused with only a ctx.ui.notify, the slash command
 * completed at documented_handler_return, and the API answered
 * `200 accepted:true` — success for an action that did not happen.
 *
 * Now: the transition is verified at the command boundary (the extension
 * persists synchronously before the command returns) and a not-applied
 * transition fails the receipt with GOAL_ACTION_NOT_APPLIED and answers 409
 * with the observed goal plus the extension's own warning text. Honest no-ops
 * (clear on an already-inactive goal) answer 200 applied:false instead of a
 * fake completed. This is a deliberate behaviour change, not purely additive.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../../src/internal-api/run-receipts/run-receipt-store.js';
import { piGoalStatePath } from '../../../../src/internal-api/goal/pi-goal.js';

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
    model: 'provider/model',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-08-27T12:00:00.000Z',
    lastActivity: '2026-08-27T12:00:00.000Z',
    ...overrides,
  };
}

async function writeGoalState(overrides: Record<string, unknown>): Promise<void> {
  const statePath = piGoalStatePath(SESSION_PATH);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({ status: 'idle', turnCount: 0, ...overrides }));
}

describe('goal actions tell the truth (Phase 2, contract 1.45.0)', () => {
  let dir: string;
  let registry: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let agentSession: { prompt: ReturnType<typeof vi.fn>; followUp: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; model: unknown };
  let priorHome: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-goal-truth-'));
    priorHome = process.env.HOME;
    process.env.HOME = dir;
    agentSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      steer: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      model: { provider: 'zai', id: 'glm-5.3' },
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
      getAgentSession: vi.fn(() => agentSession),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      getAllSessionStatuses: vi.fn(() => []),
      isSessionPinned: vi.fn(() => false),
      getExtensionUiNotifications: vi.fn(() => [
        'Goal Engine is read-only because this runtime does not own the session: session is owned by another live runtime (pid 4242).',
      ]),
    };
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, {}),
      idFactory: (() => { let n = 0; return () => `truth-${++n}`; })(),
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false), abort: vi.fn(), getBackendMode: vi.fn().mockResolvedValue('sdk') } as any,
      opencodeService: { isRunning: vi.fn(() => false), isEnabled: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false), abort: vi.fn() } as any,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      runReceiptManager: manager,
    });
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('RED: a fenced start answers 409 GOAL_ACTION_NOT_APPLIED with the observed goal and the extension warning', async () => {
    // Fenced: the extension refuses mutation (notify only); no state is written.
    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'write the thing' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      code: 'GOAL_ACTION_NOT_APPLIED',
      accepted: false,
      applied: false,
      action: 'start',
      receipt: { status: 'failed', errorCode: 'GOAL_ACTION_NOT_APPLIED' },
    });
    expect(body.observedGoal).toMatchObject({ supported: true, status: 'idle' });
    expect(body.extensionWarnings.join(' ')).toContain('read-only because this runtime does not own the session');

    // The inner run's receipt must be failed, not completed.
    const runId = body.receipt.runId as string;
    expect(manager.get(runId)).toMatchObject({ status: 'failed', errorCode: 'GOAL_ACTION_NOT_APPLIED' });
  });

  it('a genuine start answers 200 applied:true with the fresh projection', async () => {
    agentSession.prompt.mockImplementation(async (message: string) => {
      if (message.startsWith('/goal "')) {
        await writeGoalState({ objective: 'write the thing', status: 'running' });
      }
    });

    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'write the thing' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ accepted: true, applied: true, action: 'start' });
    expect(body.goal).toMatchObject({ status: 'running', objective: 'write the thing' });
  });

  it('start on an achieved goal replaces it (S4)', async () => {
    await writeGoalState({ objective: 'old objective', status: 'achieved', completedAt: 5 });
    agentSession.prompt.mockImplementation(async (message: string) => {
      if (message.startsWith('/goal "')) {
        await writeGoalState({ objective: 'next objective', status: 'running' });
      }
    });

    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'next objective' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ accepted: true, applied: true });
    expect(body.goal).toMatchObject({ status: 'running', objective: 'next objective' });
  });

  it('RED: clear on an already-inactive goal answers 200 applied:false already_inactive (S4)', async () => {
    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'clear' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ accepted: true, applied: false, reason: 'already_inactive' });
    expect(body.goal).toMatchObject({ status: 'idle' });
  });

  it('malformed start still answers 400 INVALID_REQUEST and never dispatches (S3 blocked case)', async () => {
    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    expect(agentSession.prompt).not.toHaveBeenCalled();
  });

  it('round 2: clear composes --yes and start composes --replace when requested', async () => {
    // Route-level non-interactive default: clear always force-confirms via
    // --yes (orchestrators cannot answer the extension's confirm).
    const clearRes = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'clear' }),
      clearRes,
      'session-1',
    );
    expect(agentSession.prompt).toHaveBeenCalledWith('/goal clear --yes');

    agentSession.prompt.mockClear();
    const startRes = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'override me', replace: true }),
      startRes,
      'session-1',
    );
    expect(agentSession.prompt).toHaveBeenCalledWith('/goal "override me" --replace');

    // Legacy shapes stay byte-identical without the flags (pinned contract).
    agentSession.prompt.mockClear();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'plain start' }),
      mockRes(),
      'session-1',
    );
    expect(agentSession.prompt).toHaveBeenCalledWith('/goal "plain start"');
  });

  it('a busy session keeps the queued accepted shape (goal state may lag mid-run)', async () => {
    multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    const res = mockRes();
    await routes.handleSessionGoalControl(
      jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'pause' }),
      res,
      'session-1',
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(true);
    expect(agentSession.prompt).toHaveBeenCalledWith('/goal pause-now');
  });
});

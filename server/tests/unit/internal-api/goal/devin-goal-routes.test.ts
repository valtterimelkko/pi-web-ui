/**
 * Devin goal function (contract 1.68.0) — route-level behaviour tests.
 *
 * Mirrors the antigravity server-side goal manager's route surface
 * (contract 1.38.0) for the devin runtime: POST/GET /sessions/:id/goal,
 * `/goal …` interception at the prompt boundary, goalId-stamped
 * goal_state/goal_end events, and the create-with-goal arming path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionRoutes } from '../../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../../src/internal-api/run-receipts/run-receipt-store.js';
import { DEVIN_GOAL_SENTINEL } from '../../../../src/internal-api/goal/devin-goal.js';

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
    sdkType: 'devin',
    cwd: os.tmpdir(),
    model: 'swe-2-flash-medium',
    firstMessage: 'first',
    messageCount: 0,
    status: 'idle',
    createdAt: '2026-11-08T12:00:00.000Z',
    lastActivity: '2026-11-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('devin goal function (contract 1.68.0)', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let devinService: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let browserMessages: Array<Record<string, unknown>>;

  beforeEach(async () => {
    // Route construction loads the goal-sweep cadence from the environment at
    // startup: tighten it for the whole file so sweeper-driven assertions do
    // not wait the 15 s default.
    process.env.DEVIN_GOAL_SWEEP_MS = '250';
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devin-goal-routes-'));
    browserMessages = [];
    registry = {
      get: vi.fn(async (id: string) => entry({ id, path: id })),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      executionBackend: vi.fn(() => 'sdk-subscription'),
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false), isEnabled: vi.fn(() => false) };
    antigravityService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn((_id: string, _message: string, _broadcast: unknown, complete: (error?: Error) => void) => {
        complete();
        return Promise.resolve();
      }),
      followUp: vi.fn(() => Promise.resolve(true)),
      getLastCompletedTurn: vi.fn(async () => null),
      getSessionCwd: vi.fn(async () => os.tmpdir()),
      abort: vi.fn(),
    };
    devinService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      createSession: vi.fn(async () => ({ sessionId: `devin-${Math.random().toString(16).slice(2, 10)}` })),
      sendPrompt: vi.fn((_id: string, _message: string, _broadcast: unknown, complete: (error?: Error) => void) => {
        complete();
        return Promise.resolve();
      }),
      followUp: vi.fn(() => Promise.resolve(true)),
      getLastCompletedTurn: vi.fn(async () => null),
      getSessionCwd: vi.fn(async () => os.tmpdir()),
      getServedModel: vi.fn(async (id: string) => (id === 'session-1' ? 'swe-2-flash-medium' : undefined)),
      abort: vi.fn(),
    };
    piService = {
      getAvailableModels: vi.fn().mockResolvedValue([
        { id: 'glm-5.3', name: 'GLM-5.3', provider: 'zai', contextWindow: 200000 },
      ]),
      setModel: vi.fn().mockResolvedValue(undefined),
    };
    multiSessionManager = {
      getAgentSession: vi.fn(() => undefined),
      getSessionStatus: vi.fn(() => ({ status: 'idle' })),
      subscribeClient: vi.fn().mockResolvedValue(undefined),
      unsubscribeClient: vi.fn().mockResolvedValue(undefined),
      addApiObserver: vi.fn(),
      removeApiObserver: vi.fn(),
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      getAllSessionStatuses: vi.fn(() => []),
      createAndSubscribe: vi.fn(async () => ({ sessionId: 'pi-new', sessionPath: '/tmp/sessions/pi-new.jsonl' })),
      isSessionPinned: vi.fn(() => false),
    };
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, {}),
      idFactory: (() => { let n = 0; return () => `run-${++n}`; })(),
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    await manager.init();
    routes = createSessionRoutes({
      claudeService,
      opencodeService,
      antigravityService,
      devinService,
      multiSessionManager,
      sessionRegistry: registry,
      piService,
      internalClientId: 'test-client',
      watchDir: path.join(dir, 'watches'),
      pinDir: path.join(dir, 'pins'),
      claudeSessionDir: path.join(dir, 'claude-sessions'),
      antigravitySessionDir: path.join(dir, 'antigravity-sessions'),
      devinSessionDir: path.join(dir, 'devin-sessions'),
      claudeProjectsDir: path.join(dir, '.claude', 'projects'),
      pinExpiryIntervalMs: 60_000,
      runReceiptManager: manager,
      onBrowserMessage: (message) => browserMessages.push(message),
    });
  });

  afterEach(async () => {
    delete process.env.DEVIN_GOAL_SWEEP_MS;
    await routes?.shutdown();
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function recordPath(): string {
    return path.join(dir, 'devin-sessions', 'goal-control', 'session-1.json');
  }

  // ── GET /sessions/:id/goal ────────────────────────────────────────────────

  it('projects an idle devin goal as supported, and a started goal as running with goalId', async () => {
    const idle = mockRes();
    await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/session-1/goal'), idle, 'session-1');
    expect(JSON.parse(idle.body)).toMatchObject({ sessionId: 'session-1', runtime: 'devin', supported: true, status: 'idle' });

    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Ship the release' }), mockRes(), 'session-1');
    await vi.waitFor(() => expect(manager.hasActiveRun('session-1')).toBe(false));

    const running = mockRes();
    await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/session-1/goal'), running, 'session-1');
    const goal = JSON.parse(running.body);
    expect(goal).toMatchObject({ runtime: 'devin', supported: true, status: 'running', objective: 'Ship the release', maxRuns: 100, autoContinue: true });
    expect(goal.goalId).toMatch(/^goal_/);
  });

  // ── POST /sessions/:id/goal ───────────────────────────────────────────────

  it('start arms the store, dispatches the goal prompt (sentinel without verify) and answers running', async () => {
    const req = jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Ship the release' });
    const res = mockRes();
    await routes.handleSessionGoalControl(req, res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ accepted: true, action: 'start', runtime: 'devin' });
    expect(body.goal).toMatchObject({ supported: true, status: 'running', objective: 'Ship the release', maxRuns: 100 });
    expect(devinService.sendPrompt).toHaveBeenCalledTimes(1);
    const prompt = devinService.sendPrompt.mock.calls[0][1] as string;
    expect(prompt).toContain('Ship the release');
    expect(prompt).toContain(DEVIN_GOAL_SENTINEL);
    const record = JSON.parse(await fs.readFile(recordPath(), 'utf8'));
    expect(record).toMatchObject({ objective: 'Ship the release', status: 'running', maxRuns: 100, autoContinue: true });
  });

  it('start with verifyCommand omits the sentinel and stores the verifier', async () => {
    const req = jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Lint clean', verifyCommand: 'npm run lint', maxTurns: 5 });
    const res = mockRes();
    await routes.handleSessionGoalControl(req, res, 'session-1');

    expect(res.statusCode).toBe(200);
    const prompt = devinService.sendPrompt.mock.calls[0][1] as string;
    expect(prompt).not.toContain(DEVIN_GOAL_SENTINEL);
    const record = JSON.parse(await fs.readFile(recordPath(), 'utf8'));
    expect(record).toMatchObject({ objective: 'Lint clean', verifyCommand: 'npm run lint', status: 'running', maxRuns: 5, autoContinue: true });
    expect(JSON.parse(res.body).goal.maxRuns).toBe(5);
  });

  it('rejects an empty, multi-line or over-long objective with 400', async () => {
    for (const objective of ['', '  ', 'two\nlines', `${'x'.repeat(4001)}`]) {
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective }), res, 'session-1');
      expect(res.statusCode, `objective ${JSON.stringify(objective.slice(0, 12))}`).toBe(400);
      expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    }
    expect(devinService.sendPrompt).not.toHaveBeenCalled();
  });

  it('start on a busy session arms without dispatching and says so', async () => {
    devinService.isRunning.mockReturnValue(true);
    const res = mockRes();
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Ship it' }), res, 'session-1');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).note).toContain('busy');
    expect(devinService.sendPrompt).not.toHaveBeenCalled();
  });

  it('pause/clear require an armed goal; pause disarms; resume re-arms and dispatches a continuation; clear retires', async () => {
    const pauseNone = mockRes();
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'pause' }), pauseNone, 'session-1');
    expect(pauseNone.statusCode).toBe(409);

    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Ship it' }), mockRes(), 'session-1');
    await vi.waitFor(() => expect(manager.hasActiveRun('session-1')).toBe(false));
    devinService.sendPrompt.mockClear();

    const pause = mockRes();
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'pause' }), pause, 'session-1');
    expect(pause.statusCode).toBe(200);
    expect(JSON.parse(pause.body).goal).toMatchObject({ status: 'paused', pausedReason: 'user', autoContinue: false });

    const resume = mockRes();
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'resume' }), resume, 'session-1');
    expect(resume.statusCode, resume.body).toBe(200);
    expect(JSON.parse(resume.body).goal).toMatchObject({ status: 'running', autoContinue: true });
    expect(devinService.sendPrompt).toHaveBeenCalledTimes(1);
    expect(devinService.sendPrompt.mock.calls[0][1] as string).toContain('Ship it');

    const clear = mockRes();
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'clear' }), clear, 'session-1');
    expect(clear.statusCode).toBe(200);
    expect(JSON.parse(clear.body).goal).toMatchObject({ status: 'cleared' });
    const record = JSON.parse(await fs.readFile(recordPath(), 'utf8'));
    expect(record.status).toBe('cleared');
  });

  it('a resume continuation in the settling window queues as a follow-up instead of being lost', async () => {
    // The start dispatch's turn is held (its per-session dispatch token keeps
    // the pipeline busy), so the resume's continuation cannot start a turn: it
    // rides the FIFO follow-up queue the same as every devin prompt.
    let finishTurn: (() => void) | undefined;
    devinService.sendPrompt.mockImplementation((_id: string, _message: string, _broadcast: unknown, complete: (error?: Error) => void) => {
      finishTurn = () => complete();
      return Promise.resolve();
    });
    // A queued follow-up's receipt settles only when the queue drains it; the
    // mock drains instantly (complete = the queued turn ran and ended).
    devinService.followUp.mockImplementation((_id: string, _message: string, _broadcast: unknown, complete: (error?: Error) => void) => {
      complete();
      return Promise.resolve(true);
    });
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Ship it' }), mockRes(), 'session-1');
    expect(devinService.sendPrompt).toHaveBeenCalledTimes(1);

    const resume = mockRes();
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'resume' }), resume, 'session-1');
    expect(resume.statusCode, resume.body).toBe(200);
    expect(JSON.parse(resume.body).goal).toMatchObject({ status: 'running', autoContinue: true });
    expect(devinService.followUp).toHaveBeenCalledTimes(1);
    expect(devinService.followUp.mock.calls[0][1] as string).toContain('Ship it');

    finishTurn?.();
    await vi.waitFor(() => expect(manager.hasActiveRun('session-1')).toBe(false));
  });

  // ── `/goal …` at the prompt boundary ──────────────────────────────────────

  it('/goal text at the prompt boundary is intercepted as goal control, even while busy', async () => {
    devinService.isRunning.mockReturnValue(true);
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/goal pause' }), res, 'session-1');

    expect(res.statusCode).toBe(409); // pause with no armed goal -> conflict
    expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    expect(devinService.sendPrompt).not.toHaveBeenCalled();
    expect(devinService.followUp).not.toHaveBeenCalled();
  });

  it('/goal start text arms a goal from the prompt boundary', async () => {
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/goal "Ship the beta"' }), res, 'session-1');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accepted).toBe(true);
    expect(body.goal).toMatchObject({ status: 'running', objective: 'Ship the beta' });
    expect(devinService.sendPrompt).toHaveBeenCalledTimes(1);
    expect(devinService.sendPrompt.mock.calls[0][1] as string).toContain('Ship the beta');
  });

  it('non-goal prompts still reach the runtime unchanged', async () => {
    const res = mockRes();
    await routes.handleSendPrompt(jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/goals are great but this is prose' }), res, 'session-1');
    expect(JSON.parse(res.body).goal).toBeUndefined();
  });

  // ── goal events (broker) ──────────────────────────────────────────────────

  it('publishes a goalId-stamped goal_state on arm, and goal_end when the sweeper achieves via the sentinel', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    routes.broker.subscribe('session-1', (event: any) => events.push(event));

    // Phase A: an unmet completed turn — the sweeper advances the goal (runs 1)
    // and publishes goal_state through the same broker pipeline as antigravity.
    let turn = { completedAt: Date.now(), response: 'making progress on the goal', status: 'done' as const };
    devinService.getLastCompletedTurn.mockImplementation(async () => turn);
    await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start', objective: 'Ship the release' }), mockRes(), 'session-1');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'goal_state' && (e.data as any)?.runs === 1)).toBe(true), { timeout: 10_000 });
    const armed = events.find((e) => e.type === 'goal_state');
    expect(armed?.data).toMatchObject({ status: 'running', objective: 'Ship the release' });
    expect((armed?.data as any)?.goalId).toMatch(/^goal_/);

    // Phase B: the continuation's turn self-reports the sentinel — goal_end.
    turn = { completedAt: Date.now() + 1, response: `done\n${DEVIN_GOAL_SENTINEL}`, status: 'done' };
    await vi.waitFor(() => expect(events.find((e) => e.type === 'goal_end')).toBeDefined(), { timeout: 10_000 });
    const achieved = events.find((e) => e.type === 'goal_end');
    expect(achieved?.data).toMatchObject({ status: 'achieved', objective: 'Ship the release' });
    expect((achieved?.data as any)?.goalId).toMatch(/^goal_/);
    expect((achieved?.data as any)?.verification).toMatchObject({ status: 'self_reported' });
  });

  // ── create-with-goal ──────────────────────────────────────────────────────

  it('create with a goal arms it for the new devin session', async () => {
    registry.upsert.mockResolvedValue(undefined);
    const res = mockRes();
    await routes.handleCreateSession(
      jsonReq('POST', '/api/v1/sessions', { runtime: 'devin', cwd: os.tmpdir(), goal: { objective: 'Ship it', maxTurns: 3 } }),
      res,
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.goal).toMatchObject({ armed: true });
    const newId = body.sessionId as string;
    const record = JSON.parse(await fs.readFile(path.join(dir, 'devin-sessions', 'goal-control', `${newId}.json`), 'utf8'));
    expect(record).toMatchObject({ objective: 'Ship it', status: 'running', maxRuns: 3 });
    expect(devinService.sendPrompt).toHaveBeenCalledTimes(1);
    expect(devinService.sendPrompt.mock.calls[0][0] as string).toBe(newId);
  });
});

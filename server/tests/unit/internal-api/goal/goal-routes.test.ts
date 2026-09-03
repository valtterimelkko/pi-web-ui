/**
 * Cross-runtime goal function (contract 1.27.0) — route-level behaviour tests.
 *
 * Covers:
 *  - Phase 1a: Pi slash commands pass through on a busy session (409 exemption),
 *    mirroring the WebSocket path; non-slash prompts and non-Pi runtimes do not.
 *  - Phase 1b/1c: GET/POST /sessions/:id/goal (Pi) — layered on top of the
 *    prompt pipeline, composing real `/goal …` slash commands.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- route harness mirrors heterogeneous runtime service mocks */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../../src/internal-api/routes/sessions.js';
import { RunReceiptManager } from '../../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../../src/internal-api/run-receipts/run-receipt-store.js';
import { piGoalStatePath } from '../../../../src/internal-api/goal/pi-goal.js';

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
    path: '/tmp/sessions/session-1.jsonl',
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

function createAgentSessionMock(overrides: Record<string, unknown> = {}) {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    model: { provider: 'zai', id: 'glm-5.3' },
    ...overrides,
  };
}

describe('goal function (contract 1.27.0)', () => {
  let dir: string;
  let registry: any;
  let claudeService: any;
  let opencodeService: any;
  let antigravityService: any;
  let multiSessionManager: any;
  let piService: any;
  let manager: RunReceiptManager;
  let routes: ReturnType<typeof createSessionRoutes>;
  let browserMessages: Array<Record<string, unknown>>;
  let observers: Array<(event: any) => void>;
  let agentSession: ReturnType<typeof createAgentSessionMock>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-goal-routes-'));
    observers = [];
    agentSession = createAgentSessionMock();
    registry = {
      get: vi.fn(async (id: string) => entry({ id, path: id === 'session-1' ? '/tmp/sessions/session-1.jsonl' : id })),
      listAll: vi.fn().mockResolvedValue([entry()]),
      upsert: vi.fn().mockResolvedValue(undefined),
      patchSessionMeta: vi.fn().mockResolvedValue(undefined),
    };
    claudeService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      isRunning: vi.fn(() => false),
      sendPrompt: vi.fn(),
      getBackendMode: vi.fn().mockResolvedValue('sdk'),
    };
    opencodeService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false), isEnabled: vi.fn(() => false) };
    antigravityService = { isAvailable: vi.fn().mockResolvedValue(true), isRunning: vi.fn(() => false) };
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
      addApiObserver: vi.fn((_path: string, observer: (event: any) => void) => { observers.push(observer); }),
      removeApiObserver: vi.fn((_path: string, observer: (event: any) => void) => {
        const i = observers.indexOf(observer);
        if (i >= 0) observers.splice(i, 1);
      }),
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
    browserMessages = [];
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
      claudeSessionDir: path.join(dir, 'claude-sessions'),
      claudeProjectsDir: path.join(dir, '.claude', 'projects'),
      pinExpiryIntervalMs: 60_000,
      runReceiptManager: manager,
      onBrowserMessage: (message) => browserMessages.push(message),
    });
  });

  afterEach(async () => {
    await manager?.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  // ── Phase 1b/1c: GET/POST /sessions/:id/goal ─────────────────────────────

  describe('phase 1b — GET /sessions/:id/goal', () => {
    it('answers an honest idle projection for a pi session with no goal history', async () => {
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/session-1/goal'), res, 'session-1');
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ sessionId: 'session-1', runtime: 'pi', supported: true, status: 'idle' });
    });

    it('projects a persisted achieved goal from the extension disk layout', async () => {
      const prevHome = process.env.HOME;
      process.env.HOME = dir;
      try {
        const statePath = piGoalStatePath('/tmp/sessions/session-1.jsonl');
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        await fs.writeFile(statePath, JSON.stringify({
          objective: 'Prove goals are readable', status: 'idle', turnCount: 2,
          startedAt: 1690000000000, completedAt: 1690000100000,
          lastVerificationStatus: 'passed', verifyCommand: 'test -f x', spentInputTokens: 500, spentUsd: 0.01,
        }));
        const res = mockRes();
        await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/session-1/goal'), res, 'session-1');
        const body = JSON.parse(res.body);
        expect(body.status).toBe('achieved');
        expect(body.objective).toBe('Prove goals are readable');
        expect(body.runs).toBe(2);
        expect(body.verification).toEqual({ status: 'passed', command: 'test -f x', message: null });
        expect(body.spend).toEqual({ inputTokens: 500, usd: 0.01 });
      } finally {
        process.env.HOME = prevHome;
      }
    });

    it('404s for an unknown session', async () => {
      registry.get.mockResolvedValue(null);
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/ghost/goal'), res, 'ghost');
      expect(res.statusCode).toBe(404);
    });

    it('reports unsupported honestly for out-of-scope runtimes', async () => {
      registry.get.mockResolvedValue(entry({ sdkType: 'antigravity' }));
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/session-1/goal'), res, 'session-1');
      expect(JSON.parse(res.body)).toMatchObject({ runtime: 'antigravity', supported: false, status: 'unknown' });
    });
  });

  describe('phase 1c — POST /sessions/:id/goal', () => {
    it('start composes the slash command, dispatches it through the pipeline and returns a fresh projection', async () => {
      const prevHome = process.env.HOME;
      process.env.HOME = dir;
      try {
        agentSession.prompt.mockImplementation(async (message: string) => {
          if (message.includes('--max-turns 5')) {
            const statePath = piGoalStatePath('/tmp/sessions/session-1.jsonl');
            await fs.mkdir(path.dirname(statePath), { recursive: true });
            await fs.writeFile(statePath, JSON.stringify({ objective: 'write the thing', status: 'running', turnCount: 0, maxTurns: 5 }));
          }
        });
        const req = jsonReq('POST', '/api/v1/sessions/session-1/goal', {
          action: 'start', objective: 'write the thing', maxTurns: 5,
        });
        const res = mockRes();
        await routes.handleSessionGoalControl(req, res, 'session-1');

        expect(res.statusCode).toBe(200);
        expect(agentSession.prompt).toHaveBeenCalledWith('/goal "write the thing" --max-turns 5');
        const body = JSON.parse(res.body);
        expect(body.accepted).toBe(true);
        expect(body.action).toBe('start');
        expect(body.receipt.runId).toBe('run-1');
        expect(body.goal).toMatchObject({ supported: true, status: 'running', objective: 'write the thing', maxRuns: 5 });
      } finally {
        process.env.HOME = prevHome;
      }
    });

    it('pause composes /goal pause-now and honours the busy pass-through mid-run', async () => {
      multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
      const req = jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'pause' });
      const res = mockRes();
      await routes.handleSessionGoalControl(req, res, 'session-1');
      expect(res.statusCode).toBe(200);
      expect(agentSession.prompt).toHaveBeenCalledWith('/goal pause-now');
    });

    it('rejects invalid bodies with 400 INVALID_REQUEST and never dispatches', async () => {
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'explode' }), res, 'session-1');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
      expect(agentSession.prompt).not.toHaveBeenCalled();

      const noObjective = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'start' }), noObjective, 'session-1');
      expect(noObjective.statusCode).toBe(400);
    });

    it('refuses non-pi runtimes with UNSUPPORTED_OPERATION and forwards pipeline refusals verbatim', async () => {
      registry.get.mockResolvedValue(entry({ sdkType: 'claude' }));
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/session-1/goal', { action: 'clear' }), res, 'session-1');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('UNSUPPORTED_OPERATION');

      registry.get.mockResolvedValue(null);
      const ghost = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/api/v1/sessions/ghost/goal', { action: 'clear' }), ghost, 'ghost');
      expect(ghost.statusCode).toBe(404);
    });
  });

  // ── Phase 2: Claude SDK goal read/control ──────────────────────────────

  describe('phase 2 — claude goal read/control', () => {
    const CLAUDE_SID = 'claude-session-1';
    const CLAUDE_CWD = '/work';
    let transcriptDir: string;

    beforeEach(async () => {
      transcriptDir = path.join(dir, '.claude', 'projects', '-work');
      await fs.mkdir(transcriptDir, { recursive: true });
      registry.get.mockImplementation(async (id: string) =>
        id === CLAUDE_SID
          ? entry({ id: CLAUDE_SID, sdkType: 'claude', cwd: CLAUDE_CWD, claudeSessionId: 'cs-uuid-1', claudeProfileBackend: 'sdk-subscription' })
          : entry({ id, path: id }),
      );
      multiSessionManager.getSessionStatus.mockReturnValue({ status: 'idle' });
      claudeService.isRunning.mockReturnValue(false);
    });

    function writeTranscript(lines: object[]): Promise<void> {
      return fs.writeFile(path.join(transcriptDir, 'cs-uuid-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
    const gs = (fields: object) => ({ type: 'attachment', timestamp: Date.now(), attachment: { type: 'goal_status', ...fields } });

    it('projects an achieved goal from the transcript', async () => {
      await writeTranscript([gs({ met: false, sentinel: true, condition: 'ship it' }), gs({ met: true, condition: 'ship it', reason: 'done' })]);
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/x/goal'), res, CLAUDE_SID);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ runtime: 'claude', supported: true, status: 'achieved', objective: 'ship it', lastReason: 'done' });
    });

    it('reports unmet goals as running by default; paused(user) after pause disarms auto-continue', async () => {
      await writeTranscript([gs({ met: false, sentinel: true, condition: 'g' })]);
      let res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/x/goal'), res, CLAUDE_SID);
      expect(JSON.parse(res.body).status).toBe('running');

      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'pause' }), mockRes(), CLAUDE_SID);
      res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/api/v1/sessions/x/goal'), res, CLAUDE_SID);
      expect(JSON.parse(res.body)).toMatchObject({ status: 'paused', pausedReason: 'user', autoContinue: false });
    });

    it('resume re-arms and dispatches the continuation prompt detached; pause never dispatches', async () => {
      claudeService.sendPrompt.mockImplementation((_id: string, _m: string, onEvent: (e: any) => void, onComplete: (e?: Error) => void) => {
        process.nextTick(() => onComplete());
      });
      const resumeRes = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'resume' }), resumeRes, CLAUDE_SID);
      expect(resumeRes.statusCode).toBe(200);
      expect(claudeService.sendPrompt).toHaveBeenCalledWith(CLAUDE_SID, expect.stringContaining('Continue working'), expect.anything(), expect.anything());

      claudeService.sendPrompt.mockClear();
      const pauseRes = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'pause' }), pauseRes, CLAUDE_SID);
      expect(pauseRes.statusCode).toBe(200);
      expect(claudeService.sendPrompt).not.toHaveBeenCalled();
      // Contract 1.27.0 (phase 4): the pause projection bridges to the browser
      // as extension-UI-grammar messages the client goal surface parses.
      const bridge = browserMessages.filter((m) => m.type === 'extension_status');
      expect(bridge.length).toBeGreaterThan(0);
      expect((bridge.at(-1) as any).status.key).toBe('goal-engine');
      expect((bridge.at(-1) as any).sessionId).toBe(CLAUDE_SID);
    });

    it('start dispatches /goal <condition> detached and returns the receipt handle', async () => {
      let releaseSend!: () => void;
      claudeService.sendPrompt.mockImplementation((_id: string, _m: string, _oe: unknown, onComplete: (e?: Error) => void) => {
        // Detached pipeline: do not complete — receipt stays running in background.
        void onComplete;
        releaseSend = () => onComplete();
      });
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'start', objective: 'make it so' }), res, CLAUDE_SID);
      expect(res.statusCode).toBe(200);
      expect(claudeService.sendPrompt).toHaveBeenCalledWith(CLAUDE_SID, '/goal make it so', expect.anything(), expect.anything());
      const body = JSON.parse(res.body);
      expect(body.accepted).toBe(true);
      expect(body.receipt.runId).toBeTypeOf('string');
      expect(body.note).toContain('detached');
      releaseSend?.();
    });

    it('accepts goal control for cli-direct backends (local CLI has native /goal) and refuses channel', async () => {
      registry.get.mockResolvedValue(entry({ id: CLAUDE_SID, sdkType: 'claude', cwd: CLAUDE_CWD, claudeSessionId: 'cs-uuid-1', claudeProfileBackend: 'cli-direct' }));
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'start', objective: 'x' }), res, CLAUDE_SID);
      expect(res.statusCode).toBe(200);

      registry.get.mockResolvedValue(entry({ id: CLAUDE_SID, sdkType: 'claude', cwd: CLAUDE_CWD, claudeSessionId: 'cs-uuid-1', claudeProfileBackend: 'channel' }));
      const channelRes = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'start', objective: 'x' }), channelRes, CLAUDE_SID);
      expect(channelRes.statusCode).toBe(400);
      expect(JSON.parse(channelRes.body).code).toBe('UNSUPPORTED_OPERATION');
    });
  });

  // ── Phase 3: Command Code goal read/control ───────────────────────────────

  describe('phase 3 — commandcode goal read/control', () => {
    const CC_SID = 'cmdc-session-1';
    let commandCodeService: any;
    let ccRecords: Map<string, Record<string, unknown>>;

    beforeEach(() => {
      ccRecords = new Map();
      const store = {
        get: vi.fn(async (id: string) => ccRecords.get(id) ?? null),
        arm: vi.fn(async (id: string, input: Record<string, unknown>) => {
          const rec = { status: 'running', ...input, autoContinue: input.autoContinue ?? true, startedAt: 1, updatedAt: 2 };
          ccRecords.set(id, rec);
          return rec;
        }),
        patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
          const rec = { ...(ccRecords.get(id) ?? {}), ...patch };
          ccRecords.set(id, rec);
          return rec;
        }),
      };
      commandCodeService = {
        findSession: vi.fn(async (id: string) => (id === CC_SID ? { sessionId: CC_SID, executionInstanceId: 'commandcode-default', modelSelector: 'meta/muse-spark-1.2-contributor', cwd: '/w', state: 'idle', messageCount: 0 } : null)),
        isGoalReady: vi.fn(() => true),
        goalStore: store,
        readGoalModState: vi.fn(async () => null),
        writeGoalControl: vi.fn(async () => true),
        isRunning: vi.fn(() => false),
        getSession: vi.fn(async () => ({ state: 'idle' })),
        sendPrompt: vi.fn(),
      };
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
        claudeSessionDir: path.join(dir, 'claude-sessions'),
        claudeProjectsDir: path.join(dir, '.claude', 'projects'),
        pinExpiryIntervalMs: 60_000,
        runReceiptManager: manager,
        commandCodeService,
      });
    });

    it('GET reports idle when no goal is armed and supported when the mod is provisioned', async () => {
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/g'), res, CC_SID);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ sessionId: CC_SID, runtime: 'commandcode', supported: true, status: 'idle' });
    });

    it('GET projects a completed mod state as achieved', async () => {
      commandCodeService.goalStore.get.mockResolvedValue({ objective: 'make x', status: 'running', maxTurns: 10, autoContinue: true });
      commandCodeService.readGoalModState.mockResolvedValue({ status: 'completed', turns: 3, completedAt: 123, verifications: [{ kind: 'self', ok: true, detail: 'done' }] });
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/g'), res, CC_SID);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ status: 'achieved', runs: 3 });
    });

    it('GET reports unsupported honestly when the goal mod is not provisioned', async () => {
      commandCodeService.isGoalReady.mockReturnValue(false);
      const res = mockRes();
      await routes.handleGetSessionGoal(jsonReq('GET', '/g'), res, CC_SID);
      expect(JSON.parse(res.body)).toMatchObject({ supported: false, status: 'unknown' });
    });

    it('start arms the goal and dispatches a detached run', async () => {
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'start', objective: 'make the thing', maxTurns: 20 }), res, CC_SID);
      expect(res.statusCode).toBe(200);
      expect(commandCodeService.goalStore.arm).toHaveBeenCalledWith(CC_SID, expect.objectContaining({ objective: 'make the thing', maxTurns: 20 }));
      expect(commandCodeService.sendPrompt).toHaveBeenCalled();
      const body = JSON.parse(res.body);
      expect(body.accepted).toBe(true);
    });

    it('pause writes the control signal and never dispatches; clear marks cleared', async () => {
      const pauseRes = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'pause' }), pauseRes, CC_SID);
      expect(pauseRes.statusCode).toBe(200);
      expect(commandCodeService.writeGoalControl).toHaveBeenCalledWith(CC_SID, 'pause');
      expect(commandCodeService.sendPrompt).not.toHaveBeenCalled();
      expect(JSON.parse(pauseRes.body).goal.status).toBe('paused');

      commandCodeService.goalStore.get.mockResolvedValue({ objective: 'g', status: 'cleared', clearedAt: 1, autoContinue: false });
      const clearRes = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'clear' }), clearRes, CC_SID);
      expect(commandCodeService.writeGoalControl).toHaveBeenCalledWith(CC_SID, 'clear');
      expect(JSON.parse(clearRes.body).goal.status).toBe('cleared');
    });

    it('rejects invalid bodies with 400', async () => {
      const res = mockRes();
      await routes.handleSessionGoalControl(jsonReq('POST', '/g', { action: 'start' }), res, CC_SID);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('INVALID_REQUEST');
    });
  });

  // ── Phase 5: create-with-goal + goal_end watch ─────────────────────────────

  describe('phase 5 — create-with-goal + watch', () => {
    it('POST /sessions with goal arms and dispatches the goal atomically (pi)', async () => {
      const prevHome = process.env.HOME;
      process.env.HOME = dir;
      try {
        const req = jsonReq('POST', '/api/v1/sessions', {
          runtime: 'pi', model: 'zai/glm-5.3', cwd: dir,
          goal: { objective: 'create the artifact', maxTurns: 5 },
        });
        const res = mockRes();
        await routes.handleCreateSession(req, res);
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.goal).toMatchObject({ armed: true });
        // Detached dispatch: the prompt lands shortly after the response.
        await vi.waitFor(() => expect(agentSession.prompt).toHaveBeenCalledWith('/goal "create the artifact" --max-turns 5'), { timeout: 2000 });
      } finally {
        process.env.HOME = prevHome;
      }
    });

    it('registers a goal_end watch (event_type condition accepts the synthetic event)', async () => {
      const res = mockRes();
      await routes.handleRegisterWatch(jsonReq('POST', '/api/v1/sessions/session-1/watch', {
        conditions: [{ type: 'event_type', eventType: 'goal_end' }],
      }), res, 'session-1');
      expect(res.statusCode).toBeLessThan(300);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('active');
    });
  });

  // ── Phase 1a: Pi slash commands on a busy session ─────────────────────────

  describe('phase 1a — slash-command busy exemption (POST /prompt)', () => {
    function makeBusy() {
      multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' });
    }

    it('dispatches a slash-command prompt on a BUSY pi session instead of refusing 409', async () => {
      makeBusy();
      const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/goal pause-now' });
      const res = mockRes();
      await routes.handleSendPrompt(req, res, 'session-1');

      expect(res.statusCode).toBe(200);
      expect(agentSession.prompt).toHaveBeenCalledWith('/goal pause-now');
      const body = JSON.parse(res.body);
      expect(body.turnComplete).toBe(true);
      // Receipt completes at the command boundary with the documented basis.
      const receipt = manager.get('run-1');
      expect(receipt?.status).toBe('completed');
      expect((receipt as any)?.cessation?.basis ?? (receipt as any)?.cessationBasis).toBe('documented_handler_return');
    });

    it('a foreign agent_end from the still-streaming turn does NOT complete the slash receipt early', async () => {
      makeBusy();
      let releasePrompt!: () => void;
      const gate = new Promise<void>((resolve) => { releasePrompt = resolve; });
      agentSession.prompt.mockImplementation(() => gate);

      const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/goal status' });
      const resPromise = (async () => {
        const res = mockRes();
        await routes.handleSendPrompt(req, res, 'session-1');
        return res;
      })();

      // Prompt call is registered and in flight
      await vi.waitFor(() => expect(agentSession.prompt).toHaveBeenCalled());
      // A prior turn ends while our slash command "runs"
      for (const observer of [...observers]) observer({ type: 'agent_end', sessionId: 'session-1', timestamp: Date.now(), data: {} });
      releasePrompt();

      const res = await resPromise;
      expect(res.statusCode).toBe(200);
      const receipt = manager.get('run-1');
      expect(receipt?.status).toBe('completed');
      expect((receipt as any)?.cessation?.basis ?? (receipt as any)?.cessationBasis).toBe('documented_handler_return');
    });

    it('still refuses 409 for NON-slash prompts on a busy pi session', async () => {
      makeBusy();
      const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: 'ordinary prompt' });
      const res = mockRes();
      await routes.handleSendPrompt(req, res, 'session-1');

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('SESSION_BUSY');
      expect(agentSession.prompt).not.toHaveBeenCalled();
    });

    it('the exemption is pi-only: busy claude session rejects slash commands with 409', async () => {
      multiSessionManager.getSessionStatus.mockReturnValue({ status: 'streaming' }); // not consulted for claude…
      claudeService.isRunning.mockReturnValue(true); // …this is the claude busy signal
      registry.get.mockResolvedValue(entry({ sdkType: 'claude' }));
      const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/compact' });
      const res = mockRes();
      await routes.handleSendPrompt(req, res, 'session-1');

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).code).toBe('SESSION_BUSY');
    });

    it('detached dispatch keeps the historical busy refusal even for slash messages', async () => {
      makeBusy();
      const req = jsonReq('POST', '/api/v1/sessions/session-1/prompt', { message: '/goal status', detach: true });
      const res = mockRes();
      await routes.handleSendPrompt(req, res, 'session-1');
      expect(res.statusCode).toBe(409);
    });
  });
});

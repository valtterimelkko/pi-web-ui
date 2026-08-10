import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { PassThrough, Writable } from 'stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { pushDiagnosticsRecord, clearDiagnosticsBuffer } from '../../../src/internal-api/diagnostics-buffer.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import type { RegistryEntry } from '../../../src/session-registry.js';
import type { LogRecord } from '../../../src/logging/logger.js';

function jsonReq(body: unknown): any {
  const req = new PassThrough();
  req.method = 'POST';
  req.url = '/api/v1/sessions/claude-control/prompt';
  req.headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { statusCode: number; body: string };
  res.statusCode = 200;
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString('utf8');
    return this;
  }) as any;
  res.setHeader = vi.fn();
  res.getHeader = vi.fn();
  res.on = vi.fn();
  return res;
}

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-07-18T12:00:00.000Z',
    level: 'info',
    component: 'Test',
    msg: 'session evidence log',
    ...over,
  };
}

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id: 'internal-pi-id',
    sdkType: 'pi',
    path: '/tmp/pi-session.jsonl',
    cwd: '/tmp/project',
    firstMessage: 'do not include this prompt in compact evidence',
    messageCount: 8,
    createdAt: '2026-07-18T11:00:00.000Z',
    lastActivity: '2026-07-18T12:00:00.000Z',
    status: 'idle',
    ...over,
  };
}

function buildRoutes(entries: RegistryEntry[], pinDir?: string) {
  const registry = {
    get: vi.fn(async (id: string) => entries.find((candidate) => candidate.id === id)),
    listAll: vi.fn(async () => entries),
    getByPath: vi.fn(async (path: string) => entries.find((candidate) => candidate.path === path)),
    upsert: vi.fn(),
    delete: vi.fn(),
  };
  const claudeService: any = {
    getReplayEvents: vi.fn().mockResolvedValue([]),
    loadSessionHistory: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getContextUsage: vi.fn().mockResolvedValue(null),
    getBackendMode: vi.fn().mockResolvedValue('sdk'),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
    sendPrompt: vi.fn(),
    hasSession: vi.fn(() => false),
  };
  const opencodeService: any = {
    getReplayEvents: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getContextUsage: vi.fn().mockReturnValue(null),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
    hasSession: vi.fn(() => false),
  };
  const antigravityService: any = {
    getReplayEvents: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getContextUsage: vi.fn().mockResolvedValue(null),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
    hasSession: vi.fn(() => false),
  };
  const multiSessionManager: any = {
    getAllSessionStatuses: vi.fn(() => []),
    getAgentSession: vi.fn(),
    isSessionPinned: vi.fn(() => false),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    prompt: vi.fn(),
    hasSession: vi.fn(() => true),
    pinSession: vi.fn(() => true),
    unpinSession: vi.fn(() => true),
  };
  const runReceipts = new RunReceiptManager({ store: new RunReceiptStore() });
  const routes = createSessionRoutes({
    claudeService,
    opencodeService,
    antigravityService,
    multiSessionManager,
    sessionRegistry: registry,
    piService: { setModel: vi.fn() } as any,
    internalClientId: 'evidence-test-client',
    watchDir: '/tmp/evidence-test-watch',
    runReceiptManager: runReceipts,
    pinDir,
  });
  return { routes, registry, claudeService, opencodeService, antigravityService, multiSessionManager, runReceipts };
}

async function callEvidence(routes: any, identifier: string, query = '') {
  const res = mockRes();
  await routes.handleGetSessionEvidence({} as never, res, identifier, new URLSearchParams(query));
  return res;
}

afterEach(() => clearDiagnosticsBuffer());

describe('GET /sessions/:id/evidence', () => {
  it.each([
    ['internal id', 'internal-pi-id'],
    ['registry path', '/tmp/pi-session.jsonl'],
  ])('resolves by %s and returns compact diagnostic-first evidence', async (_label, identifier) => {
    const { routes } = buildRoutes([entry()]);
    pushDiagnosticsRecord(record({
      sessionId: 'internal-pi-id',
      requestId: 'req-1',
      msg: 'a useful log line',
      phase7PolicyVersion: 'phase7-pi-shadow/v1',
      phase7Profile: 'heavy',
      phase7ReasonCodes: ['message_tool_signal'],
      phase7Affinity: 'session',
      phase7AffinitySessionId: 'internal-pi-id',
      phase7ResourceIdentity: 'shared-service',
      phase7ResourceBoundary: 'pi-control-process',
      phase7SessionScoped: false,
      phase7ToolEventCount: 8,
    }));

    const res = await callEvidence(routes, identifier);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe('internal-pi-id');
    expect(body.runtime).toBe('pi');
    expect(body.aliases).toMatchObject({ internalId: 'internal-pi-id', path: '/tmp/pi-session.jsonl' });
    expect(body.diagnostics.processLocal).toBe(true);
    expect(body.diagnostics.records).toHaveLength(1);
    expect(body.retention).toEqual({ durableLeaseCount: 0, residentLeaseCount: 0 });
    expect(body.residency).toMatchObject({ state: 'materialized' });
    expect(body.runChronology).toEqual([]);
    expect(body.diagnostics.records[0]).toMatchObject({
      requestId: 'req-1',
      msg: 'a useful log line',
      phase7PolicyVersion: 'phase7-pi-shadow/v1',
      phase7Profile: 'heavy',
      phase7ReasonCodes: ['message_tool_signal'],
      phase7Affinity: 'session',
      phase7AffinitySessionId: 'internal-pi-id',
      phase7ResourceIdentity: 'shared-service',
      phase7ResourceBoundary: 'pi-control-process',
      phase7SessionScoped: false,
      phase7ToolEventCount: 8,
    });
    expect(body).not.toHaveProperty('firstMessage');
    expect(body).not.toHaveProperty('screenView');
    expect(res.body).not.toContain('do not include this prompt');
    expect(Buffer.byteLength(res.body)).toBeLessThan(5_000);
  });

  it.each([
    ['Claude native id', entry({ id: 'claude-internal', sdkType: 'claude', path: '/tmp/claude-replay.jsonl', claudeSessionId: 'claude-native' }), 'claude-native'],
    ['OpenCode native id', entry({ id: 'opencode-internal', sdkType: 'opencode', path: 'opencode-internal', opencodeSessionId: 'ses_native' }), 'ses_native'],
    ['Antigravity conversation id', entry({ id: 'agy-internal', sdkType: 'antigravity', path: 'agy-internal', antigravityConversationId: 'agy-conversation' }), 'agy-conversation'],
  ])('resolves by %s', async (_label, candidate, identifier) => {
    const { routes } = buildRoutes([candidate]);
    const res = await callEvidence(routes, identifier);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sessionId).toBe(candidate.id);
  });

  it('returns bounded opt-in expansions without mutating the session', async () => {
    const { routes, registry, claudeService, multiSessionManager, runReceipts } = buildRoutes([
      entry({ id: 'claude-internal', sdkType: 'claude', path: '/tmp/claude-replay.jsonl', claudeSessionId: 'claude-native' }),
    ]);
    pushDiagnosticsRecord(record({ sessionId: 'claude-internal', level: 'error', msg: 'failure details' }));
    await runReceipts.beginRun({
      sessionId: 'claude-internal',
      runtime: 'claude',
      executionInstanceId: 'claude-default',
      model: 'sonnet',
      message: 'hidden prompt',
      mode: 'prompt',
      verbosity: 'answers',
      detach: false,
    });

    const res = await callEvidence(routes, 'claude-native', 'expand=diagnostics,transcript,screen,runs&limit=20');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.diagnostics.expanded).toBe(true);
    expect(body.transcript).toMatchObject({ scope: 'visible_recent' });
    expect(body.screen).toMatchObject({ view: 'screen' });
    expect(body.runReceipts).toHaveLength(1);
    expect(body.runChronology).toHaveLength(1);
    expect(body.runChronology[0]).toMatchObject({ runId: expect.any(String), status: 'accepted' });
    expect(body.runChronology[0]).not.toHaveProperty('sessionId');
    expect(body.receiptSummary).toMatchObject({ durable: true, count: 1 });
    expect(res.body).not.toContain('hidden prompt');
    expect(registry.upsert).not.toHaveBeenCalled();
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(multiSessionManager.prompt).not.toHaveBeenCalled();
  });

  it('projects active durable/resident retention separately from adapter residency', async () => {
    const pinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-evidence-retention-'));
    try {
      const { routes } = buildRoutes([entry()], pinDir);
      await routes.ready;
      const durableRes = mockRes();
      await routes.handleSessionControl(jsonReq({
        action: 'acquire_retention',
        retention: { mode: 'durable', ownerId: 'evidence-test', ttlSeconds: 60 },
      }), durableRes, 'internal-pi-id');
      expect(durableRes.statusCode).toBe(200);
      const residentRes = mockRes();
      await routes.handleSessionControl(jsonReq({
        action: 'acquire_retention',
        retention: { mode: 'resident', ownerId: 'evidence-test', ttlSeconds: 120 },
      }), residentRes, 'internal-pi-id');
      expect(residentRes.statusCode).toBe(200);

      const evidenceRes = await callEvidence(routes, 'internal-pi-id');
      const body = JSON.parse(evidenceRes.body);
      expect(body.retention).toMatchObject({ durableLeaseCount: 1, residentLeaseCount: 1 });
      expect(body.retention.latestExpiryAt).toEqual(expect.any(String));
      expect(body.residency).toMatchObject({ state: 'materialized' });
      expect(body.retention).not.toHaveProperty('ownerId');
      await routes.shutdown();
    } finally {
      await fs.rm(pinDir, { recursive: true, force: true });
    }
  });

  it('24/25. includes AskUserQuestion request and closure control evidence with both identifiers and reason', async () => {
    const candidate = entry({ id: 'claude-control', sdkType: 'claude', path: '/tmp/claude-control.jsonl' });
    const { routes, claudeService } = buildRoutes([candidate]);
    claudeService.sendPrompt.mockImplementation(async (_sid: string, _msg: string, onEvent: (event: any) => void, onComplete: () => void) => {
      onEvent({
        type: 'ask_user_question_request', sessionId: 'claude-control', timestamp: 100,
        data: { requestId: 'req-control', toolCallId: 'toolu-control', questions: [{ question: 'Choose?' }] },
      });
      onEvent({
        type: 'ask_user_question_closed', sessionId: 'claude-control', timestamp: 200,
        data: { requestId: 'req-control', toolCallId: 'toolu-control', reason: 'answered' },
      });
      onEvent({ type: 'agent_end', sessionId: 'claude-control', timestamp: 300, data: {} });
      onComplete();
    });
    const promptRes = mockRes();
    await routes.handleSendPrompt(jsonReq({ message: 'ask', mode: 'prompt' }), promptRes, 'claude-control');

    const evidenceRes = await callEvidence(routes, 'claude-control');
    expect(JSON.parse(evidenceRes.body).control.askUserQuestions).toEqual([
      expect.objectContaining({ type: 'request', requestId: 'req-control', toolCallId: 'toolu-control' }),
      expect.objectContaining({ type: 'closed', requestId: 'req-control', toolCallId: 'toolu-control', reason: 'answered' }),
    ]);
  });

  it('bridges legacy path-correlated records while returning canonical evidence', async () => {
    const { routes } = buildRoutes([entry()]);
    pushDiagnosticsRecord(record({ sessionId: '/tmp/pi-session.jsonl', requestId: 'legacy-req', msg: 'legacy path record' }));

    const res = await callEvidence(routes, 'internal-pi-id');
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe('internal-pi-id');
    expect(body.diagnostics.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'legacy-req', msg: 'legacy path record' }),
    ]));
  });

  it('keeps the default bundle bounded when the diagnostics ring is noisy', async () => {
    const { routes } = buildRoutes([entry()]);
    for (let index = 0; index < 100; index += 1) {
      pushDiagnosticsRecord(record({ sessionId: 'internal-pi-id', requestId: `req-${index}`, msg: 'x'.repeat(2_000) }));
    }

    const res = await callEvidence(routes, 'internal-pi-id');
    const body = JSON.parse(res.body);
    expect(body.diagnostics.records.length).toBeLessThanOrEqual(12);
    expect(Buffer.byteLength(res.body)).toBeLessThan(5_000);
  });

  it('keeps the noisy default bundle below its bound with three liveness-rich receipts', async () => {
    const { routes, runReceipts } = buildRoutes([entry()]);
    for (let index = 0; index < 100; index += 1) {
      pushDiagnosticsRecord(record({ sessionId: 'internal-pi-id', requestId: `receipt-req-${index}`, msg: 'x'.repeat(2_000) }));
    }
    for (let index = 0; index < 3; index += 1) {
      const run = await runReceipts.beginRun({
        sessionId: 'internal-pi-id',
        runtime: 'pi',
        executionInstanceId: 'pi-local-default',
        message: `hidden-${index}`,
        mode: 'prompt',
        verbosity: 'answers',
        detach: false,
      });
      await runReceipts.markStarted(run.receipt.runId);
      await runReceipts.observeEvent(run.receipt.runId, {
        type: 'agent_end', sessionId: 'internal-pi-id', timestamp: Date.now() + index, data: {},
      });
      await runReceipts.finish(run.receipt.runId);
    }

    const res = await callEvidence(routes, 'internal-pi-id');
    const body = JSON.parse(res.body);
    expect(body.runChronology).toHaveLength(3);
    expect(body.runChronology[0].outputEvidence).toEqual({ disposition: 'no-text' });
    expect(Buffer.byteLength(res.body)).toBeLessThan(5_000);
    expect(res.body).not.toContain('hidden-');
  });

  it('returns a stable not-found error for an unknown identifier', async () => {
    const { routes } = buildRoutes([entry()]);
    const res = await callEvidence(routes, 'missing-session');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('SESSION_NOT_FOUND');
  });
});

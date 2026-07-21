import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { Writable } from 'stream';
import { createSessionRoutes } from '../../../src/internal-api/routes/sessions.js';
import { pushDiagnosticsRecord, clearDiagnosticsBuffer } from '../../../src/internal-api/diagnostics-buffer.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import type { RegistryEntry } from '../../../src/session-registry.js';
import type { LogRecord } from '../../../src/logging/logger.js';

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

function buildRoutes(entries: RegistryEntry[]) {
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
  };
  const opencodeService: any = {
    getReplayEvents: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getContextUsage: vi.fn().mockReturnValue(null),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  const antigravityService: any = {
    getReplayEvents: vi.fn().mockResolvedValue([]),
    getSessionStats: vi.fn().mockResolvedValue(null),
    getContextUsage: vi.fn().mockResolvedValue(null),
    isRunning: vi.fn(() => false),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  const multiSessionManager: any = {
    getAllSessionStatuses: vi.fn(() => []),
    getAgentSession: vi.fn(),
    isSessionPinned: vi.fn(() => false),
    addApiObserver: vi.fn(),
    removeApiObserver: vi.fn(),
    prompt: vi.fn(),
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
    pushDiagnosticsRecord(record({ sessionId: 'internal-pi-id', requestId: 'req-1', msg: 'a useful log line' }));

    const res = await callEvidence(routes, identifier);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe('internal-pi-id');
    expect(body.runtime).toBe('pi');
    expect(body.aliases).toMatchObject({ internalId: 'internal-pi-id', path: '/tmp/pi-session.jsonl' });
    expect(body.diagnostics.processLocal).toBe(true);
    expect(body.diagnostics.records).toHaveLength(1);
    expect(body.diagnostics.records[0]).toMatchObject({ requestId: 'req-1', msg: 'a useful log line' });
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
    expect(body.receiptSummary).toMatchObject({ durable: true, count: 1 });
    expect(res.body).not.toContain('hidden prompt');
    expect(registry.upsert).not.toHaveBeenCalled();
    expect(claudeService.sendPrompt).not.toHaveBeenCalled();
    expect(multiSessionManager.prompt).not.toHaveBeenCalled();
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

  it('returns a stable not-found error for an unknown identifier', async () => {
    const { routes } = buildRoutes([entry()]);
    const res = await callEvidence(routes, 'missing-session');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('SESSION_NOT_FOUND');
  });
});

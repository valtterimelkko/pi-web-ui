import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDiagnosticsRoutes } from '../../../src/internal-api/routes/diagnostics.js';
import {
  pushDiagnosticsRecord,
  clearDiagnosticsBuffer,
  getRecentLogs,
} from '../../../src/internal-api/diagnostics-buffer.js';
import type { LogRecord } from '../../../src/logging/logger.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistryManager } from '../../../src/session-registry.js';

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const r = { statusCode: 0, body: '' } as unknown as ServerResponse & { statusCode: number; body: string };
  (r as Record<string, unknown>).writeHead = (code: number) => {
    r.statusCode = code;
    return r;
  };
  (r as Record<string, unknown>).end = (data?: string) => {
    r.body = typeof data === 'string' ? data : '';
    return r;
  };
  return r;
}

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return { ts: '2026-06-23T12:00:00.000Z', level: 'info', component: 'Test', msg: 'x', ...over };
}

describe('diagnostics routes (Task 10)', () => {
  beforeEach(() => clearDiagnosticsBuffer());

  it('bounds the actual HTTP response without altering retained records or matching counts', async () => {
    for (let index = 0; index < 1000; index++) pushDiagnosticsRecord(rec({ level: 'error', msg: 'x'.repeat(3000), requestId: `r-${index}` }));
    const retained = getRecentLogs({ limit: 1000 }).length;
    const routes = createDiagnosticsRoutes();
    const server = createServer((req, res) => { void routes.handleGetDiagnostics(req, res, new URLSearchParams('limit=1000')); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/diagnostics`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024);
      const body = JSON.parse(text);
      expect(body.summary.bufferedRecords).toBe(retained);
      expect(body.responseTruncation.omittedLogs + body.recentLogs.length).toBe(retained);
      expect(body.responseTruncation.omittedErrors + body.recentErrors.length).toBe(retained);
      expect(body.recentErrors.length).toBeGreaterThan(0);
      expect(getRecentLogs({ limit: 1000 })).toHaveLength(retained);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('reports registry unavailability instead of healthy empty session counts', async () => {
    const routes = createDiagnosticsRoutes({ sessionRegistry: { listAll: async () => { throw new Error('synthetic inaccessible registry'); } } });
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams());
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.sources.registry.state).toBe('unavailable');
    expect(body.operational?.sessions).toBeUndefined();
    expect(res.body).not.toContain('synthetic inaccessible registry');
  });

  it('recovers HTTP diagnostics after repairing the same corrupt on-disk registry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'diagnostics-recovery-'));
    const file = join(directory, 'registry.json');
    const corrupt = '{broken registry';
    await writeFile(file, corrupt);
    const registry = new SessionRegistryManager(file);
    const routes = createDiagnosticsRoutes({ sessionRegistry: registry });
    const server = createServer((req, res) => { void routes.handleGetDiagnostics(req, res, new URLSearchParams()); });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/diagnostics`;
      const unavailable = await fetch(url);
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ code: 'DIAGNOSTIC_SOURCE_UNAVAILABLE', sources: { registry: { state: 'unavailable' } } });
      expect(await readFile(file, 'utf8')).toBe(corrupt);
      const now = new Date().toISOString();
      await writeFile(file, JSON.stringify({ version: 1, updatedAt: now, entries: [{
        id: 'repaired-fixture', sdkType: 'pi', path: '/synthetic/session.jsonl', cwd: '/synthetic',
        firstMessage: 'fixture', messageCount: 0, status: 'idle', createdAt: now, lastActivity: now,
      }] }));
      const recovered = await fetch(url);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ operational: { sessions: { total: 1, byRuntime: { pi: 1 } } } });
      expect(registry.getLoadStatus()).toEqual({ state: 'available', source: 'disk' });
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses one registry/visibility snapshot per global response', async () => {
    const listAll = vi.fn(async () => [{ id: 'visible', sdkType: 'pi', status: 'idle' }]);
    const isVisibleSession = vi.fn(async () => true);
    const routes = createDiagnosticsRoutes({ sessionRegistry: { listAll }, isVisibleSession });
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams());
    expect(res.statusCode).toBe(200);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(isVisibleSession).toHaveBeenCalledTimes(1);
  });

  it('GET /diagnostics returns recentLogs + recentErrors + summary', async () => {
    pushDiagnosticsRecord(rec({ msg: 'one' }));
    pushDiagnosticsRecord(rec({ level: 'error', msg: 'boom' }));
    const routes = createDiagnosticsRoutes();
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.recentLogs)).toBe(true);
    expect(body.recentLogs.map((l: LogRecord) => l.msg)).toContain('one');
    expect(body.recentErrors.map((l: LogRecord) => l.msg)).toEqual(['boom']);
    expect(body.summary.bufferedRecords).toBe(2);
    expect(body.summary.errorCount).toBe(1);
  });

  it('includes a privacy-safe bounded operational snapshot', async () => {
    const metrics = new OperationalMetrics({ now: () => Date.parse('2026-07-17T11:00:00.000Z') });
    metrics.recordTurnAccepted('pi');
    metrics.recordAdapterDrop('claude', 'invalid_json');
    const routes = createDiagnosticsRoutes({
      metrics,
      sessionRegistry: {
        listAll: async () => [
          { id: 'secret-session', sdkType: 'pi', status: 'running', path: '/private/path' },
          { id: 'secret-session-2', sdkType: 'claude', status: 'idle', path: '/other/private/path' },
        ],
      },
      workerSummary: () => ({
        pool: { active: 1, idle: 0, total: 1, maxWorkers: 15 },
        crashes: { total: 2, crashesLastHour: 1, byType: { crashed: 2 } },
      }),
    });
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams());
    const body = JSON.parse(res.body);

    expect(body.operational).toMatchObject({
      turns: { pi: { accepted: 1 } },
      pipeline: { adapterDrops: { claude: { invalid_json: 1 } } },
      sessions: {
        total: 2,
        byRuntime: { pi: 1, claude: 1, opencode: 0, antigravity: 0 },
        byStatus: { running: 1, idle: 1, error: 0 },
      },
      workers: { pool: { active: 1 }, crashes: { total: 2 } },
    });
    expect(res.body).not.toContain('secret-session');
    expect(res.body).not.toContain('/private/path');
  });

  it('excludes Command Code browser sessions from operational counts, logs, and session diagnostics', async () => {
    pushDiagnosticsRecord(rec({ msg: 'shadow evidence', runtime: 'commandcode', sessionId: 'shadow' }));
    pushDiagnosticsRecord(rec({ msg: 'browser evidence', runtime: 'commandcode', sessionId: 'browser' }));
    pushDiagnosticsRecord(rec({ msg: 'unscoped commandcode evidence', runtime: 'commandcode' }));
    pushDiagnosticsRecord(rec({ msg: 'browser correlation leak', sessionId: 'browser' }));
    pushDiagnosticsRecord(rec({ msg: 'shadow correlation without runtime', sessionId: 'shadow' }));
    const routes = createDiagnosticsRoutes({
      sessionRegistry: { listAll: async () => [
        { id: 'shadow', sdkType: 'commandcode', status: 'idle' },
        { id: 'browser', sdkType: 'commandcode', status: 'running' },
      ] },
      isVisibleSession: async (id) => id === 'shadow',
    });
    const global = mockRes();
    await routes.handleGetDiagnostics({} as never, global, new URLSearchParams());
    const globalBody = JSON.parse(global.body);
    expect(globalBody.operational.sessions).toMatchObject({ total: 1, byRuntime: { commandcode: 1 } });
    expect(globalBody.recentLogs.map((log: LogRecord) => log.msg)).toEqual(['shadow evidence', 'shadow correlation without runtime']);
    expect(globalBody.summary).toMatchObject({ bufferedRecords: 2 });
    expect(globalBody.recentLogs).not.toContainEqual(expect.objectContaining({ msg: 'browser correlation leak' }));
    const hidden = mockRes();
    await routes.handleGetSessionDiagnostics({} as never, hidden, 'browser', new URLSearchParams());
    expect(hidden.statusCode).toBe(404);
  });

  it('GET /sessions/:id/diagnostics scopes logs to that session', async () => {
    pushDiagnosticsRecord(rec({ msg: 'a', sessionId: 'sess-1' }));
    pushDiagnosticsRecord(rec({ msg: 'b', sessionId: 'sess-2' }));
    pushDiagnosticsRecord(rec({ msg: 'c', sessionId: 'sess-1' }));
    const routes = createDiagnosticsRoutes();
    const res = mockRes();
    await routes.handleGetSessionDiagnostics({} as never, res, 'sess-1', new URLSearchParams());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe('sess-1');
    expect(body.recentLogs.map((l: LogRecord) => l.msg)).toEqual(['a', 'c']);
  });

  it('honours limit and structured filter query params', async () => {
    pushDiagnosticsRecord(rec({
      ts: '2026-06-23T11:59:59.000Z',
      level: 'error', msg: 'old', requestId: 'req-1', runId: 'run-1', component: 'Target', runtime: 'pi',
    }));
    pushDiagnosticsRecord(rec({
      ts: '2026-06-23T12:00:01.000Z',
      level: 'error', msg: 'match', requestId: 'req-1', runId: 'run-1', component: 'Target', runtime: 'pi',
    }));
    pushDiagnosticsRecord(rec({
      ts: '2026-06-23T12:00:02.000Z',
      level: 'error', msg: 'wrong-run', requestId: 'req-1', runId: 'run-2', component: 'Target', runtime: 'pi',
    }));
    const routes = createDiagnosticsRoutes();
    const res = mockRes();
    await routes.handleGetDiagnostics(
      {} as never,
      res,
      new URLSearchParams('limit=3&requestId=req-1&runId=run-1&component=Target&runtime=pi&since=2026-06-23T12%3A00%3A00.000Z'),
    );
    const body = JSON.parse(res.body);
    expect(body.recentLogs.map((l: LogRecord) => l.msg)).toEqual(['match']);
    expect(body.recentErrors.map((l: LogRecord) => l.msg)).toEqual(['match']);
    expect(body.summary).toMatchObject({ bufferedRecords: 1, errorCount: 1, warnCount: 0 });
  });

  it('diagnostics responses never leak secrets', async () => {
    pushDiagnosticsRecord(rec({ msg: 'Authorization: Bearer leak-tok-1234567890', apiKey: 'sk-proj-1234567890abcdef' } as unknown as LogRecord));
    const routes = createDiagnosticsRoutes();
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams());
    expect(res.body).not.toContain('leak-tok-1234567890');
    expect(res.body).not.toContain('sk-proj-1234567890abcdef');
  });
});

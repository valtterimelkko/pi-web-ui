import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerResponse } from 'http';
import { createDiagnosticsRoutes } from '../../../src/internal-api/routes/diagnostics.js';
import {
  pushDiagnosticsRecord,
  clearDiagnosticsBuffer,
} from '../../../src/internal-api/diagnostics-buffer.js';
import type { LogRecord } from '../../../src/logging/logger.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

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

import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerResponse } from 'http';
import { createDiagnosticsRoutes } from '../../../src/internal-api/routes/diagnostics.js';
import {
  pushDiagnosticsRecord,
  clearDiagnosticsBuffer,
} from '../../../src/internal-api/diagnostics-buffer.js';
import type { LogRecord } from '../../../src/logging/logger.js';

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

  it('honours limit query param', async () => {
    for (let i = 0; i < 10; i++) pushDiagnosticsRecord(rec({ msg: `m${i}` }));
    const routes = createDiagnosticsRoutes();
    const res = mockRes();
    await routes.handleGetDiagnostics({} as never, res, new URLSearchParams('limit=3'));
    const body = JSON.parse(res.body);
    expect(body.recentLogs).toHaveLength(3);
    expect(body.recentLogs.map((l: LogRecord) => l.msg)).toEqual(['m7', 'm8', 'm9']);
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

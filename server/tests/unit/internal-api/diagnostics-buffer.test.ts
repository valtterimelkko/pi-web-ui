import { describe, it, expect, beforeEach } from 'vitest';
import type { LogRecord } from '../../../src/logging/logger.js';
import {
  pushDiagnosticsRecord,
  getRecentLogs,
  getRecentErrors,
  getDiagnosticsSummary,
  scrubRecord,
  clearDiagnosticsBuffer,
} from '../../../src/internal-api/diagnostics-buffer.js';

function rec(over: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: '2026-06-23T12:00:00.000Z',
    level: 'info',
    component: 'Test',
    msg: 'hello',
    ...over,
  };
}

describe('diagnostics ring buffer — secret scrubbing (Task 10)', () => {
  it('redacts values of sensitive keys', () => {
    const out = scrubRecord(rec({ msg: 'x', password: 'hunter2', api_key: 'k123', Authorization: 'Bearer abc' } as unknown as LogRecord));
    expect((out as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((out as Record<string, unknown>).api_key).toBe('[REDACTED]');
    expect((out as Record<string, unknown>).Authorization).toBe('[REDACTED]');
  });

  it('redacts bearer tokens and sk- keys inside message strings', () => {
    const out = scrubRecord(rec({ msg: 'got Authorization: Bearer abc.def-ghi_SK and key sk-proj-1234567890abcdef' }));
    expect((out.msg as string)).not.toContain('abc.def-ghi_SK');
    expect((out.msg as string)).not.toContain('sk-proj-1234567890abcdef');
    expect((out.msg as string)).toContain('[REDACTED]');
  });

  it('does NOT redact normal ids (requestId / sessionId)', () => {
    const out = scrubRecord(rec({ msg: 'turn for session', requestId: 'req_abc-123', sessionId: '019ef4fd-a7df-7615-9e4a-bcafb5257de8' }));
    expect(out.requestId).toBe('req_abc-123');
    expect(out.sessionId).toBe('019ef4fd-a7df-7615-9e4a-bcafb5257de8');
  });
});

describe('diagnostics ring buffer — capture & query (Task 10)', () => {
  beforeEach(() => clearDiagnosticsBuffer());

  it('captures and returns recent records', () => {
    pushDiagnosticsRecord(rec({ msg: 'a' }));
    pushDiagnosticsRecord(rec({ msg: 'b' }));
    const logs = getRecentLogs();
    expect(logs.map((l) => l.msg)).toEqual(['a', 'b']);
  });

  it('caps the buffer size (ring)', () => {
    for (let i = 0; i < 1500; i++) pushDiagnosticsRecord(rec({ msg: `m${i}` }));
    const summary = getDiagnosticsSummary();
    expect(summary.bufferedRecords).toBeLessThanOrEqual(1000);
    const logs = getRecentLogs({ limit: 1000 });
    expect(logs[0].msg).toBe('m500'); // oldest kept after overflow
    expect(logs[logs.length - 1].msg).toBe('m1499');
  });

  it('filters by sessionId', () => {
    pushDiagnosticsRecord(rec({ msg: 'for-a', sessionId: 'a' }));
    pushDiagnosticsRecord(rec({ msg: 'for-b', sessionId: 'b' }));
    pushDiagnosticsRecord(rec({ msg: 'for-a2', sessionId: 'a' }));
    expect(getRecentLogs({ sessionId: 'a' }).map((l) => l.msg)).toEqual(['for-a', 'for-a2']);
  });

  it('filters by minimum level', () => {
    pushDiagnosticsRecord(rec({ level: 'debug', msg: 'd' }));
    pushDiagnosticsRecord(rec({ level: 'info', msg: 'i' }));
    pushDiagnosticsRecord(rec({ level: 'warn', msg: 'w' }));
    pushDiagnosticsRecord(rec({ level: 'error', msg: 'e' }));
    const atWarn = getRecentLogs({ minLevel: 'warn' }).map((l) => l.level);
    expect(atWarn.sort()).toEqual(['error', 'warn']);
  });

  it('returns recent errors only', () => {
    pushDiagnosticsRecord(rec({ level: 'info', msg: 'i' }));
    pushDiagnosticsRecord(rec({ level: 'error', msg: 'e1' }));
    pushDiagnosticsRecord(rec({ level: 'error', msg: 'e2' }));
    expect(getRecentErrors().map((l) => l.msg)).toEqual(['e1', 'e2']);
  });

  it('summary reports counts and bounds', () => {
    pushDiagnosticsRecord(rec({ level: 'info', msg: 'i' }));
    pushDiagnosticsRecord(rec({ level: 'error', msg: 'e' }));
    const s = getDiagnosticsSummary();
    expect(s.bufferedRecords).toBe(2);
    expect(s.errorCount).toBe(1);
    expect(s.oldestTs).toBeDefined();
    expect(s.newestTs).toBeDefined();
  });

  it('stored records are already scrubbed (no secrets leak from the buffer)', () => {
    pushDiagnosticsRecord(rec({ msg: 'token was Bearer s3cr3t.tok', apiKey: 'sk-proj-1234567890abcdef' } as unknown as LogRecord));
    const [stored] = getRecentLogs();
    expect(stored.msg).not.toContain('s3cr3t.tok');
    expect(JSON.stringify(stored)).not.toContain('sk-proj-1234567890abcdef');
    expect((stored as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });
});

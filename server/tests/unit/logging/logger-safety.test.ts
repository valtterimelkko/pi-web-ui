import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SessionWorker } from '../../../src/workers/session-worker.js';
import { createLogger, setLogTap, type LogRecord } from '../../../src/logging/logger.js';
import { withCorrelation } from '../../../src/logging/correlation.js';
import { clearDiagnosticsBuffer, getRecentLogs, pushDiagnosticsRecord, getDiagnosticsSummary } from '../../../src/internal-api/diagnostics-buffer.js';

beforeEach(() => { clearDiagnosticsBuffer(); setLogTap(pushDiagnosticsRecord); });
afterEach(() => { setLogTap(null); clearDiagnosticsBuffer(); });

describe('one bounded safe logging projection for both sinks', () => {
  it.each(['pretty', 'json'] as const)('redacts message, nested fields, URLs and errors from %s output and diagnostics', format => {
    const lines: string[] = [];
    const logger = createLogger('Safety', { format, sink: line => lines.push(line), boundContext: { requestId: 'req-safe', nested: { password: 'SYNTHETIC_NESTED' } } });
    logger.errorObject('token=SYNTHETIC_MESSAGE https://fixture/?api_key=SYNTHETIC_URL', new Error('Bearer SYNTHETIC_ERROR'));
    const both = lines.join('\n') + JSON.stringify(getRecentLogs());
    for (const value of ['SYNTHETIC_NESTED', 'SYNTHETIC_MESSAGE', 'SYNTHETIC_URL', 'SYNTHETIC_ERROR']) expect(both).not.toContain(value);
    expect(both).toContain('req-safe');
    expect(both).toContain('[REDACTED]');
  });
  it('bounds oversized multibyte data before sinks and handles cycles/getters without invoking them', () => {
    const lines: string[] = [];
    const cyclic: Record<string, unknown> = { huge: '界'.repeat(400_000) };
    cyclic.self = cyclic;
    let getterReads = 0;
    Object.defineProperty(cyclic, 'dangerous', { enumerable: true, get() { getterReads++; throw new Error('must not read getter'); } });
    const logger = createLogger('Safety', { format: 'json', sink: line => lines.push(line), boundContext: cyclic });
    expect(() => logger.info('safe message')).not.toThrow();
    expect(getterReads).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(getRecentLogs()[0]))).toBeLessThanOrEqual(8192);
    expect(lines[0]).toMatch(/TRUNCATED|CIRCULAR|UNREADABLE/);
  });
  it.each(['pretty', 'json'] as const)('redacts credentials assembled by format arguments in %s output', format => {
    const lines: string[] = [];
    const logger = createLogger('Safety', { format, sink: line => lines.push(line) });
    logger.info('token=%s', 'SYNTHETIC_FORMAT_SECRET');
    expect(lines.join('')).not.toContain('SYNTHETIC_FORMAT_SECRET');
    expect(JSON.stringify(getRecentLogs())).not.toContain('SYNTHETIC_FORMAT_SECRET');
  });

  it('never exposes a secret prefix at an oversized-string boundary', () => {
    const lines: string[] = [];
    const logger = createLogger('Safety', { format: 'pretty', sink: line => lines.push(line) });
    logger.info('token=' + 'SYNTHETIC_BOUNDARY_SECRET'.repeat(1000));
    expect(lines.join('')).not.toContain('SYNTHETIC_BOUNDARY');
    expect(Buffer.byteLength(lines.join(''))).toBeLessThanOrEqual(8192);
  });
  it('redacts through the actual SessionWorker stderr forwarding consumer', () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const worker = new SessionWorker({ sessionPath: '/fixture/session.jsonl' });
    const seam = worker as unknown as { state: { process: typeof proc; pid: number }; attachProcessHandlers(): void };
    seam.state.process = proc;
    seam.state.pid = 4242;
    seam.attachProcessHandlers();
    const lines: string[] = [];
    vi.stubEnv('VITEST_LOG', '1');
    const sink = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { lines.push(String(chunk)); return true; });
    try {
      proc.stderr.write(Buffer.from('token=SYNTHETIC_WORKER_SECRET'));
      expect(lines.join('')).toContain('stderr:');
      expect(lines.join('')).not.toContain('SYNTHETIC_WORKER_SECRET');
      expect(JSON.stringify(getRecentLogs())).not.toContain('SYNTHETIC_WORKER_SECRET');
      expect(getRecentLogs()[0].component).toBe('SessionWorker');
    } finally {
      sink.mockRestore(); vi.unstubAllEnvs();
      proc.stdout.destroy(); proc.stderr.destroy(); proc.removeAllListeners();
    }
  });

  it('counts a throwing diagnostic tap while preserving normal sink output', () => {
    const lines: string[] = [];
    const before = (getDiagnosticsSummary().retention as unknown as { tapFailures?: number }).tapFailures ?? 0;
    setLogTap(() => { throw new Error('synthetic tap failure'); });
    const logger = createLogger('Safety', { format: 'json', sink: line => lines.push(line) });
    expect(() => logger.error('still observable')).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(getDiagnosticsSummary().retention).toMatchObject({ tapFailures: before + 1 });
  });

  it('bounds direct diagnostic insertion even when the caller bypasses the logger', () => {
    const record: LogRecord = { ts: new Date(0).toISOString(), level: 'info', component: 'fixture', msg: 'x'.repeat(1_000_000) };
    pushDiagnosticsRecord(record);
    expect(Buffer.byteLength(JSON.stringify(getRecentLogs()[0]))).toBeLessThanOrEqual(8192);
    expect(getRecentLogs()[0].msg).toContain('TRUNCATED');
  });

  it('redacts credential payload suffixes without redacting numeric usage counters', () => {
    const lines: string[] = [];
    const tapped: LogRecord[] = [];
    setLogTap(record => tapped.push(record));
    const logger = createLogger('Safety', {
      format: 'json',
      sink: line => lines.push(line),
      boundContext: {
        tokenValue: 'SYNTH_TOKEN_VALUE',
        secretValue: 'SYNTH_SECRET_VALUE',
        cookieHeader: 'SYNTH_COOKIE_HEADER',
        systemPromptText: 'SYNTH_SYSTEM_PROMPT',
        tokenCount: 12,
        promptTokens: 34,
        inputTokens: 56,
        outputTokens: 78,
      },
    });
    logger.info('safe');

    const output = JSON.parse(lines[0]) as Record<string, unknown>;
    for (const key of ['tokenValue', 'secretValue', 'cookieHeader', 'systemPromptText']) {
      expect(output[key]).toBe('[REDACTED]');
    }
    for (const key of ['tokenCount', 'promptTokens', 'inputTokens', 'outputTokens']) {
      expect(output[key]).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(tapped)).not.toContain('SYNTH_');
  });

  it.each(['pretty', 'json'] as const)('drops non-string correlation values with loss metadata in %s output', format => {
    const lines: string[] = [];
    const tapped: LogRecord[] = [];
    setLogTap(record => tapped.push(record));
    const logger = createLogger('Safety', { format, sink: line => lines.push(line) });
    const invalidObject = Object.create(null) as unknown as string;
    expect(() => withCorrelation({ requestId: invalidObject, runId: 'run-valid', sessionId: 42 as unknown as string }, () => {
      logger.info('safe');
    })).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('run-valid');
    expect(lines[0]).not.toContain('[object Object]');
    expect(tapped[0].requestId).toBeUndefined();
    expect(tapped[0].sessionId).toBeUndefined();
    expect(tapped[0].runId).toBe('run-valid');
    expect((tapped[0].logSafety as { droppedFields: string[] }).droppedFields)
      .toEqual(expect.arrayContaining(['requestId', 'sessionId']));
    if (format === 'json') expect(JSON.parse(lines[0]).logSafety.droppedFields).toEqual(expect.arrayContaining(['requestId', 'sessionId']));
  });

  it('preserves inherited Error subclass names without invoking error accessors', () => {
    const lines: string[] = [];
    let getterReads = 0;
    const error = new TypeError('SYNTH_TYPE_ERROR');
    Object.defineProperty(error, 'message', {
      configurable: true,
      get() { getterReads++; return 'SYNTH_GETTER_MESSAGE'; },
    });
    const logger = createLogger('Safety', { format: 'json', sink: line => lines.push(line) });
    logger.errorObject('operation failed', error);

    const output = JSON.parse(lines[0]) as { error: { name: string; message: string; stack?: string } };
    expect(output.error.name).toBe('TypeError');
    expect(output.error.message).toBe('[UNREADABLE]');
    // V8 may build a lazy stack by reading message; it must not invoke the
    // overridden accessor merely to preserve a stack string.
    expect(output.error.stack).toBe('[UNREADABLE]');
    expect(getterReads).toBe(0);
  });

  it('keeps errorObject logging alive when a Proxy rejects getPrototypeOf', () => {
    const lines: string[] = [];
    const logger = createLogger('Safety', { format: 'json', sink: line => lines.push(line) });
    const broken = new Proxy(new Error('SYNTH_PROXY_ERROR'), {
      getPrototypeOf() { throw new Error('SYNTH_PROXY_GETPROTOTYPE_FAILURE'); },
    });

    expect(() => logger.errorObject('proxy failed', broken)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SYNTH_PROXY_GETPROTOTYPE_FAILURE');
  });

  it('isolates the rendered sink record from tap mutation', () => {
    const lines: string[] = [];
    setLogTap(record => {
      record.msg = 'SYNTH_TAP_SECRET';
      record.requestId = 'mutated-request';
    });
    const logger = createLogger('Safety', { format: 'json', sink: line => lines.push(line) });
    logger.info('original message');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('original message');
    expect(lines[0]).not.toContain('SYNTH_TAP_SECRET');
    expect(lines[0]).not.toContain('mutated-request');
  });
});

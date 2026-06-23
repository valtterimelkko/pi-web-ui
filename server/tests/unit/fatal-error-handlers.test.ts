import { describe, it, expect, vi } from 'vitest';
import { createFatalErrorHandlers } from '../../src/fatal-error-handlers.js';
import { createLogger, setLogTap, type LogRecord } from '../../src/logging/logger.js';

describe('fatal error handlers (Task 6)', () => {
  function capture() {
    const records: LogRecord[] = [];
    setLogTap((r) => records.push(r));
    return { records, stop: () => setLogTap(null) };
  }

  it('uncaughtException logs message + stack + context and triggers graceful shutdown', () => {
    const log = capture();
    const shutdown = vi.fn();
    const logger = createLogger('Fatal');
    const handlers = createFatalErrorHandlers({
      logger,
      shutdown,
      getContext: () => ({ activeSessions: 3 }),
    });
    try {
      const err = new Error('kaboom');
      handlers.uncaughtException(err);

      const rec = records_find(log.records, 'uncaughtException');
      expect(rec).toBeDefined();
      expect(rec!.level).toBe('error');
      expect(rec!.error!.message).toBe('kaboom');
      expect(rec!.error!.stack).toContain('kaboom');
      expect(rec!.activeSessions).toBe(3);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      log.stop();
    }
  });

  it('unhandledRejection logs but does NOT shut down', () => {
    const log = capture();
    const shutdown = vi.fn();
    const logger = createLogger('Fatal');
    const handlers = createFatalErrorHandlers({ logger, shutdown });
    try {
      handlers.unhandledRejection('a string reason');

      const rec = records_find(log.records, 'unhandledRejection');
      expect(rec).toBeDefined();
      expect(rec!.level).toBe('error');
      expect(rec!.error!.message).toContain('a string reason');
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      log.stop();
    }
  });

  it('wraps non-Error values into an Error for the stack field', () => {
    const log = capture();
    const logger = createLogger('Fatal');
    const handlers = createFatalErrorHandlers({ logger, shutdown: () => {} });
    try {
      handlers.unhandledRejection({ weird: 'object', n: 42 });
      const rec = records_find(log.records, 'unhandledRejection');
      expect(rec).toBeDefined();
      expect(rec!.error!.message).toContain('weird');
    } finally {
      log.stop();
    }
  });

  it('factory returns both handlers as functions', () => {
    const logger = createLogger('Fatal');
    const h = createFatalErrorHandlers({ logger, shutdown: () => {} });
    expect(typeof h.uncaughtException).toBe('function');
    expect(typeof h.unhandledRejection).toBe('function');
  });
});

function records_find(records: LogRecord[], substr: string): LogRecord | undefined {
  return records.find((r) => r.msg.includes(substr));
}

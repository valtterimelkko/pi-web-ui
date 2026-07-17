import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  setLogTap,
  writeToStreamSink,
  type LogRecord,
  type LoggerOptions,
} from '../../../src/logging/logger.js';
import { withCorrelation } from '../../../src/logging/correlation.js';
import type { LogLevel } from '../../../src/config.js';

function makeLogger(opts: Partial<LoggerOptions> & { component: string }) {
  const lines: Array<{ line: string; level: LogLevel }> = [];
  const logger = createLogger(opts.component, {
    level: opts.level,
    namespaces: opts.namespaces,
    format: opts.format,
    boundContext: opts.boundContext,
    sink: (line, level) => lines.push({ line, level }),
    clock: () => new Date('2026-06-23T12:00:00.000Z'),
    ...opts,
  });
  return { logger, lines };
}

describe('central logger — level filtering (Task 1/2)', () => {
  it('emits error/warn/info and suppresses debug at default info level', () => {
    const { logger, lines } = makeLogger({ component: 'Test' });
    logger.error('e'); logger.warn('w'); logger.info('i'); logger.debug('d');
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn', 'info']);
  });

  it('at warn level, only error/warn emit', () => {
    const { logger, lines } = makeLogger({ component: 'Test', level: 'warn' });
    logger.error('e'); logger.warn('w'); logger.info('i'); logger.debug('d');
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn']);
  });

  it('at error level, only error emits', () => {
    const { logger, lines } = makeLogger({ component: 'Test', level: 'error' });
    logger.error('e'); logger.warn('w'); logger.info('i');
    expect(lines.map((l) => l.level)).toEqual(['error']);
  });

  it('at debug level, everything emits', () => {
    const { logger, lines } = makeLogger({ component: 'Test', level: 'debug' });
    logger.error('e'); logger.warn('w'); logger.info('i'); logger.debug('d');
    expect(lines.map((l) => l.level)).toEqual(['error', 'warn', 'info', 'debug']);
  });

  it('isLevelEnabled reflects current config', () => {
    const { logger } = makeLogger({ component: 'Test', level: 'warn' });
    expect(logger.isLevelEnabled('error')).toBe(true);
    expect(logger.isLevelEnabled('warn')).toBe(true);
    expect(logger.isLevelEnabled('info')).toBe(false);
  });
});

describe('central logger — namespace filtering (Task 3)', () => {
  it('inactive namespaces allow all components', () => {
    const { logger, lines } = makeLogger({
      component: 'claude',
      level: 'debug',
      namespaces: { active: false, patterns: [], isEnabled: () => true },
    });
    logger.info('hi');
    expect(lines).toHaveLength(1);
  });

  it('active namespaces emit debug only for matching components', () => {
    const claude = makeLogger({
      component: 'claude',
      level: 'debug',
      namespaces: { active: true, patterns: ['claude'], isEnabled: (c) => c === 'claude' },
    });
    const opencode = makeLogger({
      component: 'opencode',
      level: 'debug',
      namespaces: { active: true, patterns: ['claude'], isEnabled: (c) => c === 'claude' },
    });
    claude.logger.debug('c'); opencode.logger.debug('o');
    expect(claude.lines).toHaveLength(1);
    expect(opencode.lines).toHaveLength(0);
  });

  it('namespace filter never suppresses warning or error records', () => {
    const { logger, lines } = makeLogger({
      component: 'opencode',
      level: 'debug',
      namespaces: { active: true, patterns: ['claude'], isEnabled: (c) => c === 'claude' },
    });
    logger.info('routine');
    logger.warn('recoverable');
    logger.error('important');
    expect(lines.map((line) => line.level)).toEqual(['warn', 'error']);
  });
});

describe('central logger — format (Task 4)', () => {
  it('pretty (default) prepends [Component] when message has no tag', () => {
    const { logger, lines } = makeLogger({ component: 'Foo' });
    logger.info('hello');
    expect(lines[0].line).toBe('[Foo] hello');
  });

  it('pretty preserves an existing leading [Tag] message verbatim (no double prefix)', () => {
    const { logger, lines } = makeLogger({ component: 'MultiSessionManager' });
    logger.info('[MultiSessionManager] Initialized with cleanupInterval=60000ms');
    expect(lines[0].line).toBe('[MultiSessionManager] Initialized with cleanupInterval=60000ms');
  });

  it('json format emits valid JSON with stable keys', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json', level: 'debug' });
    logger.info('hello');
    const obj = JSON.parse(lines[0].line);
    expect(obj.ts).toBe('2026-06-23T12:00:00.000Z');
    expect(obj.level).toBe('info');
    expect(obj.component).toBe('Foo');
    expect(obj.msg).toBe('hello');
    // stable required keys present
    for (const k of ['ts', 'level', 'component', 'msg']) {
      expect(obj).toHaveProperty(k);
    }
  });

  it('json msg strips a redundant leading [Component]', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json' });
    logger.info('[Foo] hello');
    const obj = JSON.parse(lines[0].line);
    expect(obj.msg).toBe('hello');
    expect(obj.component).toBe('Foo');
  });

  it('json correlation fields appear when present', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json', level: 'debug' });
    withCorrelation({
      requestId: 'req-1',
      runId: 'run-1',
      sessionId: 'sess-1',
      runtime: 'claude',
      executionInstanceId: 'profile-1',
    }, () => {
      logger.info('hi');
    });
    const obj = JSON.parse(lines[0].line);
    expect(obj.requestId).toBe('req-1');
    expect(obj.runId).toBe('run-1');
    expect(obj.sessionId).toBe('sess-1');
    expect(obj.runtime).toBe('claude');
    expect(obj.executionInstanceId).toBe('profile-1');
  });
});

describe('central logger — component & correlation', () => {
  it('exposes its component', () => {
    const { logger } = makeLogger({ component: 'Bar' });
    expect(logger.component).toBe('Bar');
  });

  it('stamps correlation id on pretty lines', () => {
    const { logger, lines } = makeLogger({ component: 'Foo' });
    withCorrelation({
      requestId: 'req-9',
      runId: 'run-9',
      sessionId: 's9',
      runtime: 'pi',
      executionInstanceId: 'pi-local-default',
    }, () => {
      logger.info('doing work');
    });
    expect(lines[0].line).toBe('[Foo] doing work [req=req-9 run=run-9 sid=s9 rt=pi exec=pi-local-default]');
  });

  it('does not stamp anything outside a correlation context', () => {
    const { logger, lines } = makeLogger({ component: 'Foo' });
    logger.info('plain');
    expect(lines[0].line).toBe('[Foo] plain');
  });
});

describe('central logger — error helper (Task 8)', () => {
  it('logs message + stack + name', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json', level: 'error' });
    const err = new Error('boom');
    logger.errorObject('operation failed', err);
    const obj = JSON.parse(lines[0].line);
    expect(obj.level).toBe('error');
    expect(obj.msg).toContain('operation failed');
    expect(obj.error.name).toBe('Error');
    expect(obj.error.message).toBe('boom');
    expect(typeof obj.error.stack).toBe('string');
    expect(obj.error.stack).toContain('boom');
  });

  it('accepts a non-Error value', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json', level: 'error' });
    logger.errorObject('failed', 'string reason');
    const obj = JSON.parse(lines[0].line);
    expect(obj.error.message).toContain('string reason');
  });

  it('includes a context object alongside message + stack', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json', level: 'error' });
    const err = new Error('boom');
    logger.errorObject('operation failed', err, { sessionId: 's1', retry: 2 });
    const obj = JSON.parse(lines[0].line);
    expect(obj.error.stack).toContain('boom');
    expect(obj.sessionId).toBe('s1');
    expect(obj.retry).toBe(2);
  });
});

describe('central logger — child & tap', () => {
  it('child binds fixed context', () => {
    const { logger, lines } = makeLogger({ component: 'Foo', format: 'json', level: 'debug' });
    const child = logger.child({ sessionId: 'bound-1' });
    child.info('hi');
    const obj = JSON.parse(lines[0].line);
    expect(obj.sessionId).toBe('bound-1');
  });

  it('tap receives structured records for emitted lines', () => {
    const records: LogRecord[] = [];
    setLogTap((r) => records.push(r));
    try {
      const { logger } = makeLogger({ component: 'Tapped', level: 'debug' });
      logger.info('a');
      logger.debug('b');
      expect(records.map((r) => r.msg)).toEqual(['a', 'b']);
      expect(records[0].component).toBe('Tapped');
    } finally {
      setLogTap(null);
    }
  });

  it('tap is not called for filtered lines', () => {
    const records: LogRecord[] = [];
    setLogTap((r) => records.push(r));
    try {
      const { logger } = makeLogger({ component: 'Tapped', level: 'warn' });
      logger.info('filtered-out');
      logger.warn('kept');
      expect(records.map((r) => r.msg)).toEqual(['kept']);
    } finally {
      setLogTap(null);
    }
  });
});

describe('central logger — stream sink routing', () => {
  it('routes warn/error to stderr, info/debug to stdout', () => {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c) => { out.push(String(c)); return true; };
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c) => { err.push(String(c)); return true; };
    try {
      writeToStreamSink('to-stdout\n', 'info');
      writeToStreamSink('to-stderr\n', 'error');
      writeToStreamSink('warn-stderr\n', 'warn');
      writeToStreamSink('debug-stdout\n', 'debug');
      expect(out.join('')).toContain('to-stdout');
      expect(out.join('')).toContain('debug-stdout');
      expect(err.join('')).toContain('to-stderr');
      expect(err.join('')).toContain('warn-stderr');
      expect(out.join('')).not.toContain('to-stderr');
      expect(err.join('')).not.toContain('to-stdout');
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = origOut;
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = origErr;
    }
  });
});

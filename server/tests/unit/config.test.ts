import { describe, it, expect } from 'vitest';
import {
  config,
  parseLogLevel,
  LOG_LEVELS,
  parseDebugNamespaces,
  parseLogFormat,
  parsePositiveInteger,
  LOG_FORMATS,
  type LogLevel,
  type LogFormat,
} from '../../src/config.js';

describe('positive integer parsing', () => {
  it('accepts positive integers and rejects zero, negatives, fractions, and junk', () => {
    expect(parsePositiveInteger(undefined, 50, 'TEST')).toBe(50);
    expect(parsePositiveInteger('25', 50, 'TEST')).toBe(25);
    for (const invalid of ['0', '-1', '1.5', 'NaN', '']) {
      expect(() => parsePositiveInteger(invalid, 50, 'TEST')).toThrow(/TEST.*positive integer/i);
    }
  });
});

describe('LOG_LEVEL parsing (Task 2)', () => {
  it('defaults to info when unset', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('   ')).toBe('info');
  });

  it('accepts each valid level (case-insensitive)', () => {
    expect(parseLogLevel('error')).toBe('error');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('  Warn ')).toBe('warn');
  });

  it('falls back to default for invalid values', () => {
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel('trace')).toBe('info');
    expect(parseLogLevel('1234')).toBe('info');
    expect(parseLogLevel('everything')).toBe('info');
  });

  it('honours an explicit fallback', () => {
    expect(parseLogLevel('nope', 'warn')).toBe('warn');
    expect(parseLogLevel(undefined, 'error')).toBe('error');
  });

  it('exports the full ordered level list', () => {
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
  });

  it('exposes a valid logLevel on the resolved config singleton', () => {
    expect(LOG_LEVELS).toContain(config.logLevel as LogLevel);
  });
});

describe('DEBUG namespace parsing (Task 3)', () => {
  it('is inactive (allows all) when unset/blank', () => {
    for (const raw of [undefined, '', '   ', ',,']) {
      const f = parseDebugNamespaces(raw);
      expect(f.active).toBe(false);
      expect(f.patterns).toEqual([]);
      expect(f.isEnabled('claude')).toBe(true);
      expect(f.isEnabled('anything')).toBe(true);
    }
  });

  it('exact-matches a single component', () => {
    const f = parseDebugNamespaces('claude');
    expect(f.active).toBe(true);
    expect(f.isEnabled('claude')).toBe(true);
    expect(f.isEnabled('opencode')).toBe(false);
  });

  it('matches multiple comma-separated components and suppresses others', () => {
    const f = parseDebugNamespaces('claude,opencode-sse');
    expect(f.isEnabled('claude')).toBe(true);
    expect(f.isEnabled('opencode-sse')).toBe(true);
    expect(f.isEnabled('opencode')).toBe(false);
    expect(f.isEnabled('antigravity')).toBe(false);
  });

  it('supports * wildcards', () => {
    const f = parseDebugNamespaces('claude*');
    expect(f.isEnabled('claude')).toBe(true);
    expect(f.isEnabled('ClaudeChannel')).toBe(true); // case-insensitive
    expect(f.isEnabled('ClaudeService')).toBe(true);
    expect(f.isEnabled('opencode')).toBe(false);

    const all = parseDebugNamespaces('*');
    expect(all.isEnabled('claude')).toBe(true);
    expect(all.isEnabled('MultiSessionManager')).toBe(true);
  });

  it('is case-insensitive', () => {
    const f = parseDebugNamespaces('opencode');
    expect(f.isEnabled('OpenCode')).toBe(true);
    expect(f.isEnabled('OPENCODE')).toBe(true);
  });

  it('exposes the original patterns for diagnostics', () => {
    const f = parseDebugNamespaces('claude, opencode* , pi');
    expect(f.patterns).toEqual(['claude', 'opencode*', 'pi']);
  });

  it('config singleton exposes a debugNamespaces filter', () => {
    expect(typeof config.debugNamespaces.isEnabled).toBe('function');
    // default (DEBUG unset in tests) → inactive, allows all
    expect(config.debugNamespaces.isEnabled('claude')).toBe(true);
  });
});

describe('LOG_FORMAT parsing (Task 4)', () => {
  it('defaults to pretty when unset', () => {
    expect(parseLogFormat(undefined)).toBe('pretty');
    expect(parseLogFormat('')).toBe('pretty');
    expect(parseLogFormat('   ')).toBe('pretty');
  });

  it('accepts pretty and json (case-insensitive)', () => {
    expect(parseLogFormat('pretty')).toBe('pretty');
    expect(parseLogFormat('json')).toBe('json');
    expect(parseLogFormat('JSON')).toBe('json');
    expect(parseLogFormat(' Pretty ')).toBe('pretty');
  });

  it('falls back for invalid values', () => {
    expect(parseLogFormat('xml')).toBe('pretty');
    expect(parseLogFormat('yaml')).toBe('pretty');
    expect(parseLogFormat('123')).toBe('pretty');
  });

  it('honours an explicit fallback', () => {
    expect(parseLogFormat('nope', 'json')).toBe('json');
  });

  it('exports the format list and config has a valid logFormat', () => {
    expect(LOG_FORMATS).toEqual(['pretty', 'json']);
    expect(LOG_FORMATS).toContain(config.logFormat as LogFormat);
  });
});

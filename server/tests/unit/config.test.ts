import { describe, it, expect } from 'vitest';
import {
  config,
  parseLogLevel,
  LOG_LEVELS,
  parseDebugNamespaces,
  parseLogFormat,
  parsePositiveInteger,
  parseAbsolutePath,
  parseToolArgsCap,
  resolveToolArgsCaps,
  PI_TOOL_ARGS_MAX_CHARS_BOUND,
  PI_TOOL_ARGS_MIN_CHARS_BOUND,
  parseRunBudgetCap,
  resolveRunBudgetCaps,
  PI_RUN_BUDGET_DEFAULT_OUTPUT_TOKENS,
  PI_RUN_BUDGET_DEFAULT_STREAMED_BYTES,
  PI_RUN_BUDGET_MIN_OUTPUT_TOKENS,
  PI_RUN_BUDGET_MAX_OUTPUT_TOKENS_BOUND,
  PI_RUN_BUDGET_MIN_STREAMED_BYTES,
  PI_RUN_BUDGET_MAX_STREAMED_BYTES_BOUND,
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

describe('absolute path parsing', () => {
  it('accepts absolute configured paths and refuses relative paths', () => {
    expect(parseAbsolutePath(undefined, '/tmp/default', 'PATH')).toBe('/tmp/default');
    expect(parseAbsolutePath(' /opt/cmd ', '/tmp/default', 'PATH')).toBe('/opt/cmd');
    expect(() => parseAbsolutePath('./cmd', '/tmp/default', 'PATH')).toThrow(/absolute/i);
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

describe('pi streaming tool-argument caps (B3a)', () => {
  const MIN = PI_TOOL_ARGS_MIN_CHARS_BOUND;
  const MAX = PI_TOOL_ARGS_MAX_CHARS_BOUND;

  it('single-cap parsing: unset/blank falls back, 0 disables, in-bounds values pass', () => {
    expect(parseToolArgsCap(undefined, 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(65536);
    expect(parseToolArgsCap('', 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(65536);
    expect(parseToolArgsCap('   ', 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(65536);
    expect(parseToolArgsCap('0', 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(0);
    expect(parseToolArgsCap(' 0 ', 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(0);
    expect(parseToolArgsCap(String(MIN), 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(MIN);
    expect(parseToolArgsCap(String(MAX), 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(MAX);
    expect(parseToolArgsCap('8192', 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').value).toBe(8192);
  });

  it('single-cap parsing: out-of-bounds or junk values report a warning and fall back — never throw', () => {
    for (const invalid of ['1', String(MIN - 1), String(MAX + 1), '-5', '1.5', 'NaN', 'abc']) {
      const resolved = parseToolArgsCap(invalid, 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS');
      expect(resolved.value).toBe(65536);
      expect(resolved.warning).toMatch(/PI_TOOL_ARGS_MAX_CALL_CHARS/);
    }
    // The 0 disable path carries no warning.
    expect(parseToolArgsCap('0', 65536, 'PI_TOOL_ARGS_MAX_CALL_CHARS').warning).toBeUndefined();
  });

  it('pair resolution: defaults when both unset; both values honoured in bounds', () => {
    expect(resolveToolArgsCaps(undefined, undefined)).toEqual({
      callChars: 65536,
      turnChars: 262144,
      warnings: [],
    });
    expect(resolveToolArgsCaps('32768', '131072').warnings).toEqual([]);
    expect(resolveToolArgsCaps('32768', '131072')).toMatchObject({ callChars: 32768, turnChars: 131072 });
  });

  it('pair resolution: invalid values warn and fall back to defaults — startup never fails', () => {
    const broken = resolveToolArgsCaps('potato', String(MAX + 1));
    expect(broken).toMatchObject({ callChars: 65536, turnChars: 262144 });
    expect(broken.warnings).toHaveLength(2);
    expect(broken.warnings[0]).toMatch(/PI_TOOL_ARGS_MAX_CALL_CHARS/);
    expect(broken.warnings[1]).toMatch(/PI_TOOL_ARGS_MAX_TURN_CHARS/);
  });

  it('pair resolution: turn cap below call cap warns once and resets BOTH to defaults', () => {
    const inverted = resolveToolArgsCaps('65536', '16384');
    expect(inverted).toMatchObject({ callChars: 65536, turnChars: 262144 });
    expect(inverted.warnings).toHaveLength(1);
    expect(inverted.warnings[0]).toMatch(/PI_TOOL_ARGS_MAX_TURN_CHARS.*PI_TOOL_ARGS_MAX_CALL_CHARS|call cap/s);
  });

  it('pair resolution: an explicit 0 disables that cap without warning, and is exempt from the ordering rule', () => {
    expect(resolveToolArgsCaps('0', '65536')).toMatchObject({ callChars: 0, turnChars: 65536 });
    expect(resolveToolArgsCaps('65536', '0')).toMatchObject({ callChars: 65536, turnChars: 0 });
    expect(resolveToolArgsCaps('0', '0')).toMatchObject({ callChars: 0, turnChars: 0 });
    expect(resolveToolArgsCaps('0', '65536').warnings).toEqual([]);
  });

  it('config singleton exposes validated caps', () => {
    expect(config.piToolArgsMaxCallChars).toBeGreaterThanOrEqual(0);
    expect(config.piToolArgsMaxTurnChars).toBeGreaterThanOrEqual(0);
  });
});

describe('pi per-run output-token and streamed-byte caps (B3b)', () => {
  const TOK_MIN = PI_RUN_BUDGET_MIN_OUTPUT_TOKENS;
  const TOK_MAX = PI_RUN_BUDGET_MAX_OUTPUT_TOKENS_BOUND;
  const BYTE_MIN = PI_RUN_BUDGET_MIN_STREAMED_BYTES;
  const BYTE_MAX = PI_RUN_BUDGET_MAX_STREAMED_BYTES_BOUND;

  it('defaults come from the measured rule and are exported', () => {
    // Correction 01 (measured on the guard's real boundary): 735 files /
    // 3,353 segments merged at a <2s follow-up gap → 3,273 runs; worst case
    // at a 30s merge max 270,689 output tokens per run. Rule: margin over
    // the merged max, NEVER BELOW 2× → 1,000,000 (3.7× the merged max) so a
    // legitimate long agentic loop cannot trip the message-end token cap;
    // the live byte bound is the primary volume control. Streamed bytes:
    // merged max 999,449 (30s: 1,050,331); 16 MiB stays (15.3× ≥ 2× rule),
    // 0/3,280 merged runs breach it.
    expect(PI_RUN_BUDGET_DEFAULT_OUTPUT_TOKENS).toBe(1_000_000);
    expect(PI_RUN_BUDGET_DEFAULT_STREAMED_BYTES).toBe(16 * 1024 * 1024);
  });

  it('bounds are sane and wide enough for measured real runs', () => {
    expect(TOK_MIN).toBeLessThanOrEqual(267_569);
    expect(TOK_MAX).toBeGreaterThanOrEqual(500_000);
    expect(BYTE_MIN).toBeLessThanOrEqual(999_449);
    expect(BYTE_MAX).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });

  it('single-cap parsing: unset/blank falls back, 0 disables, in-bounds values pass (both dimensions)', () => {
    expect(parseRunBudgetCap(undefined, 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(500_000);
    expect(parseRunBudgetCap('', 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(500_000);
    expect(parseRunBudgetCap('   ', 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(500_000);
    expect(parseRunBudgetCap('0', 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(0);
    expect(parseRunBudgetCap(String(TOK_MIN), 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(TOK_MIN);
    expect(parseRunBudgetCap(String(TOK_MAX), 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(TOK_MAX);
    expect(parseRunBudgetCap('123456', 500_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).value).toBe(123_456);

    expect(parseRunBudgetCap(undefined, 16 * 1024 * 1024, 'PI_RUN_BUDGET_MAX_STREAMED_BYTES', BYTE_MIN, BYTE_MAX).value).toBe(16 * 1024 * 1024);
    expect(parseRunBudgetCap('0', 16 * 1024 * 1024, 'PI_RUN_BUDGET_MAX_STREAMED_BYTES', BYTE_MIN, BYTE_MAX).value).toBe(0);
    expect(parseRunBudgetCap(String(BYTE_MIN), 16 * 1024 * 1024, 'PI_RUN_BUDGET_MAX_STREAMED_BYTES', BYTE_MIN, BYTE_MAX).value).toBe(BYTE_MIN);
    expect(parseRunBudgetCap(String(BYTE_MAX), 16 * 1024 * 1024, 'PI_RUN_BUDGET_MAX_STREAMED_BYTES', BYTE_MIN, BYTE_MAX).value).toBe(BYTE_MAX);
  });

  it('single-cap parsing: out-of-bounds or junk values report a warning and fall back — never throw', () => {
    for (const invalid of ['1', String(TOK_MIN - 1), String(TOK_MAX + 1), '-5', '1.5', 'NaN', 'abc']) {
      const resolved = parseRunBudgetCap(invalid, 1_000_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX);
      expect(resolved.value).toBe(1_000_000);
      expect(resolved.warning).toMatch(/PI_RUN_BUDGET_MAX_OUTPUT_TOKENS/);
    }
    for (const invalid of [String(BYTE_MIN - 1), String(BYTE_MAX + 1), 'potato']) {
      const resolved = parseRunBudgetCap(invalid, 16 * 1024 * 1024, 'PI_RUN_BUDGET_MAX_STREAMED_BYTES', BYTE_MIN, BYTE_MAX);
      expect(resolved.value).toBe(16 * 1024 * 1024);
      expect(resolved.warning).toMatch(/PI_RUN_BUDGET_MAX_STREAMED_BYTES/);
    }
    expect(parseRunBudgetCap('0', 1_000_000, 'PI_RUN_BUDGET_MAX_OUTPUT_TOKENS', TOK_MIN, TOK_MAX).warning).toBeUndefined();
  });

  it('pair resolution: defaults when both unset; both values honoured in bounds', () => {
    expect(resolveRunBudgetCaps(undefined, undefined)).toEqual({
      outputTokens: 1_000_000,
      streamedBytes: 16 * 1024 * 1024,
      warnings: [],
    });
    expect(resolveRunBudgetCaps('100000', String(4 * 1024 * 1024))).toMatchObject({
      outputTokens: 100_000,
      streamedBytes: 4 * 1024 * 1024,
    });
    expect(resolveRunBudgetCaps('100000', String(4 * 1024 * 1024)).warnings).toEqual([]);
  });

  it('pair resolution: invalid values warn and fall back to defaults — startup never fails', () => {
    const broken = resolveRunBudgetCaps('potato', String(BYTE_MAX + 1));
    expect(broken).toMatchObject({ outputTokens: 1_000_000, streamedBytes: 16 * 1024 * 1024 });
    expect(broken.warnings).toHaveLength(2);
    expect(broken.warnings[0]).toMatch(/PI_RUN_BUDGET_MAX_OUTPUT_TOKENS/);
    expect(broken.warnings[1]).toMatch(/PI_RUN_BUDGET_MAX_STREAMED_BYTES/);
  });

  it('pair resolution: an explicit 0 disables that dimension without warning, independently', () => {
    expect(resolveRunBudgetCaps('0', '0')).toMatchObject({ outputTokens: 0, streamedBytes: 0 });
    expect(resolveRunBudgetCaps('0', String(8 * 1024 * 1024))).toMatchObject({ outputTokens: 0, streamedBytes: 8 * 1024 * 1024 });
    expect(resolveRunBudgetCaps('250000', '0')).toMatchObject({ outputTokens: 250_000, streamedBytes: 0 });
    expect(resolveRunBudgetCaps('0', '0').warnings).toEqual([]);
  });

  it('config singleton exposes validated run-budget caps', () => {
    expect(config.piRunBudgetMaxOutputTokens).toBeGreaterThanOrEqual(0);
    expect(config.piRunBudgetMaxStreamedBytes).toBeGreaterThanOrEqual(0);
  });
});

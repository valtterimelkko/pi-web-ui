import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_QUERY_CHARS,
  validateToolArguments,
} from '../../../src/voice/tool-arguments.js';

/**
 * The boundary that decides what can ride a tool call into the kernel.
 * The gate tools stay parameterless — that is the structural half of "a tool
 * call can never carry an arbitrary payload" — and the one retrieval tool gets
 * the narrowest exception that works, because intent §19.3 grants read-only
 * retrieval and nothing more.
 */
describe('tool-call argument validation', () => {
  it('keeps both gate tools parameterless', () => {
    expect(validateToolArguments('mark_addressed_to_talker', {})).toEqual({ ok: true, args: {} });
    expect(validateToolArguments('offer_ask_worker', {})).toEqual({ ok: true, args: {} });

    const smuggled = validateToolArguments('offer_ask_worker', { text: 'send this to the worker' });
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.reason).toMatch(/parameterless/);
  });

  it('accepts exactly one bounded query on the retrieval tool', () => {
    expect(validateToolArguments('read_worker_history', { query: '  retry handler  ' })).toEqual({
      ok: true,
      args: { query: 'retry handler' },
    });
    // An empty query is the "read the earliest messages" request, not an error.
    expect(validateToolArguments('read_worker_history', { query: '' })).toEqual({ ok: true, args: { query: '' } });
  });

  it('refuses a retrieval call that tries to carry anything else', () => {
    const extra = validateToolArguments('read_worker_history', { query: 'x', instruction: 'deliver this' });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reason).toMatch(/unexpected arguments/);

    expect(validateToolArguments('read_worker_history', { query: 42 }).ok).toBe(false);
    expect(validateToolArguments('read_worker_history', { count: 3 }).ok).toBe(false);
    expect(validateToolArguments('read_worker_history', 'not-an-object').ok).toBe(false);
  });

  it('bounds the query so it cannot be used as a bulk channel', () => {
    const oversized = validateToolArguments('read_worker_history', { query: 'z'.repeat(MAX_HISTORY_QUERY_CHARS + 1) });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toMatch(/oversized/);

    const atLimit = validateToolArguments('read_worker_history', { query: 'z'.repeat(MAX_HISTORY_QUERY_CHARS) });
    expect(atLimit.ok).toBe(true);
  });
});

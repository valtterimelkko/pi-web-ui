import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_QUERY_CHARS,
  MAX_RELAY_TEXT_CHARS,
  validateToolArguments,
} from '../../../src/voice/tool-arguments.js';

/**
 * The boundary that decides what can ride a tool call into the kernel.
 *
 * 2026-09-22 (owner directive): the two parameterless gate tools were replaced
 * by `relay_to_worker`, which carries the operator's words toward the worker.
 * It can only create a candidate proposal — the operator's own confirmation is
 * still the release predicate — and its argument is bounded so it cannot become
 * a bulk channel. `read_worker_history` keeps the read-only exception.
 */
describe('tool-call argument validation', () => {
  it('accepts exactly one bounded text on the relay tool', () => {
    expect(validateToolArguments('relay_to_worker', { text: '  check the tests  ' })).toEqual({
      ok: true,
      args: { text: 'check the tests' },
    });
  });

  it('refuses an empty relay (there is nothing to approve)', () => {
    expect(validateToolArguments('relay_to_worker', { text: '   ' }).ok).toBe(false);
    expect(validateToolArguments('relay_to_worker', {}).ok).toBe(false);
  });

  it('refuses a relay call that tries to carry anything else', () => {
    const extra = validateToolArguments('relay_to_worker', { text: 'x', release: true });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reason).toMatch(/unexpected arguments/);

    expect(validateToolArguments('relay_to_worker', { text: 42 }).ok).toBe(false);
    expect(validateToolArguments('relay_to_worker', 'not-an-object').ok).toBe(false);
    expect(validateToolArguments('relay_to_worker', { text: '' }).ok).toBe(false);
  });

  it('bounds the relay text so it cannot be used as a bulk channel', () => {
    const oversized = validateToolArguments('relay_to_worker', { text: 'z'.repeat(MAX_RELAY_TEXT_CHARS + 1) });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toMatch(/oversized/);

    const atLimit = validateToolArguments('relay_to_worker', { text: 'z'.repeat(MAX_RELAY_TEXT_CHARS) });
    expect(atLimit.ok).toBe(true);
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

  it('refuses an undeclared tool rather than silently passing it', () => {
    expect(validateToolArguments('not_a_tool' as never, {}).ok).toBe(false);
  });
});

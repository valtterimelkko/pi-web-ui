import { describe, expect, it } from 'vitest';
import { classifyAgyError } from '../../../src/antigravity/agy-error-class.js';

/**
 * Provider-error classification for Antigravity turns.
 *
 * The error texts below are VERBATIM captures from real agy failures (plan
 * `ANTIGRAVITY-POST-TURN-WORK-PLAN.md`, evidence section: quota
 * `RESOURCE_EXHAUSTED` storm on 19 Nov 2026, Google 500/503 on 1 Oct 2026).
 * They are the fixtures the classifier must survive: retrying a quota failure
 * cannot help until the quota resets, while a Google 500/503 is worth waiting
 * out; anything else keeps the pre-existing behaviour.
 *
 * Amendment 01 point 1 (binding): classify ONLY the error text of a turn that
 * actually failed, and anchor on provider envelopes — never on the bare number
 * 429 (a 429 without `RESOURCE_EXHAUSTED` is transient), and never on assistant
 * prose (callers pass `turn.error`, not the reply body).
 */

const QUOTA = 'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).';
const TRANSIENT_500 = 'INTERNAL (code 500): Internal error encountered.';
const TRANSIENT_503 =
  'Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)';
const OTHERS = [
  'model output error: model output must contain either output text or tool calls',
  'timeout',
  'stall',
  'The stream was interrupted. Please continue the task you were working on.',
];

describe('classifyAgyError — provider envelopes', () => {
  it('classifies RESOURCE_EXHAUSTED as quota', () => {
    expect(classifyAgyError(QUOTA)).toEqual({ kind: 'quota' });
  });

  it('classifies a Google INTERNAL 500 as transient', () => {
    expect(classifyAgyError(TRANSIENT_500)).toEqual({ kind: 'transient' });
  });

  it('classifies the UNAVAILABLE 503 capacity storm as transient', () => {
    expect(classifyAgyError(TRANSIENT_503)).toEqual({ kind: 'transient' });
  });

  it('classifies 502 and 504 provider envelopes as transient', () => {
    expect(classifyAgyError('BAD_GATEWAY (code 502): upstream failure').kind).toBe('transient');
    expect(classifyAgyError('DEADLINE_EXCEEDED (code 504): upstream timeout').kind).toBe('transient');
  });

  it('treats a bare 429 (no RESOURCE_EXHAUSTED) as transient, not quota', () => {
    // Amendment 01.1: the envelope carrier decides, not the status number.
    expect(classifyAgyError('RATE_LIMITED (code 429): too many requests').kind).toBe('transient');
  });

  it.each(OTHERS)('classifies %j as other, keeping the pre-existing behaviour', (text) => {
    expect(classifyAgyError(text)).toEqual({ kind: 'other' });
  });

  it('never classifies prose alone: quota/status words without a provider envelope are other', () => {
    expect(classifyAgyError('you have hit your quota; 429 500 503').kind).toBe('other');
    expect(classifyAgyError('The reply did not mention RESOURCE').kind).toBe('other');
  });

  it('is total: empty, undefined and non-string input are other, never a throw', () => {
    expect(classifyAgyError('')).toEqual({ kind: 'other' });
    expect(classifyAgyError(undefined)).toEqual({ kind: 'other' });
    expect(classifyAgyError(null)).toEqual({ kind: 'other' });
  });

  it('is case-insensitive on the envelope wording', () => {
    expect(classifyAgyError('resource_exhausted (code 429): exhausted').kind).toBe('quota');
    expect(classifyAgyError('internal (code 500): Internal error encountered.').kind).toBe('transient');
  });
});

describe('classifyAgyError — reset time (only when the text says so)', () => {
  const NOW = Date.parse('2026-11-22T00:00:00.000Z');

  it('parses an absolute instant that carries an explicit zone', () => {
    const text = `${QUOTA} Quota resets at 2026-11-22T09:30:00Z, retry after that.`;
    expect(classifyAgyError(text, { now: () => NOW })).toEqual({
      kind: 'quota',
      resetAt: '2026-11-22T09:30:00.000Z',
    });
  });

  it('normalises an offset-zoned absolute instant to ISO', () => {
    const text = `${QUOTA} retry after 2026-11-22T10:30:00+01:00`;
    expect(classifyAgyError(text, { now: () => NOW }).resetAt).toBe('2026-11-22T09:30:00.000Z');
  });

  it('parses a relative "retry after N s" against the injected clock', () => {
    expect(classifyAgyError(`${QUOTA} retry after 90s`, { now: () => NOW }).resetAt)
      .toBe('2026-11-22T00:01:30.000Z');
  });

  it('parses a relative "retry after N minutes"', () => {
    expect(classifyAgyError(`${QUOTA} retry after 5 minutes`, { now: () => NOW }).resetAt)
      .toBe('2026-11-22T00:05:00.000Z');
  });

  it('invents nothing: no reset time when the text carries none', () => {
    expect(classifyAgyError(QUOTA, { now: () => NOW })).toEqual({ kind: 'quota' });
    // "try again in a minute" is prose, not an explicit retry-after instant.
    expect(classifyAgyError(TRANSIENT_503, { now: () => NOW }).resetAt).toBeUndefined();
    // A zone-less timestamp is ambiguous, so it is not a reset time.
    expect(classifyAgyError(`${QUOTA} resets at 2026-11-22 09:30:00`, { now: () => NOW }).resetAt).toBeUndefined();
    // A malformed absolute instant is not a reset time either.
    expect(classifyAgyError(`${QUOTA} resets at 2026-13-45T99:99:99Z`, { now: () => NOW }).resetAt).toBeUndefined();
  });

  it('does not attach a reset time to a non-quota classification', () => {
    expect(classifyAgyError(`${TRANSIENT_500} retry after 30s`, { now: () => NOW })).toEqual({ kind: 'transient' });
  });
});

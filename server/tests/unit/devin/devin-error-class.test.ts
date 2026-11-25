import { describe, expect, it } from 'vitest';
import { classifyDevinError } from '../../../src/devin/devin-error-class.js';

/**
 * Devin provider-error classification (lane C phase 1).
 *
 * The fixtures below are SANITISED shapes of the real Devin free-model rate-limit
 * failure (53 distinct messages recorded 2026-11-24 in the private audit journal;
 * no log line, session id, trace id or provider dump is copied into this repo).
 * Recorded variants the classifier must survive:
 *   - `reset in 20 minutes (at 21:19 UTC)`  (48 of 53)
 *   - `reset in 59 seconds (at 23:51 UTC)`  (5 of 53)
 *   - singular `reset in 1 minute`
 *   - a trailing `(trace ID: …)` suffix
 *   - a trailing space
 *
 * Amendment 02 (binding):
 *   - classify ONLY the failed turn's own error text, anchored on the provider
 *     envelope, never on a substring that could sit inside quoted assistant prose;
 *   - anchor a relative reset to the FAILURE time (`now` = the turn's completion),
 *     never to a later sweep clock;
 *   - a stated `HH:MM UTC` may be the current/just-expired minute: that must not
 *     become tomorrow's instant — the relative statement disambiguates the day;
 *   - contradictory, malformed or implausible clocks yield quota with NO resetAt.
 */

const ENVELOPE = 'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model.';

/** 2026-11-24T20:57:40Z — a real failure instant from the recorded wave. */
const NOW = Date.UTC(2026, 10, 24, 20, 57, 40);
const at = (iso: string) => Date.parse(iso);

const MINUTES_20 = `${ENVELOPE} Your limit will reset in 20 minutes (at 21:19 UTC).`;
const MINUTES_15 = `${ENVELOPE} Your limit will reset in 15 minutes (at 21:20 UTC).`;
const SECONDS_59 = `${ENVELOPE} Your limit will reset in 59 seconds (at 23:51 UTC).`;
const MINUTE_1 = `${ENVELOPE} Your limit will reset in 1 minute (at 21:00 UTC).`;
const NO_RESET = `${ENVELOPE}`;
const TRACE_SUFFIX = `${ENVELOPE} Your limit will reset in 15 minutes (at 21:13 UTC). (trace ID: 0123456789abcdef0123456789abcdef)`;

const clock = { now: () => NOW };

describe('classifyDevinError — the provider envelope is the only quota anchor', () => {
  it('classifies the recorded minute form as quota', () => {
    expect(classifyDevinError(MINUTES_20, clock)).toEqual({
      kind: 'quota',
      resetAt: new Date(at('2026-11-24T21:19:00Z')).toISOString(),
    });
  });

  it('classifies the recorded seconds form as quota', () => {
    const now = at('2026-11-24T23:49:00Z');
    expect(classifyDevinError(SECONDS_59, { now: () => now })).toEqual({
      kind: 'quota',
      resetAt: new Date(at('2026-11-24T23:51:00Z')).toISOString(),
    });
  });

  it('classifies the singular "1 minute" form', () => {
    expect(classifyDevinError(MINUTE_1, clock).kind).toBe('quota');
    expect(classifyDevinError(MINUTE_1, clock).resetAt).toBe(new Date(at('2026-11-24T21:00:00Z')).toISOString());
  });

  it('tolerates a trailing trace-id suffix and a trailing space without echoing either', () => {
    const withTrace = classifyDevinError(TRACE_SUFFIX, clock);
    expect(withTrace.kind).toBe('quota');
    expect(withTrace.resetAt).toBe(new Date(at('2026-11-24T21:13:00Z')).toISOString());
    // No private provider trace may ride along in any field.
    expect(JSON.stringify(withTrace)).not.toMatch(/0123456789abcdef|trace/i);
    expect(classifyDevinError(`${MINUTES_20} `, clock)).toEqual(classifyDevinError(MINUTES_20, clock));
  });

  it('keeps quota with NO resetAt when the text states no reset (unknown stays unknown)', () => {
    expect(classifyDevinError(NO_RESET, clock)).toEqual({ kind: 'quota' });
  });

  it('never classifies the upsell sentence or bare status words alone as quota', () => {
    // Anchoring on the envelope, not on prose that could be quoted in a reply.
    const negative = [
      'Upgrade to Max for higher limits, or switch to a different model.',
      'you have hit your quota; rate limit 429 500',
      'Your limit will reset in 20 minutes (at 21:19 UTC).',
      'The Devin turn failed (reached your quota).',
    ];
    for (const text of negative) expect(classifyDevinError(text, clock)).toEqual({ kind: 'other' });
  });

  it('leaves the other recorded Devin failures as other (no invented transient class)', () => {
    const others = [
      'devin acp session/prompt timed out after 120000ms',
      'session/set_config_option model failed: Invalid params',
      'devin acp exited; cannot send session/prompt',
      'Devin is disabled',
      'timeout',
      'stall',
      // The Antigravity envelope is a different provider: this module must not claim it.
      'RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
    ];
    for (const text of others) expect(classifyDevinError(text, clock)).toEqual({ kind: 'other' });
  });

  it('is total: empty, null, undefined and garbage never throw', () => {
    for (const text of ['', '   ', null, undefined, 'x'.repeat(200_000), '💥'.repeat(1000)]) {
      expect(() => classifyDevinError(text, clock)).not.toThrow();
    }
    expect(classifyDevinError(null, clock)).toEqual({ kind: 'other' });
    expect(classifyDevinError(undefined, clock)).toEqual({ kind: 'other' });
  });
});

describe('classifyDevinError — reset derivation is conservative and clock-anchored', () => {
  it('derives from the injected clock only (the caller anchors it to the failure instant)', () => {
    // Amendment 02: the caller passes the turn's completion time, so the sweeper
    // reading the turn late produces the same guidance as the one reading it now
    // (proved at the sweeper level); the classifier itself must never consult
    // real time when a clock is injected, and must be deterministic.
    const a = classifyDevinError(MINUTES_15, { now: () => at('2026-11-24T21:03:00Z') });
    const b = classifyDevinError(MINUTES_15, { now: () => at('2026-11-24T21:03:00Z') });
    expect(a).toEqual(b);
    expect(a.resetAt).toBe(new Date(at('2026-11-24T21:20:00Z')).toISOString());
    // A different reference instant yields a different derivation: proof the
    // injected clock (not the wall clock) is what the relative form uses.
    const shifted = classifyDevinError(MINUTES_15, { now: () => at('2026-11-24T21:10:00Z') });
    expect(shifted.resetAt).toBe(new Date(at('2026-11-24T21:25:00Z')).toISOString());
  });

  it('accepts a relative-only statement (the provider always sends both, but one is enough)', () => {
    expect(classifyDevinError(`${ENVELOPE} Your limit will reset in 15 minutes.`, clock)).toEqual({
      kind: 'quota',
      resetAt: new Date(at('2026-11-24T21:12:40Z')).toISOString(),
    });
  });

  it('never produces tomorrow for an HH:MM that is the current or just-expired minute', () => {
    // Amendment 02 (Q3): now 21:20:30, message "reset in 30 seconds (at 21:20 UTC)".
    const now = at('2026-11-24T21:20:30Z');
    const result = classifyDevinError(
      `${ENVELOPE} Your limit will reset in 30 seconds (at 21:20 UTC).`,
      { now: () => now },
    );
    expect(result.kind).toBe('quota');
    // The relative statement resolves it inside today, not 24 hours later.
    expect(result.resetAt).toBe(new Date(at('2026-11-24T21:21:00Z')).toISOString());
    expect(result.resetAt).not.toBe(new Date(at('2026-11-25T21:20:00Z')).toISOString());
  });

  it('rolls forward exactly one day across midnight when both statements agree on that', () => {
    // 23:58Z + 3 minutes; the stated UTC instant is 00:01 (next day).
    const now = at('2026-11-24T23:58:00Z');
    expect(classifyDevinError(`${ENVELOPE} Your limit will reset in 3 minutes (at 00:01 UTC).`, { now: () => now })).toEqual({
      kind: 'quota',
      resetAt: new Date(at('2026-11-25T00:01:00Z')).toISOString(),
    });
  });

  it('returns quota with no resetAt for contradictory statements', () => {
    // Stated instant is a DAY behind the relative prediction: never guess which is right.
    const now = at('2026-11-24T20:57:40Z');
    for (const text of [
      `${ENVELOPE} Your limit will reset in 15 minutes (at 03:00 UTC).`,
      `${ENVELOPE} Your limit will reset in 15 minutes (at 20:00 UTC).`,
      `${ENVELOPE} Your limit will reset in 15 minutes (at 22:46 UTC).`,
      `${ENVELOPE} Your limit will reset in 600 minutes (at 21:20 UTC).`,
    ]) {
      expect(classifyDevinError(text, { now: () => now })).toEqual({ kind: 'quota' });
    }
  });

  it('returns quota with no resetAt for malformed or out-of-range clocks', () => {
    const malformed = [
      `${ENVELOPE} Your limit will reset in 15 minutes (at 25:20 UTC).`,
      `${ENVELOPE} Your limit will reset in 15 minutes (at 21:99 UTC).`,
      `${ENVELOPE} Your limit will reset in 15 minutes (at 21:20).`,
      `${ENVELOPE} Your limit will reset in 0 minutes (at 21:20 UTC).`,
      `${ENVELOPE} Your limit will reset in -5 minutes (at 21:20 UTC).`,
      `${ENVELOPE} Your limit will reset in 99999999999999999999 minutes (at 21:20 UTC).`,
    ];
    for (const text of malformed) expect(classifyDevinError(text, clock)).toEqual({ kind: 'quota' });
  });

  it('never attaches a reset instant to a non-quota class', () => {
    expect(classifyDevinError('rate limit hit; reset in 20 minutes (at 21:19 UTC)', clock)).toEqual({ kind: 'other' });
  });

  it('uses the real clock by default and stays in the future', () => {
    const result = classifyDevinError(`${ENVELOPE} Your limit will reset in 20 minutes (at 23:59 UTC).`);
    if (result.resetAt !== undefined) {
      // Only the plausibility bound is asserted here: the default clock is real time.
      expect(Date.parse(result.resetAt)).toBeGreaterThan(Date.now() - 1000);
    } else {
      expect(result).toEqual({ kind: 'quota' });
    }
  });
});

/**
 * Antigravity (agy) provider-error classification.
 *
 * Provider errors reach a failed turn as agy's own text (`turn.error`). Two
 * classes behave in opposite ways:
 *
 *   - **quota** (`RESOURCE_EXHAUSTED`): retrying cannot help until the quota
 *     resets — the goal must stop, not burn strikes (321 agy conversations
 *     failed within an hour on 19 Nov 2026).
 *   - **transient** (Google `INTERNAL 500`, `UNAVAILABLE 503`, `502`, `504`):
 *     the same request is likely to succeed later, so back off and retry
 *     (27 failed turns in 12 minutes on 1 Oct 2026, retried instantly).
 *   - **other** (stall, timeout, model-output error, stream interruption):
 *     the pre-existing behaviour, which this module must not change.
 *
 * Amendment 01 (binding): classify only the ERROR text of a turn that actually
 * failed — never the assistant reply — and anchor on provider envelopes, not on
 * bare status numbers. A `429` without `RESOURCE_EXHAUSTED` is therefore
 * transient, not quota.
 *
 * `resetAt` is reported only when the text states it explicitly (an absolute
 * instant with a zone, or `retry after N s/min` measured against an injected
 * clock). It is never invented, and never attached to a non-quota class.
 */

export type AgyErrorKind = 'quota' | 'transient' | 'other';

export interface AgyErrorClassification {
  kind: AgyErrorKind;
  /** ISO instant at which the provider said it is usable again (quota only). */
  resetAt?: string;
}

export interface AgyErrorClassifyOptions {
  /** Injected clock, so a relative "retry after" is testable. Default `Date.now`. */
  now?: () => number;
}

/** Quota envelope: the only text that means "stop until the quota resets". */
const QUOTA_ENVELOPE = /RESOURCE_EXHAUSTED/i;

/**
 * Transient envelopes. Distinct live wordings:
 *   `INTERNAL (code 500): Internal error encountered.`
 *   `... (UNAVAILABLE (code 503): No capacity available for model ...)`
 * plus the sibling gateway/deadline codes and a bare 429 (amendment 01.1).
 */
const TRANSIENT_ENVELOPES = [
  /INTERNAL\s*\(code 500\)/i,
  /UNAVAILABLE\s*\(code 503\)/i,
  /\(code (?:429|500|502|503|504)\)/i,
];

/** An absolute instant is unambiguous only with an explicit zone. */
const ABSOLUTE_WITH_ZONE = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\b/;

/** Explicit relative form: `retry after 90s`, `retry-after: 5 minutes`. */
const RELATIVE_RETRY_AFTER = /\bretry[\s-]?after:?\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i;

function relativeMs(value: number, unit: string): number {
  const lower = unit.toLowerCase();
  return lower.startsWith('m') ? value * 60_000 : value * 1_000;
}

/** Parse an explicitly stated reset instant, or undefined. */
function parseResetAt(text: string, now: () => number): string | undefined {
  const absolute = text.match(ABSOLUTE_WITH_ZONE);
  if (absolute) {
    const parsed = Date.parse(absolute[1]);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const relative = text.match(RELATIVE_RETRY_AFTER);
  if (relative) {
    const amount = Number(relative[1]);
    if (Number.isSafeInteger(amount) && amount > 0) {
      return new Date(now() + relativeMs(amount, relative[2])).toISOString();
    }
  }
  return undefined;
}

/**
 * Classify one failed turn's provider error text. Total: never throws, and
 * anything unrecognised is `other` (the pre-existing behaviour).
 */
export function classifyAgyError(
  text: string | null | undefined,
  options: AgyErrorClassifyOptions = {},
): AgyErrorClassification {
  if (typeof text !== 'string' || text.length === 0) return { kind: 'other' };
  if (QUOTA_ENVELOPE.test(text)) {
    const resetAt = parseResetAt(text, options.now ?? Date.now);
    return resetAt ? { kind: 'quota', resetAt } : { kind: 'quota' };
  }
  if (TRANSIENT_ENVELOPES.some((pattern) => pattern.test(text))) return { kind: 'transient' };
  return { kind: 'other' };
}

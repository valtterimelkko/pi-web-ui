/**
 * Devin (ACP) provider-error classification — lane C phase 1.
 *
 * A Devin free-model turn can be refused with a time-bounded allowance message
 * (`Reached free model rate limit. … Your limit will reset in N … (at HH:MM UTC).`).
 * Retrying cannot help until that allowance resets, so the refusal must reach a
 * caller as a class it can act on instead of a generic runtime error.
 *
 * The vocabulary is the ALREADY-SHIPPED one from the Antigravity provider-error
 * work (contract 1.70.0): `kind: "quota" | "transient" | "other"` and an optional
 * `resetAt` (ISO 8601) that appears only when the provider's own text stated it.
 * This module adds no error code, no receipt field and no new key name, and it
 * never schedules anything: `resetAt` is advice for the caller.
 *
 * Binding rules:
 *   - Only the FAILED TURN's own error text may be classified — never the
 *     assistant reply body, which can quote arbitrary prose;
 *   - the quota anchor is the provider's envelope at the start of the message,
 *     not a bare `quota` / `rate limit` / `429` substring;
 *   - the relative statement is anchored to the injected `now`. A caller that
 *     wants stable guidance across delayed sweeps passes the FAILURE instant
 *     (the turn's completion time), not the sweep clock;
 *   - no Devin transient envelope is evidenced, so `transient` is never emitted
 *     for this runtime; it stays in the union so the shape matches the shipped
 *     vocabulary and a future evidenced envelope is a one-line addition;
 *   - contradictory, malformed or implausible statements yield `quota` with NO
 *     `resetAt` — an instant is never invented.
 */

export type DevinErrorKind = 'quota' | 'transient' | 'other';

export interface DevinErrorClassification {
  kind: DevinErrorKind;
  /** ISO instant at which the provider said the allowance is usable again (quota only). */
  resetAt?: string;
}

export interface DevinErrorClassifyOptions {
  /** Reference instant for the relative statement. Default `Date.now`. */
  now?: () => number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** A reset further out than this is not plausible for a free-model allowance. */
const MAX_HORIZON_MS = DAY_MS;
/**
 * Two statements further apart than this contradict each other. The recorded
 * pairs differ by 60–120 s (the UTC instant is minute-granular and rounds up);
 * ten minutes is comfortably beyond that and still far below the hours-wide gap
 * a stale or garbled statement produces.
 */
const MAX_DISAGREEMENT_MS = 10 * MINUTE_MS;
/**
 * A stated `HH:MM UTC` may name the current or just-expired minute (the provider
 * writes minute granularity). Inside this window it is treated as "now-ish"; a
 * statement this stale is not repaired by rolling it to tomorrow.
 */
const STALE_GRACE_MS = 5 * MINUTE_MS;

/** The provider's own quota envelope, anchored at the start of the message. */
const QUOTA_ENVELOPE = /^\s*Reached (?:a )?free model rate limit\b/i;
/** A relative reset statement is present (parseable or not). */
const RELATIVE_PRESENT = /\breset in\b/i;
const RELATIVE_RESET = /\breset in\s+(\d+)\s*(second|seconds|minute|minutes)\b/i;
/** A clock statement is present (parseable or not). */
const CLOCK_PRESENT = /\bat\s+\d{1,2}:\d{2}/i;
const ABSOLUTE_RESET = /\bat\s+(\d{1,2}):(\d{2})\s*UTC\b/i;

/** Parse `reset in N seconds|minutes` as a positive offset, or undefined. */
function parseRelativeOffset(text: string): number | undefined {
  const match = RELATIVE_RESET.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const unitMs = match[2].toLowerCase().startsWith('m') ? MINUTE_MS : 1_000;
  const offset = amount * unitMs;
  if (!Number.isSafeInteger(offset) || offset > MAX_HORIZON_MS) return undefined;
  return offset;
}

/** Parse `at HH:MM UTC` with validated fields, or undefined. */
function parseClock(text: string): { hours: number; minutes: number } | undefined {
  const match = ABSOLUTE_RESET.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return undefined;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return undefined;
  return { hours, minutes };
}

/**
 * Derive the reset instant from the provider's own statements, or `undefined`.
 * Never throws and never guesses: an unusable statement yields no instant.
 */
function deriveResetAt(text: string, nowMs: number): string | undefined {
  if (!Number.isFinite(nowMs)) return undefined;

  const relativeStated = RELATIVE_PRESENT.test(text);
  const clockStated = CLOCK_PRESENT.test(text);
  const relative = parseRelativeOffset(text);
  const clock = parseClock(text);

  // A statement the text makes but we cannot trust is not repaired.
  if (relativeStated && relative === undefined) return undefined;
  if (clockStated && clock === undefined) return undefined;

  const relativeAt = relative === undefined ? undefined : nowMs + relative;
  let absoluteAt: number | undefined;
  if (clock !== undefined) {
    const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const minuteOfDay = (clock.hours * 60 + clock.minutes) * MINUTE_MS;
    if (relativeAt !== undefined) {
      // The relative statement is second-granular; use it to pick the UTC day the
      // minute-granular clock refers to (this is what keeps a just-passed HH:MM
      // from turning into tomorrow's instant).
      let best = dayStart - DAY_MS + minuteOfDay;
      for (const candidate of [dayStart + minuteOfDay, dayStart + DAY_MS + minuteOfDay]) {
        if (Math.abs(candidate - relativeAt) < Math.abs(best - relativeAt)) best = candidate;
      }
      absoluteAt = best;
    } else {
      // No relative statement to disambiguate the day: only an instant still
      // ahead today is trustworthy.
      const todayAt = dayStart + minuteOfDay;
      absoluteAt = todayAt >= nowMs ? todayAt : undefined;
    }
  }

  if (relativeAt !== undefined && absoluteAt !== undefined) {
    // The stated clock already passed: stale, not "tomorrow".
    if (nowMs - absoluteAt > STALE_GRACE_MS) return undefined;
    if (Math.abs(absoluteAt - relativeAt) > MAX_DISAGREEMENT_MS) return undefined;
    // Later of two agreeing statements: never earlier than either claimed.
    return instant(Math.max(relativeAt, absoluteAt), nowMs);
  }

  const single = relativeAt ?? absoluteAt;
  if (single === undefined) return undefined;
  return instant(single, nowMs);
}

/** Bound a candidate instant to a plausible future window, or drop it. */
function instant(candidateMs: number, nowMs: number): string | undefined {
  if (!Number.isFinite(candidateMs)) return undefined;
  if (candidateMs < nowMs - STALE_GRACE_MS) return undefined;
  if (candidateMs - nowMs > MAX_HORIZON_MS) return undefined;
  const iso = new Date(Math.max(candidateMs, nowMs)).toISOString();
  return iso;
}

/**
 * Classify one failed Devin turn's provider error text.
 * Total: never throws; anything unrecognised is `other` (the pre-existing
 * behaviour, which keeps the generic three-strike policy).
 */
export function classifyDevinError(
  text: string | null | undefined,
  options: DevinErrorClassifyOptions = {},
): DevinErrorClassification {
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'other' };
  if (!QUOTA_ENVELOPE.test(text)) return { kind: 'other' };
  const resetAt = deriveResetAt(text, (options.now ?? Date.now)());
  return resetAt === undefined ? { kind: 'quota' } : { kind: 'quota', resetAt };
}

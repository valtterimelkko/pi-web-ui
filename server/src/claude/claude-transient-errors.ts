/**
 * Transient Claude failure detection + retry backoff.
 *
 * Anthropic's endpoints (and z.ai for GLM) occasionally return transient
 * capacity/network failures — "model is temporarily unavailable", 429/503/529
 * overload, gateway timeouts, socket resets. These are NOT permanent: a bounded
 * retry with exponential backoff usually recovers within seconds.
 *
 * Both Claude backends use these helpers so they behave consistently:
 *   - the SDK backend (claude-sdk-service.ts)
 *   - the direct-CLI backend (claude-process-pool.ts)
 *
 * The 2026-06-23 "Opus session never answered" incident was exactly this
 * symptom surfacing as a silent empty result; see the memory note
 * `claude-sdk-opus-silent-fail`.
 */

/**
 * Substrings (matched case-insensitively) that signal a retryable transient
 * failure. Kept deliberately specific to avoid retrying genuine, permanent
 * errors (auth, invalid model, prompt rejection).
 */
const TRANSIENT_TEXT_PATTERNS: readonly string[] = [
  'temporarily unavailable',
  'overloaded',
  'service unavailable',
  'too many requests',
  'rate limit',
  'rate_limit',
  'internal server error',
  'bad gateway',
  'gateway timeout',
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network error',
  'connection error',
  'connection closed',
  'connection reset',
  'fetch failed',
  'upstream error',
  'no response from',
];

/**
 * HTTP status codes (matched as whole words) that indicate overload/gateway
 * problems and are safe to retry. 500 is intentionally excluded as a bare
 * number (too easily a false positive); the textual "internal server error"
 * pattern covers genuine 500s.
 */
const TRANSIENT_STATUS_RE = /\b(408|409|425|429|502|503|504|529)\b/;

/**
 * Return true if the given text (an error message, stderr, or result string)
 * looks like a transient, retryable Claude/provider failure.
 */
export function isTransientClaudeError(text?: string | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const pattern of TRANSIENT_TEXT_PATTERNS) {
    if (lower.includes(pattern)) return true;
  }
  return TRANSIENT_STATUS_RE.test(lower);
}

// ─── Retry configuration ───────────────────────────────────────────────────

export interface TransientRetryConfig {
  /** Number of retries AFTER the initial attempt (so total attempts = maxRetries + 1). */
  maxRetries: number;
  /** Base delay in ms for the first retry; doubles each subsequent retry. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs: number;
}

const HARD_MAX_RETRIES = 5;

/**
 * Read retry configuration from the environment, with safe defaults.
 *
 *   CLAUDE_TRANSIENT_MAX_RETRIES   (default 2, hard-capped at 5)
 *   CLAUDE_TRANSIENT_BASE_DELAY_MS (default 1000)
 *   CLAUDE_TRANSIENT_MAX_DELAY_MS  (default 15000)
 *
 * Setting CLAUDE_TRANSIENT_MAX_RETRIES=0 disables transient retries.
 */
export function getTransientRetryConfig(env: NodeJS.ProcessEnv = process.env): TransientRetryConfig {
  const parseIntSafe = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw.trim() === '') return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const maxRetries = Math.min(parseIntSafe(env.CLAUDE_TRANSIENT_MAX_RETRIES, 2), HARD_MAX_RETRIES);
  const baseDelayMs = parseIntSafe(env.CLAUDE_TRANSIENT_BASE_DELAY_MS, 1000);
  const maxDelayMs = parseIntSafe(env.CLAUDE_TRANSIENT_MAX_DELAY_MS, 15000);
  return { maxRetries, baseDelayMs, maxDelayMs };
}

/**
 * Deterministic exponential backoff for a 1-based retry number.
 *   retry 1 → base, retry 2 → base*2, retry 3 → base*4, … capped at maxDelayMs.
 */
export function computeBackoffMs(retryNumber: number, baseDelayMs: number, maxDelayMs: number): number {
  if (retryNumber < 1) return 0;
  const delay = baseDelayMs * 2 ** (retryNumber - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * spokenLedger — one shared record of what the speech surface has already
 * said (P16).
 *
 * The surface has several producers: the talker's auto-speak, the operator's
 * read-aloud, and the talker's mechanical acks. Any two of them can be handed
 * the same words, and the operator must never hear those words twice — the
 * defect this module exists to prevent is pressing read-aloud on an answer,
 * letting the turn end, and having the auto-speak submit the same answer
 * again at the same tier, back to back.
 *
 * Producers CLAIM text before submitting it; a failed claim means "already
 * spoken, do not submit". An explicit operator action (read-aloud) is never
 * refused — it MARKS the text and submits regardless, which is also what
 * stops the auto path repeating what the operator just asked for.
 *
 * Two scopes, deliberately:
 *
 *   - CONTENT (default) — the worker's answer and anything read aloud. Keyed
 *     on the words alone, so the same content is spoken once whichever
 *     producer started it, and a later identical answer is a duplicate.
 *   - An explicit event scope — mechanical acks. The receipt ack is a
 *     CONSTANT string ("Noted — still holding that.") that must speak again
 *     for every unacknowledged utterance: hearing it twice is §4.1 rule 2
 *     working, not a duplicate. Event-scoped acks therefore suppress only a
 *     repeat of the SAME event, never a repeat of the same words.
 *
 * Client-local and independent of the speech arbiter, which is consumed
 * unchanged. Comparison is on normalised text (trimmed, internal whitespace
 * collapsed) because chunking and transport can legitimately respace the same
 * words. Capacity is bounded and oldest-first, so a long-lived surface cannot
 * grow without limit.
 */

/** Max distinct claims remembered before the oldest is forgotten. */
export const SPOKEN_LEDGER_CAPACITY = 64;

/** Scope for spoken content — the worker's answer, read-aloud playback. */
export const CONTENT_SCOPE = 'content';

/** Trim and collapse internal whitespace so respaced text still matches. */
export function normaliseSpokenText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface SpokenLedger {
  /** True when `text` has already been spoken (or claimed) in `scope`. */
  has(text: string, scope?: string): boolean;
  /** Records `text` as spoken in `scope`. No-op for empty text. */
  mark(text: string, scope?: string): void;
  /** Claims `text` for `scope`: true when this caller may speak it, false
   *  when it is a duplicate (or empty). A successful claim is recorded. */
  claim(text: string, scope?: string): boolean;
  /** Forgets everything (test isolation; not used by the surface). */
  clear(): void;
  /** Number of remembered claims. */
  size(): number;
}

export function createSpokenLedger(capacity: number = SPOKEN_LEDGER_CAPACITY): SpokenLedger {
  const limit = Math.max(1, Math.floor(capacity));
  const spoken = new Set<string>();
  const order: string[] = [];

  const keyOf = (text: string, scope: string): string => {
    const normalised = normaliseSpokenText(text);
    return normalised ? `${scope}\u0000${normalised}` : '';
  };

  const record = (key: string): void => {
    if (!key || spoken.has(key)) return;
    spoken.add(key);
    order.push(key);
    while (order.length > limit) {
      const oldest = order.shift();
      if (oldest !== undefined) spoken.delete(oldest);
    }
  };

  return {
    has(text, scope = CONTENT_SCOPE) {
      const key = keyOf(text, scope);
      return key.length > 0 && spoken.has(key);
    },
    mark(text, scope = CONTENT_SCOPE) {
      record(keyOf(text, scope));
    },
    claim(text, scope = CONTENT_SCOPE) {
      const key = keyOf(text, scope);
      if (!key || spoken.has(key)) return false;
      record(key);
      return true;
    },
    clear() {
      spoken.clear();
      order.length = 0;
    },
    size() {
      return spoken.size;
    },
  };
}

/** App-wide ledger. Every speech producer consults this one record. */
export const spokenLedger: SpokenLedger = createSpokenLedger();

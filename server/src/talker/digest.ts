/**
 * The talker digest (P17, package A of docs/plans/VOICE-READING-AND-QA-DESIGN.md).
 *
 * Before this existed, the worker's final answer was read VERBATIM by the
 * auto-speak path — raw text straight to TTS, with no talker involvement at all.
 * A reading level puts the talker into that reading path: instead of submitting
 * the raw answer, the surface submits a digest the talker produced.
 *
 * TWO EXTRACTIONS, deliberately:
 *   - summary   a spoken digest of the turn (plain prose, for the ear);
 *   - headlines status plus asks, one line — "Done: X. Needs you: Y." — a
 *               DIFFERENT extraction, not a shorter summary, which is why it can
 *               be left on permanently.
 *
 * ONE DIRECTION ONLY. This module condenses the WORKER's words for the
 * operator. It has no delivery path, no draft, no utterance log and no gate —
 * it cannot send anything to the worker, and nothing here takes operator input.
 *
 * The prompt is canonical file content (scripts/talker-prompts/digest.txt),
 * loaded through the same loader and byte-pinned by test as the talker prompt:
 * a digest is a quality contract, and a prompt buried in code drifts silently.
 */

import { loadDigestSystemPrompt } from './prompt.js';
import type { ChatMessage, ModelTurnResult, TalkerModelClient } from './types.js';

/** The canonical prompt file this module reads (re-exported so the byte-pin
 *  test names the module whose behaviour it guards). */
export { DIGEST_PROMPT_RELATIVE_PATH } from './prompt.js';

export type DigestKind = 'summary' | 'headlines';

/** Both kinds are described in the canonical prompt; the user message names
 *  the one this request wants. */
const KIND_INSTRUCTION: Record<DigestKind, string> = {
  summary: 'Reading level: Summary. Digest the worker output below.',
  headlines: 'Reading level: Headlines. Reduce the worker output below to the one line.',
};

/**
 * A turn longer than this is not digested from a fragment: truncating would
 * silently drop whatever came after the cut, which is exactly the omission a
 * digest must never cause. The caller falls back to reading the turn in full.
 */
export const TALKER_DIGEST_MAX_TEXT_CHARS = 40_000;

/** A Headlines line is one sentence by design; the cap is a runaway guard, not
 *  the shape rule (the prompt owns the shape). */
export const TALKER_DIGEST_HEADLINES_MAX_CHARS = 400;

export const TALKER_DIGEST_SUMMARY_MAX_CHARS = 800;

const WRAPPING_QUOTES = new Set(['"', "'", '“', '”', '‘', '’']);

export interface DigestRequest {
  kind: DigestKind;
  /** The worker's output to digest — the unplayed remainder after a mid-speech
   *  flip, the whole turn otherwise. */
  text: string;
  /** What the operator has already heard; context only, never repeated. */
  spokenPrefix?: string;
}

export interface DigestOutcome {
  digest: string;
  ttftMs: number | null;
  totalMs: number;
}

/**
 * The two messages this call ever sends: the canonical prompt, and a delimited
 * user message carrying the worker's output. The worker's text is never spliced
 * into the system prompt — it is material to read, not instructions to obey.
 */
export function buildDigestMessages(request: DigestRequest): ChatMessage[] {
  const parts: string[] = ['', '--- WORKER OUTPUT TO DIGEST ---', request.text.trim(), '--- END WORKER OUTPUT ---'];

  const prefix = request.spokenPrefix?.trim();
  if (prefix) {
    // The mid-speech flip: the operator switched levels part-way through, so
    // the digest must cover the remainder without repeating what they heard.
    parts.push(
      '',
      'The operator has already heard the beginning of this turn out loud.',
      'Do not repeat anything they have heard; digest only what is new to them.',
      '--- ALREADY HEARD ---',
      prefix,
      '--- END ALREADY HEARD ---'
    );
  }

  return [
    { role: 'system', content: loadDigestSystemPrompt() },
    { role: 'user', content: `${KIND_INSTRUCTION[request.kind]}\n${parts.join('\n')}` },
  ];
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Shape the model's reply into something speakable. Deliberately mechanical and
 * small: collapse whitespace (a Headlines line must be ONE line whatever the
 * model returned), drop a wrapping quote pair the model may have added, cap a
 * runaway. An empty result is null — the caller must never speak silence as if
 * it were the turn.
 */
export function normaliseDigest(kind: DigestKind, raw: string): string | null {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (text.length > 1 && WRAPPING_QUOTES.has(text[0]) && WRAPPING_QUOTES.has(text[text.length - 1])) {
    text = text.slice(1, -1).trim();
    if (!text) return null;
  }

  return kind === 'headlines'
    ? cap(text, TALKER_DIGEST_HEADLINES_MAX_CHARS)
    : cap(text, TALKER_DIGEST_SUMMARY_MAX_CHARS);
}

/**
 * One model call, one digest. No retry ladder of its own (the talker's model
 * client already owns degenerate-output handling) and no invented fallback: a
 * failure here is a failure, and the caller reads the turn in full instead.
 */
export async function digestTurn(
  model: TalkerModelClient,
  request: DigestRequest
): Promise<DigestOutcome> {
  const text = request.text.trim();
  if (!text) {
    throw new Error('digest request has no text');
  }
  if (text.length > TALKER_DIGEST_MAX_TEXT_CHARS) {
    throw new Error(
      `digest text is too long (${text.length} characters, limit ${TALKER_DIGEST_MAX_TEXT_CHARS})`
    );
  }

  const result: ModelTurnResult = await model.completeTurn(buildDigestMessages({ ...request, text }));
  const digest = normaliseDigest(request.kind, result.text);
  if (!digest) {
    throw new Error('the talker produced an empty digest');
  }
  return { digest, ttftMs: result.ttftMs, totalMs: result.totalMs };
}

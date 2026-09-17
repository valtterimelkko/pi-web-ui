/**
 * Handshake transcript verdict (Track B, Gate 3b).
 *
 * The live probe must not pass merely because "a transcription delta arrived".
 * The conductor's negative control proved the hole: with the speech fixture
 * replaced by digital silence, the provider hallucinated a short input delta
 * (`¿Qué?`) and the previous condition (inputTranscriptDeltas >= 1) printed PASS.
 *
 * The pass condition is therefore a pure, unit-tested verdict over the OPERATOR
 * input transcript:
 *   1. it is non-empty after case/whitespace normalisation; and
 *   2. it is related to the expected fixture phrase — either the normalised text
 *      contains both `handshake` and `check`, or at least half of the expected
 *      phrase's tokens are present (recall over the expected tokens, so extra
 *      words do not fail an otherwise correct transcription).
 *
 * Pure by construction: no provider call, no clock, no I/O — which is why this
 * predicate can be tested exhaustively without a live session.
 */

export const HANDSHAKE_EXPECTED_PHRASE = 'VoiceBridge handshake check';

export type HandshakeVerdictReason = 'phrase-contains' | 'token-overlap' | 'empty' | 'unrelated';

export interface HandshakeTranscriptVerdict {
  ok: boolean;
  /** Lowercased, punctuation-stripped, whitespace-collapsed observation. */
  normalised: string;
  /** Expected-phrase tokens present in the observation (recall basis). */
  matchedTokens: string[];
  /** matchedTokens.length / expected token count. */
  overlapRatio: number;
  reason: HandshakeVerdictReason;
}

/**
 * Normalise a transcript for comparison: lowercase, treat any run of
 * non-letter/non-digit characters as a separator (so punctuation, `¿`, `?` and
 * casing cannot decide the verdict), and collapse whitespace.
 */
export function normaliseHandshakeTranscript(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const EXPECTED_TOKENS = normaliseHandshakeTranscript(HANDSHAKE_EXPECTED_PHRASE).split(' ');

/** Evaluate the operator input transcript against the expected phrase. */
export function evaluateHandshakeTranscript(text: unknown): HandshakeTranscriptVerdict {
  const normalised = normaliseHandshakeTranscript(text);
  if (normalised === '') {
    return { ok: false, normalised, matchedTokens: [], overlapRatio: 0, reason: 'empty' };
  }
  const observedTokens = new Set(normalised.split(' '));
  const matchedTokens = EXPECTED_TOKENS.filter((token) => observedTokens.has(token));
  const overlapRatio = matchedTokens.length / EXPECTED_TOKENS.length;

  if (normalised.includes('handshake') && normalised.includes('check')) {
    return { ok: true, normalised, matchedTokens, overlapRatio, reason: 'phrase-contains' };
  }
  if (overlapRatio >= 0.5) {
    return { ok: true, normalised, matchedTokens, overlapRatio, reason: 'token-overlap' };
  }
  return { ok: false, normalised, matchedTokens, overlapRatio, reason: 'unrelated' };
}

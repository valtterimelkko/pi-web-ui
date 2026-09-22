/**
 * Source-turn binding for the model-driven relay (Phase 3, native-primary).
 *
 * The plan's rule: "Bind a tool call to its originating utterance/turn, not
 * whichever final utterance happens to be last when an async tool finishes.
 * Ambiguous provenance holds/refuses; it never guesses a source."
 *
 * A `relay_to_worker` tool call is a DELAYED CALLBACK: the model's turn may
 * finish after further operator speech has arrived. Binding by position (the
 * old `lane.utteranceSeq` read) guessed the latest utterance. Binding here is
 * by CONTENT over the lane's recent final operator utterances:
 *
 *   - a candidate matches when the relay's normalised tokens are CONTAINED in
 *     the candidate's (the semi-verbatim relay is the operator's own words
 *     minus the addressing frame, so containment is the honest relation);
 *   - exactly one match → bound to it;
 *   - two or more matches → ambiguous: the caller refuses, never picks;
 *   - no match, exactly one candidate → bound to it (with one possible source,
 *     attribution is a fact, not a guess);
 *   - no match, several candidates → ambiguous: refuse.
 *
 * Pure and importable anywhere; the mount owns the candidate stream (final
 * operator utterances, approval-channel classes excluded).
 */

/** Same order as the spoken read-back overlap (H3(c)): a shared floor. */
export const RELAY_SOURCE_CONTAINMENT_FLOOR = 0.6;

/** One candidate: a final operator utterance with its stable id. */
export interface SourceUtterance {
  id: number;
  text: string;
}

export type SourceBinding =
  | { kind: 'bound'; utterance: SourceUtterance; containment: number }
  | { kind: 'ambiguous'; candidateIds: number[] }
  | { kind: 'unbound' };

/** Bind a relay to its originating operator utterance, or refuse honestly. */
export function bindRelaySource(relayText: string, utterances: readonly SourceUtterance[]): SourceBinding {
  const relayTokens = tokenise(relayText);
  if (relayTokens.length === 0 || utterances.length === 0) return { kind: 'unbound' };
  const scored = utterances.map((u) => ({ utterance: u, containment: containmentScore(relayTokens, tokenise(u.text)) }));
  const matches = scored.filter((s) => s.containment >= RELAY_SOURCE_CONTAINMENT_FLOOR);
  if (matches.length === 1) {
    return { kind: 'bound', utterance: matches[0].utterance, containment: matches[0].containment };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', candidateIds: matches.map((m) => m.utterance.id) };
  }
  if (utterances.length === 1) {
    return { kind: 'bound', utterance: scored[0].utterance, containment: scored[0].containment };
  }
  return { kind: 'ambiguous', candidateIds: utterances.map((u) => u.id) };
}

/** The share of the relay's tokens that appear in the candidate's tokens. */
function containmentScore(relayTokens: string[], candidateTokens: string[]): number {
  if (relayTokens.length === 0) return 0;
  const present = new Set(candidateTokens);
  const hits = relayTokens.filter((t) => present.has(t)).length;
  return hits / relayTokens.length;
}

function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

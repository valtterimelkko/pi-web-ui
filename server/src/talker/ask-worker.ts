/**
 * The ask-the-worker offer (P18 package C, deliverable 1).
 *
 * The talker's knowledge is a bounded window: "what did the worker find about
 * the retry bug in March?" may simply be outside it. Before this, the honest
 * answer was a dead end — the talker said it could not tell and the operator
 * had to rephrase the question for the worker themselves.
 *
 * Now that dead end becomes a next step, and it reuses the EXISTING
 * confirmation gate rather than adding a mode:
 *
 *   the model offers  →  the harness holds the operator's own question,
 *                        verbatim, as a draft candidate (nothing sent)
 *   the operator says yes → the release branch delivers THAT question, word
 *                        for word — never a paraphrase the model composed
 *
 * The offer is signalled by a fixed, end-anchored tag the model appends to its
 * reply. The tag is INSTRUCTED (the prompt asks for it) but its consequences
 * are MECHANICAL and deliberately narrow:
 *   - it can only ever create a relay CANDIDATE, never a delivery;
 *   - the candidate's text is the operator's utterance, referenced by id in
 *     the verbatim log — the model's own words are never relayed;
 *   - it is honoured only on a turn the harness already classified as a
 *     question the talker was asked to answer (see talker.ts) — an offer
 *     attached to a statement or to a meta-send question creates nothing, so
 *     the gate is not widened by model behaviour.
 *
 * The tag is stripped from what the operator hears, wherever it appears: a
 * protocol marker must never be spoken aloud.
 */

/** The exact tag the prompt asks the model to append when it cannot answer. */
export const ASK_WORKER_MARKER = '[[ask-worker]]';

const MARKER_ANYWHERE = /\[\[\s*ask-worker\s*\]\]/gi;
const MARKER_AT_END = /\[\[\s*ask-worker\s*\]\]\s*$/i;

/**
 * True when the reply OFFERS to ask the worker: the marker must END the reply
 * (trailing whitespace tolerated). A marker buried mid-reply is model noise —
 * it is stripped before speech (below) but it does not create a candidate.
 */
export function isAskWorkerOffer(reply: string): boolean {
  return MARKER_AT_END.test(reply);
}

/**
 * The reply as the operator should hear it: the marker removed. Everything
 * else — the model's own words, including its honest "I can't tell" — is
 * passed through unchanged; the harness never composes this sentence.
 */
export function stripAskWorkerMarker(reply: string): string {
  return reply.replace(MARKER_ANYWHERE, '').trim();
}

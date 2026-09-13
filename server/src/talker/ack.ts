/**
 * Fixed operator-facing acknowledgements for the release path (non-negotiable
 * 7). These are produced mechanically by the harness — never by the model —
 * and only after the delivery adapter has reported its outcome.
 */

/** The exact release acknowledgement. Nothing more, nothing less. */
export const RELEASE_ACK = 'sending that now';

/** Queued behind the worker's current turn (a normal outcome, not an error). */
export const QUEUED_ACK = "Got it — that'll reach the worker after this turn.";

/** Honest failure: never claim a send that did not happen. */
export const REFUSED_ACK = "I couldn't deliver that — it has not reached the worker.";

/** Honest model failure fallback for conversational turns. */
export const MODEL_FAILURE_REPLY = "I couldn't reach my model just then — can you say that again?";

/**
 * Receipt ack (plan §4.1 rule 2): spoken when operator utterances have been
 * recorded but not yet acted on. A receipt — never an agreement, never a
 * send: nothing has been relayed when this is spoken, and the explicit
 * confirmation step still follows.
 */
export const RECEIPT_ACK = 'Noted — still holding that.';

/**
 * Mechanically select the receipt ack from harness state (plan §4.1 rule 2).
 * The only input is how many recorded operator utterances are not yet
 * acknowledged; the model is never an input, so no model behaviour can
 * compose, substitute for, or suppress the receipt. Returns null when
 * nothing is outstanding — no receipt is due.
 */
export function receiptAckFor(unacknowledgedCount: number): string | null {
  return unacknowledgedCount > 0 ? RECEIPT_ACK : null;
}

export function ackForOutcome(outcome: { outcome: string; disclosure?: string; reason?: string }): string {
  if (outcome.outcome === 'delivered') return RELEASE_ACK;
  if (outcome.outcome === 'queued') return QUEUED_ACK;
  return REFUSED_ACK;
}

export function describeOutcome(outcome: { outcome: string; mechanism?: string; disclosure?: string; reason?: string }): string {
  if (outcome.outcome === 'delivered') return `delivered (${outcome.mechanism})`;
  if (outcome.outcome === 'queued') return `queued (${outcome.mechanism})`;
  return `not delivered (${outcome.reason ?? 'unknown reason'})`;
}

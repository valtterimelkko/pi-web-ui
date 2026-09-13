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
 * Spoken when a confirmation-classified utterance arrives and NOTHING is
 * held (finding F2, P7). Before this existed the model answered this dead
 * end and promised a send that could not happen — in a voice surface that
 * promise is a real harm. The harness owns the dead-end transition and
 * answers mechanically: the truth (nothing held), the way out (say the
 * instruction), and no send promised. Never a model call.
 */
export const NOTHING_PENDING_ACK =
  "Nothing is held right now, so there is nothing to send. Say the instruction and I'll hold it for your go-ahead.";

/**
 * Spoken when a cancellation-classified utterance arrives and NOTHING is
 * held (the F2 neighbouring dead-end, checked and closed in the same
 * package): the model could claim a cancellation that never happened, so
 * this transition is mechanical too. Honest: there was nothing to cancel.
 */
export const NOTHING_TO_CANCEL_ACK = 'Nothing is held right now — there was nothing to cancel.';

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

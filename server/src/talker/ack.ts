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

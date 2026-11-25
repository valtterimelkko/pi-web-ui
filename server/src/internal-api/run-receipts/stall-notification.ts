/**
 * Operator-facing wording for a watchdog-terminalised run (2026-09-15).
 *
 * Why this is a module rather than a string literal at the notification call
 * site: the wording carries claims about capacity and about what happened, and
 * on 2026-09-15 it carried three wrong ones for a wake that never ran (see
 * `stall-notification.test.ts`). Making it a pure function makes the claims
 * reviewable and testable.
 *
 * The distinction that matters:
 *
 *  - `no_activity` — the run never produced a single observable unit of work.
 *    For a watch wake that is a LOST WAKE: the message was never delivered and
 *    nothing ran. Telling the operator "no action required" is actively unhelpful;
 *    the wake still matters, so the notice says to re-dispatch.
 *  - `idle` / `absolute` — a turn really was executing and stopped, or hit the
 *    ceiling. Runtime cessation is unconfirmed, so the admission slot is held
 *    (drained, then quarantined as capacity debt) and the notice says so.
 *
 * Lane A (W1) correction: absence of observed activity is NOT proof that nothing
 * executed. A message can sit in a runtime-side FIFO queue and run minutes
 * later (audit §2A: eight Devin wakes were declared "never started" and then
 * executed). The receipt therefore carries QUEUE-DELIVERY evidence, and the
 * notice is only allowed to claim non-execution when that evidence proves it:
 *
 *  - `cancelled_before_dispatch` — the item was provably removed from the queue
 *    before dispatch. Non-execution is proven: re-dispatch is safe (with a NEW
 *    idempotency key, because a same-key replay returns this terminal receipt).
 *  - `unconfirmed` / `queued` at decision time — delivery cannot be established.
 *    The notice must not advise a retry that could duplicate real work.
 *  - `late_terminal_observed` — recorded as never dispatched and then a terminal
 *    event arrived anyway. Both facts are reported; nothing is smoothed over.
 */

import type { RunDeliveryState } from '../types.js';

export interface StallNotificationInput {
  runId: string;
  sessionId?: string;
  status?: string;
  /** C2 (contract 1.57.0): NEVER_STARTED decisions word their own notice. */
  errorCode?: string;
  liveness?: {
    /** Present on the real receipt; the watchdog block also carries it. */
    idleTimeoutMs?: number;
    watchdog?: { reason?: string; idleTimeoutMs?: number; absoluteTimeoutMs?: number; startWindowMs?: number };
    cessation?: { state?: string; basis?: string };
    /** Lane A (W1): queue-delivery evidence, when the runtime has a queue. */
    delivery?: { state?: RunDeliveryState | string; basis?: string; observedAt?: string };
    /** Lane A: a late terminal observation is why delivery was re-labelled. */
    terminalObservations?: Array<{ late?: boolean; observedAt?: string }>;
  };
  outputEvidence?: { assistantMessages?: number; toolCalls?: number; disposition?: string };
}

export interface StallNotification {
  title: string;
  body: string;
}

/**
 * Whether the watchdog stopped a run that never executed anything.
 *
 * `no_activity` is set by the watchdog only when the idle window elapsed with no
 * eligible activity event and no output evidence ever observed — see
 * `neverProducedWork` in `run-receipt-manager.ts`. It is a statement about
 * OBSERVED activity, not by itself proof of non-delivery.
 */
export function isLostWake(receipt: StallNotificationInput): boolean {
  return receipt.liveness?.watchdog?.reason === 'no_activity';
}

/** Lane A: the states in which non-execution is proven (safe to re-dispatch). */
function provenNeverDispatched(state: string | undefined): boolean {
  return state === 'cancelled_before_dispatch';
}

/** Lane A: the states in which delivery is unknown (never advise a retry). */
function deliveryUnknown(state: string | undefined): boolean {
  return state === 'queued' || state === 'unconfirmed' || state === undefined;
}

/** Build the operator notice for a terminalised run. */
export function buildStallNotification(receipt: StallNotificationInput): StallNotification {
  const { runId } = receipt;
  const sessionSuffix = receipt.sessionId ? ` for session ${receipt.sessionId}` : '';
  const windowMs = receipt.liveness?.watchdog?.idleTimeoutMs ?? receipt.liveness?.idleTimeoutMs;
  const delivery = receipt.liveness?.delivery;
  const deliveryState = delivery?.state;

  // Lane A (W1): a terminal event arrived after the run was decided as never
  // dispatched / cancelled. Report the contradiction; do not pick a story.
  if (deliveryState === 'late_terminal_observed') {
    const lateAt = receipt.liveness?.terminalObservations?.find((o) => o.late)?.observedAt ?? delivery?.observedAt;
    return {
      title: `⚠️ Delivery evidence contradictory (NEVER_STARTED later completed): ${runId}`,
      body:
        `Run ${runId}${sessionSuffix} was terminalised as never dispatched, and a terminal observation then ` +
        `arrived${lateAt ? ` at ${lateAt}` : ''}. The evidence is contradictory: the receipt's terminal status was ` +
        `not reopened and the late observation is kept alongside the decision-time evidence. Do not re-dispatch ` +
        `until the session transcript has been checked — work may already have run under this message.`,
    };
  }

  // Lane A (W1): delivery evidence, not the error code, is what proves
  // non-execution. A queued item the runtime provably removed can never have
  // run, whatever status the terminal transition chose.
  if (provenNeverDispatched(deliveryState)) {
    return {
      title: `⚠️ Message never executed — removed from the queue before dispatch: ${runId}`,
      body:
        `Run ${runId}${sessionSuffix} was removed from the session's follow-up queue before it could dispatch ` +
        `(basis \`${delivery?.basis ?? 'targeted_removal'}\`), so the message provably never reached the ` +
        `session and no work ran under this run. Only this run's admission slot was released; the session's ` +
        `live turn and any other queued items were untouched. If the work still matters, re-dispatch it — ` +
        `use a NEW idempotency key, because a replay of the same key returns this terminal receipt instead ` +
        `of running again.`,
    };
  }

  // C2 (contract 1.57.0): a run the START watchdog stopped never began. It
  // shares `no_activity` with the lost wake, but the deciding window is the
  // start window, and the honest claim depends on what delivery evidence proves.
  if (receipt.errorCode === 'NEVER_STARTED') {
    const startWindowMs = receipt.liveness?.watchdog?.startWindowMs;
    if (deliveryState === 'queued' && receipt.liveness?.watchdog?.reason === 'absolute') {
      return {
        title: `⚠️ Queued message expired at the absolute ceiling — delivery unconfirmed: ${runId}`,
        body:
          `Run ${runId}${sessionSuffix} was still waiting in the session's follow-up queue when the acceptance ` +
          `ceiling (${receipt.liveness?.watchdog?.absoluteTimeoutMs ?? windowMs ?? 'the ceiling'}ms) ended this ` +
          `run. It has not been shown to run, and it has not been shown to be gone: the queue entry could not be ` +
          `removed or its removal could not be confirmed. Do not re-dispatch until the session transcript has been ` +
          `checked — a blind retry may duplicate the message.`,
      };
    }
    return {
      title: `⚠️ Run never started (NEVER_STARTED) — delivery unconfirmed: ${runId}`,
      body:
        `Run ${runId}${sessionSuffix} was dispatched and then terminalised after ` +
        `${startWindowMs ?? 'the start window'}ms with no runtime activity of any kind observed. That absence is ` +
        `not proof that the message never executed: it may still be held in a runtime queue. Delivery is ` +
        `unconfirmed, so inspect the session transcript before retrying; the receipt is recorded as failed ` +
        `NEVER_STARTED and the run's watchers were notified.`,
    };
  }

  if (isLostWake(receipt)) {
    // Lane A: the same absence-of-activity rule, but the honest claim depends on
    // the delivery evidence. An unconfirmed queue wait is never safe to retry.
    if (deliveryUnknown(deliveryState)) {
      return {
        title: `⚠️ Wake unconfirmed (no activity observed): ${runId}`,
        body:
          `Run ${runId}${sessionSuffix} ended after ${windowMs ?? 'the idle window'}ms with no activity of any kind ` +
          `ever observed — no assistant messages and no tool calls. Delivery is unconfirmed: the message may be ` +
          `held in a runtime queue or may never have arrived, and neither is proven. Check the session transcript ` +
          `before re-dispatching; a blind retry may duplicate real work.`,
      };
    }
  }

  return {
    title: `⚠️ Run quarantined (TURN_STALLED): ${runId}`,
    body:
      `Run ${runId}${sessionSuffix} was terminalised by the watchdog (reason: ` +
      `${receipt.liveness?.watchdog?.reason ?? 'unknown'}) without confirmed runtime cessation. The ` +
      `admission slot is held while the runtime is polled for quiescence; if quiescence is confirmed it ` +
      `is released, and if it is never confirmed the slot is held as capacity debt until restart or ` +
      `operator recovery. No action required unless you suspect orphan processes.`,
  };
}

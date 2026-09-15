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
 */

export interface StallNotificationInput {
  runId: string;
  sessionId?: string;
  status?: string;
  liveness?: {
    /** Present on the real receipt; the watchdog block also carries it. */
    idleTimeoutMs?: number;
    watchdog?: { reason?: string; idleTimeoutMs?: number };
    cessation?: { state?: string; basis?: string };
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
 * `neverProducedWork` in `run-receipt-manager.ts`.
 */
export function isLostWake(receipt: StallNotificationInput): boolean {
  return receipt.liveness?.watchdog?.reason === 'no_activity';
}

/** Build the operator notice for a terminalised run. */
export function buildStallNotification(receipt: StallNotificationInput): StallNotification {
  const { runId } = receipt;
  const sessionSuffix = receipt.sessionId ? ` for session ${receipt.sessionId}` : '';
  const windowMs = receipt.liveness?.watchdog?.idleTimeoutMs ?? receipt.liveness?.idleTimeoutMs;

  if (isLostWake(receipt)) {
    return {
      title: `⚠️ Wake lost (never executed): ${runId}`,
      body:
        `Run ${runId}${sessionSuffix} was accepted and then terminalised by the watchdog after ` +
        `${windowMs ?? 'the idle window'}ms with no activity of any kind ever observed — no assistant ` +
        `messages and no tool calls. The message never reached the session and no work ran under this ` +
        `run, so it is recorded as a failed run for capacity accounting only. There is nothing to clean ` +
        `up and no orphan process to look for; if the wake still matters, re-dispatch it.`,
    };
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

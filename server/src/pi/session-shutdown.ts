import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('SessionShutdown');

/** Reasons the SDK's `SessionShutdownEvent` supports (pi-coding-agent 0.87.1). */
export type SessionShutdownReason = 'quit' | 'reload' | 'new' | 'resume' | 'fork';

export interface SessionShutdownInit {
  reason: SessionShutdownReason;
  /** Destination session file when shutting down due to session replacement. */
  targetSessionFile?: string;
}

/**
 * Bound for one `session_shutdown` emission. Mirrors background-shell's own
 * 5 s teardown budget: handlers get a bounded chance to settle (kill background
 * processes, clear timers, save state) before the SDK object is disposed, but a
 * hanging handler can never stall a dispose path indefinitely.
 */
export const SESSION_SHUTDOWN_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending emission bound must never keep the process alive by itself.
    timer.unref?.();
  });
}

/**
 * Emit `session_shutdown` to a session's extensions through the SDK's public
 * `AgentSession.extensionRunner` (B5, plan finding F1).
 *
 * The SDK's own teardown order is emit → dispose (`teardownCurrent`,
 * `AgentSessionRuntime.dispose`), because `AgentSession.dispose()` invalidates
 * the runner without emitting the event — Pi Web UI manages raw AgentSessions,
 * so until B5 nothing fired the event on dispose.
 *
 * Contract:
 * - resolves `false` when the session has no runner or no `session_shutdown`
 *   handlers (cheap no-op; the caller disposes immediately);
 * - resolves `true` when the event was emitted, bounded by `timeoutMs`
 *   (default 5 s); a hanging emission loses the race and disposal proceeds;
 * - NEVER rejects and NEVER throws — a failing emission must not block or
 *   break any dispose path (handler exceptions are caught inside the SDK's
 *   `emit`, and anything else is caught here and logged).
 */
export async function emitSessionShutdown(
  session: AgentSession,
  init: SessionShutdownInit,
  timeoutMs: number = SESSION_SHUTDOWN_TIMEOUT_MS,
): Promise<boolean> {
  let runner: { hasHandlers(eventType: string): boolean; emit(event: unknown): Promise<unknown> } | undefined;
  try {
    runner = (session as { extensionRunner?: typeof runner }).extensionRunner;
  } catch (error) {
    logger.warn(`session_shutdown: reading extensionRunner failed (${error instanceof Error ? error.message : String(error)}); proceeding without emission`);
    return false;
  }
  if (!runner || typeof runner.hasHandlers !== 'function' || !runner.hasHandlers('session_shutdown')) {
    return false;
  }
  const event: { type: 'session_shutdown'; reason: SessionShutdownReason; targetSessionFile?: string } = {
    type: 'session_shutdown',
    reason: init.reason,
  };
  if (init.targetSessionFile !== undefined) event.targetSessionFile = init.targetSessionFile;
  try {
    const emission = runner.emit(event);
    // The SDK catches handler exceptions into its error listeners, so this
    // promise practically never rejects; the guard only prevents an unhandled
    // rejection if the emission settles after we have stopped awaiting it.
    if (emission && typeof (emission as Promise<unknown>).catch === 'function') {
      (emission as Promise<unknown>).catch(() => {});
    }
    const settled = await Promise.race([
      emission,
      delay(timeoutMs).then(() => Symbol.for('session-shutdown.timeout') as unknown as unknown),
    ]);
    if (settled === (Symbol.for('session-shutdown.timeout') as unknown)) {
      logger.warn(
        `session_shutdown (${init.reason}) handlers did not settle within ${timeoutMs}ms; proceeding with disposal`,
      );
    }
    return true;
  } catch (error) {
    logger.error(
      `session_shutdown (${init.reason}) emission failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }
}

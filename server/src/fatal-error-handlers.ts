/**
 * Process-level fatal-error handlers (uncaughtException / unhandledRejection).
 *
 * Extracted from server/src/index.ts into a factory so the behaviour is
 * unit-testable in isolation — the tests call the returned handler functions
 * directly with injected deps, so they never kill the test runner or boot the
 * server.
 *
 * Behaviour:
 * - Both handlers log message + full stack + a context snapshot (e.g. active
 *   session count) via the central logger, turning an "it just died" into a
 *   one-line diagnosis.
 * - `uncaughtException` additionally triggers graceful shutdown. Per Node best
 *   practice the process must not continue in a potentially-corrupt state, so
 *   it mirrors the existing SIGTERM/SIGINT shutdown path.
 * - `unhandledRejection` is logged only (no shutdown), per the plan.
 */

import type { Logger } from './logging/logger.js';

export interface FatalErrorDeps {
  /** Central logger used to emit the fatal record. */
  logger: Logger;
  /** Graceful shutdown; invoked for uncaughtException. */
  shutdown: () => void;
  /** Cheap context snapshot appended to the log (e.g. active session count). */
  getContext?: () => Record<string, unknown>;
}

export interface FatalErrorHandlers {
  uncaughtException(error: unknown): void;
  unhandledRejection(reason: unknown): void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : safeStringify(value));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createFatalErrorHandlers(deps: FatalErrorDeps): FatalErrorHandlers {
  const { logger, shutdown, getContext } = deps;

  const contextSnapshot = (): Record<string, unknown> => {
    try {
      return getContext?.() ?? {};
    } catch {
      return {};
    }
  };

  return {
    uncaughtException(error: unknown): void {
      const err = toError(error);
      logger.errorObject('uncaughtException', err, contextSnapshot());
      // Graceful exit — never continue in a potentially-corrupt state.
      shutdown();
    },

    unhandledRejection(reason: unknown): void {
      const err = toError(reason);
      logger.errorObject('unhandledRejection', err, contextSnapshot());
      // Logged only; do not shut down.
    },
  };
}

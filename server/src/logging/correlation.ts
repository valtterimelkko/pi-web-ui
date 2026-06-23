/**
 * Request correlation context for the central logger.
 *
 * A lightweight AsyncLocalStorage carrying a per-prompt `requestId` / `sessionId`
 * / `runtime` so every log line emitted during a prompt's lifecycle is stamped
 * with the same ids — letting an agent `grep <requestId>` to reconstruct the
 * whole causal chain in one pass (the single biggest troubleshooting token-saver).
 *
 * The logger reads this context at emit time (see ./logger.ts). The Internal API
 * prompt path and the WebSocket prompt path establish it via {@link withCorrelation}
 * (Task 5), reusing this single seam rather than a parallel scheme.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface LogContext {
  /** Correlation id for a single prompt/turn. */
  requestId?: string;
  /** Pi Web UI internal session id. */
  sessionId?: string;
  /** Runtime family: pi | claude | opencode | antigravity. */
  runtime?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Current correlation context, if any (undefined outside a withCorrelation block). */
export function getCorrelationContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` within a correlation context. Context is merged with any enclosing
 * context (child scopes inherit + override parent keys) and propagates across
 * `await` boundaries within `fn`. Works for both sync and async `fn`.
 *
 * @example
 * const result = await withCorrelation({ requestId, sessionId, runtime }, () =>
 *   handleSendPrompt(...)
 * );
 */
export function withCorrelation<T>(context: LogContext, fn: () => T): T {
  const parent = storage.getStore();
  const merged: LogContext = { ...(parent ?? {}), ...context };
  return storage.run(merged, fn);
}

/** Generate a fresh per-prompt correlation id (e.g. `req_<uuid>`). */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

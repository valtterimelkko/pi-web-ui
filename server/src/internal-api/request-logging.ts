/**
 * Internal API request-logging middleware (Task 13).
 *
 * Emits one debug log line per request with method, path, status, duration, and
 * a per-request `requestId` — so an agent can confirm (at LOG_LEVEL=debug) that
 * its API call even arrived, and tie it to the same requestId seen on prompt
 * correlation lines. Extracted into its own module so it is unit-testable
 * without booting the server.
 *
 * - Never logs request bodies or headers (no secrets/tokens).
 * - Establishes a correlation context (requestId) so prompt-path logs share it.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Logger } from '../logging/logger.js';
import { withCorrelation, newRequestId } from '../logging/correlation.js';

type Next = () => void;

export function createRequestLoggingMiddleware(logger: Logger) {
  return function requestLoggingMiddleware(req: IncomingMessage, res: ServerResponse, next: Next): void {
    const requestId = newRequestId();
    const start = Date.now();
    let status = 0;
    let logged = false;

    // Capture the response status by intercepting writeHead (every route sends
    // status via res.writeHead through sendJson / createSSEStream).
    const origWriteHead = res.writeHead.bind(res) as typeof res.writeHead;
    (res as unknown as { writeHead: typeof res.writeHead }).writeHead = ((code: number, ...rest: unknown[]) => {
      status = code;
      return origWriteHead(code as never, ...(rest as never[]));
    }) as typeof res.writeHead;

    const requestLogger = logger.child({ requestId });

    const logOnce = (): void => {
      if (logged) return;
      logged = true;
      const path = (req.url || '/').split('?')[0];
      requestLogger.debug(
        `[InternalAPI] ${req.method || '-'} ${path} → ${status || '-'} (${Date.now() - start}ms)`,
      );
    };

    res.on('finish', logOnce);
    res.on('close', logOnce);

    // Establish the per-request correlation so prompt-path logs (and the
    // request log's requestId via the child logger) share one id.
    withCorrelation({ requestId }, next);
  };
}

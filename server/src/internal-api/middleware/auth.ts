/**
 * Internal API Authentication Middleware
 *
 * Validates Bearer token against the configured API key.
 * Since the API is only exposed over a Unix socket (or 127.0.0.1),
 * this is defense-in-depth: even if the socket were misconfigured,
 * the token must match.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { ApiError } from '../types.js';
import { ErrorCode } from '../error-codes.js';

export function createAuthMiddleware(apiKey: string) {
  return function authMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void {
    // Allow health check without auth (useful for monitoring)
    if (req.url === '/api/v1/health' && req.method === 'GET') {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Missing Authorization header');
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Authorization header must be: Bearer <token>');
      return;
    }

    const token = parts[1];
    if (token !== apiKey) {
      sendError(res, 401, ErrorCode.UNAUTHORIZED, 'Invalid API key');
      return;
    }

    next();
  };
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  error: string,
): void {
  const body: ApiError = { error, code };
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export { type ApiError } from '../types.js';

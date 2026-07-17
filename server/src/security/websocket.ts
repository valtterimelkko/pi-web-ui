import type { IncomingMessage } from 'http';
import { config } from '../config.js';
import { verifyToken, type JwtPayload } from './auth.js';
import { validateCsrfToken } from './csrf.js';
import { wsUpgradeLimiter } from './rate-limit.js';

export interface WsAuthResult {
  success: boolean;
  user?: JwtPayload;
  error?: string;
}

export function validateOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
}

/**
 * The single pre-upgrade decision applied to every accepted WebSocket path
 * (`/ws`, `/ws/sessions/:id`, `/ws/session/:id`, `/ws/terminal`). Runs BEFORE
 * `handleUpgrade`, so rejected requests never create a WebSocket, never emit
 * `connection`, and never allocate session/terminal resources.
 *
 * Checks, in order: (1) allowed Origin, (2) valid cookie JWT, (3) upgrade rate
 * limit. This is cookie authentication at upgrade time; it is distinct from the
 * post-connection CSRF handshake (`authenticateWebSocket` with a CSRF token),
 * which is preserved unchanged.
 */
export interface WsUpgradeDecision {
  allowed: boolean;
  statusCode: number;
  reason: 'origin' | 'auth' | 'rate' | 'ok';
  user?: JwtPayload;
}

export function decideWsUpgrade(req: IncomingMessage): WsUpgradeDecision {
  // 1. Origin must be present and allow-listed.
  if (!validateOrigin(req.headers.origin)) {
    return { allowed: false, statusCode: 403, reason: 'origin' };
  }

  // 2. Cookie JWT must authenticate (origin is re-checked inside, idempotently).
  const auth = authenticateWebSocket(req);
  if (!auth.success || !auth.user) {
    return { allowed: false, statusCode: 401, reason: 'auth' };
  }

  // 3. Upgrade rate limit, keyed by the authenticated user.
  if (!wsUpgradeLimiter.check(auth.user.userId)) {
    return { allowed: false, statusCode: 429, reason: 'rate' };
  }

  return { allowed: true, statusCode: 101, reason: 'ok', user: auth.user };
}

export function extractJwtFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)accessToken=([^;]+)/);
  return match ? match[1] : null;
}

export function authenticateWebSocket(
  req: IncomingMessage,
  csrfToken?: string
): WsAuthResult {
  // 1. Validate origin
  const origin = req.headers.origin;
  if (!validateOrigin(origin)) {
    return { success: false, error: 'Origin not allowed' };
  }

  // 2. Extract and verify JWT from cookie
  const cookieHeader = req.headers.cookie;
  const token = extractJwtFromCookie(cookieHeader);
  if (!token) {
    return { success: false, error: 'No authentication token' };
  }

  const payload = verifyToken(token);
  if (!payload) {
    return { success: false, error: 'Invalid or expired token' };
  }

  // 3. Validate CSRF token if provided (for first message after connection)
  if (csrfToken) {
    if (!validateCsrfToken(payload.userId, csrfToken)) {
      return { success: false, error: 'Invalid CSRF token' };
    }
  }

  return { success: true, user: payload };
}

export function createWsAuthMessageHandler(userId: string) {
  return (message: { type: string; csrfToken?: string }): WsAuthResult => {
    if (message.type !== 'auth' || !message.csrfToken) {
      return { success: false, error: 'Expected auth message with CSRF token' };
    }
    
    if (!validateCsrfToken(userId, message.csrfToken)) {
      return { success: false, error: 'Invalid CSRF token' };
    }
    
    return { success: true, user: { userId, iat: Date.now() / 1000, exp: 0 } };
  };
}

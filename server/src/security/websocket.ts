import type { IncomingMessage } from 'http';
import { config } from '../config.js';
import { verifyToken, type JwtPayload } from './auth.js';
import { validateCsrfToken } from './csrf.js';

export interface WsAuthResult {
  success: boolean;
  user?: JwtPayload;
  error?: string;
}

export function validateOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
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

import crypto from 'crypto';

interface CsrfTokenData {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const tokenStore = new Map<string, CsrfTokenData>();
const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Cleanup expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of tokenStore.entries()) {
    if (data.expiresAt < now) {
      tokenStore.delete(key);
    }
  }
}, 60 * 1000);

export function generateCsrfToken(sessionId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  tokenStore.set(sessionId, {
    token,
    createdAt: now,
    expiresAt: now + TOKEN_EXPIRY_MS,
  });
  return token;
}

export function validateCsrfToken(sessionId: string, providedToken: string): boolean {
  const data = tokenStore.get(sessionId);
  if (!data) return false;
  if (Date.now() > data.expiresAt) {
    tokenStore.delete(sessionId);
    return false;
  }
  
  // Timing-safe comparison requires equal length buffers
  if (data.token.length !== providedToken.length) {
    return false;
  }
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(data.token, 'hex'),
      Buffer.from(providedToken, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Check if a CSRF token exists for a session.
 * Used to determine if client needs to refresh their token.
 */
export function hasCsrfToken(sessionId: string): boolean {
  const data = tokenStore.get(sessionId);
  if (!data) return false;
  return Date.now() <= data.expiresAt;
}

export function invalidateCsrfToken(sessionId: string): void {
  tokenStore.delete(sessionId);
}

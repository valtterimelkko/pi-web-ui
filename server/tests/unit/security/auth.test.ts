import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateSessionToken,
  verifyToken,
} from '../../../src/security/auth.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Auth', () => {
  describe('generateSessionToken', () => {
    it('should generate a JWT session token', () => {
      const token = generateSessionToken('123');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('verifyToken', () => {
    it('should verify a valid token and return payload', () => {
      const token = generateSessionToken('123');
      const payload = verifyToken(token);
      expect(payload).not.toBeNull();
      expect(payload?.userId).toBe('123');
      expect(payload?.iat).toBeDefined();
      expect(payload?.exp).toBeDefined();
    });

    it('should return null for an invalid token', () => {
      const payload = verifyToken('invalid.token.here');
      expect(payload).toBeNull();
    });

    it('should return null for a malformed token', () => {
      const payload = verifyToken('not-a-valid-jwt');
      expect(payload).toBeNull();
    });
  });
  describe('persistent revocation', () => {
    it('keeps a logged-out token revoked after the auth module is reloaded', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'auth-session-state-'));
      const statePath = path.join(dir, 'auth-session-state.json');
      vi.stubEnv('AUTH_SESSION_STATE_PATH', statePath);
      try {
        vi.resetModules();
        const beforeRestart = await import('../../../src/security/auth.js');
        const token = beforeRestart.generateSessionToken('persistent-user');
        expect(beforeRestart.verifyToken(token)).not.toBeNull();
        beforeRestart.revokeSessionTokens('persistent-user');
        expect(beforeRestart.verifyToken(token)).toBeNull();

        vi.resetModules();
        const afterRestart = await import('../../../src/security/auth.js');
        expect(afterRestart.verifyToken(token)).toBeNull();
        const replacement = afterRestart.generateSessionToken('persistent-user');
        expect(afterRestart.verifyToken(replacement)).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

});

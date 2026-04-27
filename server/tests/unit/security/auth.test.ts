import { describe, it, expect } from 'vitest';
import {
  generateSessionToken,
  verifyToken,
} from '../../../src/security/auth.js';

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
});

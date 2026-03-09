import { describe, it, expect } from 'vitest';
import {
  generateAccessToken,
  generateRefreshToken,
  generateTokens,
  verifyToken,
  type JwtPayload,
} from '../../../src/security/auth.js';

describe('Auth', () => {
  describe('generateAccessToken', () => {
    it('should generate a JWT access token', () => {
      const token = generateAccessToken('123');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('generateRefreshToken', () => {
    it('should generate a JWT refresh token', () => {
      const token = generateRefreshToken('123');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('generateTokens', () => {
    it('should generate both access and refresh tokens', () => {
      const tokens = generateTokens('123');
      expect(tokens).toBeDefined();
      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
      expect(tokens.expiresIn).toBeDefined();
      expect(typeof tokens.expiresIn).toBe('number');
      expect(tokens.accessToken.split('.')).toHaveLength(3);
      expect(tokens.refreshToken.split('.')).toHaveLength(3);
    });
  });

  describe('verifyToken', () => {
    it('should verify a valid token and return payload', () => {
      const token = generateAccessToken('123');
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

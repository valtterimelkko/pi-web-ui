import { describe, it, expect } from 'vitest';
import {
  validateBody,
  validateQuery,
  loginSchema,
  refreshTokenSchema,
  newSessionSchema,
  switchSessionSchema,
  promptSchema,
} from '../../../src/security/input-validation.js';
import type { Request, Response, NextFunction } from 'express';

describe('Input Validation', () => {
  describe('Schema Validation', () => {
    describe('loginSchema', () => {
      it('should validate correct login data', () => {
        const result = loginSchema.safeParse({ password: 'secret123' });
        expect(result.success).toBe(true);
      });

      it('should reject empty password', () => {
        const result = loginSchema.safeParse({ password: '' });
        expect(result.success).toBe(false);
      });

      it('should reject missing password', () => {
        const result = loginSchema.safeParse({});
        expect(result.success).toBe(false);
      });
    });

    describe('refreshTokenSchema', () => {
      it('should validate correct refresh token data', () => {
        const result = refreshTokenSchema.safeParse({ refreshToken: 'some-token' });
        expect(result.success).toBe(true);
      });

      it('should reject empty refresh token', () => {
        const result = refreshTokenSchema.safeParse({ refreshToken: '' });
        expect(result.success).toBe(false);
      });
    });

    describe('newSessionSchema', () => {
      it('should validate session with all fields', () => {
        const result = newSessionSchema.safeParse({
          cwd: '/home/user',
          name: 'Test Session',
        });
        expect(result.success).toBe(true);
      });

      it('should validate empty session data', () => {
        const result = newSessionSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('should reject name longer than 100 characters', () => {
        const result = newSessionSchema.safeParse({
          name: 'a'.repeat(101),
        });
        expect(result.success).toBe(false);
      });
    });

    describe('switchSessionSchema', () => {
      it('should validate correct session path', () => {
        const result = switchSessionSchema.safeParse({
          sessionPath: '/path/to/session',
        });
        expect(result.success).toBe(true);
      });

      it('should reject empty session path', () => {
        const result = switchSessionSchema.safeParse({ sessionPath: '' });
        expect(result.success).toBe(false);
      });
    });

    describe('promptSchema', () => {
      it('should validate correct prompt data', () => {
        const result = promptSchema.safeParse({
          sessionId: 'session-123',
          message: 'Hello, world!',
        });
        expect(result.success).toBe(true);
      });

      it('should validate prompt with images', () => {
        const result = promptSchema.safeParse({
          sessionId: 'session-123',
          message: 'What is in this image?',
          images: [
            {
              type: 'image',
              data: 'base64data',
              mimeType: 'image/png',
            },
          ],
        });
        expect(result.success).toBe(true);
      });

      it('should reject empty sessionId', () => {
        const result = promptSchema.safeParse({
          sessionId: '',
          message: 'Hello',
        });
        expect(result.success).toBe(false);
      });

      it('should reject empty message', () => {
        const result = promptSchema.safeParse({
          sessionId: 'session-123',
          message: '',
        });
        expect(result.success).toBe(false);
      });

      it('should reject message longer than 100000 characters', () => {
        const result = promptSchema.safeParse({
          sessionId: 'session-123',
          message: 'a'.repeat(100001),
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('validateBody middleware', () => {
    it('should call next() for valid data', () => {
      const middleware = validateBody(loginSchema);
      const req = { body: { password: 'secret' } } as Request;
      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should return 400 for invalid data', () => {
      const middleware = validateBody(loginSchema);
      const req = { body: { password: '' } } as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation error',
        })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('validateQuery middleware', () => {
    it('should call next() for valid query data', () => {
      const middleware = validateQuery(loginSchema);
      const req = { query: { password: 'secret' } } as unknown as Request;
      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should return 400 for invalid query data', () => {
      const middleware = validateQuery(loginSchema);
      const req = { query: { password: '' } } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

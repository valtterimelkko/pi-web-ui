import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import authRouter from '../../../src/routes/auth.js';
import { generateSessionToken } from '../../../src/security/auth.js';
import { validateCsrfToken } from '../../../src/security/csrf.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('auth routes', () => {
  describe('GET /api/auth/me', () => {
    it('returns a fresh CSRF token for an authenticated cookie session', async () => {
      const app = createApp();
      const token = generateSessionToken('default-user');

      const response = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`accessToken=${token}`])
        .expect(200);

      expect(response.body.user).toEqual({ id: 'default-user' });
      expect(response.body.csrfToken).toEqual(expect.any(String));
      expect(response.headers['x-csrf-token']).toBe(response.body.csrfToken);
      expect(validateCsrfToken('default-user', response.body.csrfToken)).toBe(true);
    });
  });
});

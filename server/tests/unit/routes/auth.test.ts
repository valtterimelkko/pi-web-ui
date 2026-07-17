import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import authRouter from '../../../src/routes/auth.js';
import { config } from '../../../src/config.js';
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

  // S5: bcrypt hash backward-compatibility + plaintext-rejection invariants.
  // The hash below was generated with bcrypt 5.1.1 ($2b$) and must keep
  // verifying after the bcrypt 6 upgrade — no plaintext migration, no reduced
  // work factor, no accepted malformed hash.
  describe('POST /api/auth/login — bcrypt compatibility (S5)', () => {
    const BCRYPT5_HASH = '$2b$10$9wObGnTeEf1SZKtR8aV0QOH358PtR7M9qlcxYUfKbVvfiIM62RHB2';
    const CORRECT = 'correct-horse-battery-staple';
    let origPassword: string;
    let origNodeEnv: string;

    beforeEach(() => {
      origPassword = config.authPassword;
      origNodeEnv = config.nodeEnv;
    });
    afterEach(() => {
      config.authPassword = origPassword;
      config.nodeEnv = origNodeEnv;
    });

    it('authenticates against an existing bcrypt-5 $2b$ hash with the correct password', async () => {
      config.authPassword = BCRYPT5_HASH;
      config.nodeEnv = 'production';
      const res = await request(createApp()).post('/api/auth/login').send({ password: CORRECT });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.csrfToken).toEqual(expect.any(String));
    });

    it('rejects the correct-shaped $2b$ hash with the wrong password (401)', async () => {
      config.authPassword = BCRYPT5_HASH;
      config.nodeEnv = 'production';
      const res = await request(createApp()).post('/api/auth/login').send({ password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body.success).toBeFalsy();
    });

    it('rejects a malformed hash and grants no session', async () => {
      config.authPassword = '$2b$not-a-valid-bcrypt-hash';
      config.nodeEnv = 'production';
      const res = await request(createApp()).post('/api/auth/login').send({ password: CORRECT });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.success).toBeFalsy();
    });

    it('rejects a plaintext AUTH_PASSWORD in production with 500 (no plaintext auth)', async () => {
      config.authPassword = 'plain-text-password';
      config.nodeEnv = 'production';
      const res = await request(createApp()).post('/api/auth/login').send({ password: 'plain-text-password' });
      expect(res.status).toBe(500);
      expect(res.body.success).toBeFalsy();
    });
  });
});

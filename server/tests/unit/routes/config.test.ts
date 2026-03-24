import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import configRoutes from '../../../src/routes/config.js';

// Mock auth middleware
vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  },
}));

// Mock config
vi.mock('../../../src/config.js', () => ({
  config: {
    nodeEnv: 'development',
    port: 3000,
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    allowedOrigins: ['http://localhost:5173'],
    rateLimitWindowMs: 900000,
    rateLimitMax: 100,
    piAgentDir: '/root/.pi/agent',
    sessionDir: undefined,
  },
}));

describe('Config Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/config', configRoutes);
    
    // Reset env for each test
    vi.stubEnv('JWT_SECRET', undefined);
    vi.stubEnv('CSRF_SECRET', undefined);
    vi.stubEnv('AUTH_PASSWORD', undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('GET /api/config', () => {
    it('should return safe configuration', async () => {
      const response = await request(app).get('/api/config');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('port');
      expect(response.body).toHaveProperty('nodeEnv');
      expect(response.body).toHaveProperty('allowedOrigins');
      // Should NOT have secrets
      expect(response.body).not.toHaveProperty('jwtSecret');
      expect(response.body).not.toHaveProperty('authPassword');
    });
  });

  describe('GET /api/config/validate', () => {
    it('should return validation result', async () => {
      const response = await request(app).get('/api/config/validate');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('valid');
      expect(response.body).toHaveProperty('issues');
      expect(response.body).toHaveProperty('warnings');
      expect(response.body).toHaveProperty('config');
    });

    it('should include config metadata without secrets', async () => {
      const response = await request(app).get('/api/config/validate');
      
      expect(response.body.config).toHaveProperty('hasJwtSecret');
      expect(response.body.config).toHaveProperty('hasCsrfSecret');
      expect(response.body.config).toHaveProperty('hasAuthPassword');
      expect(response.body.config).toHaveProperty('authPasswordIsHash');
    });

    it('should include warnings array in response', async () => {
      const response = await request(app).get('/api/config/validate');
      
      expect(response.body).toHaveProperty('warnings');
      expect(Array.isArray(response.body.warnings)).toBe(true);
    });
  });
});

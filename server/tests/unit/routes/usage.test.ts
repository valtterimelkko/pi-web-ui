import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import usageRoutes from '../../../src/routes/usage.js';
import fs from 'fs/promises';

// Mock auth middleware
vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  },
}));

// Mock rate limiter
vi.mock('../../../src/security/rate-limit.js', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
    next();
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(JSON.stringify({ records: [], lastUpdated: new Date().toISOString() })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Usage Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/usage', usageRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/usage', () => {
    it('should return usage statistics', async () => {
      const response = await request(app).get('/api/usage');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('totals');
      expect(response.body).toHaveProperty('byModel');
      expect(response.body).toHaveProperty('byProject');
      expect(response.body).toHaveProperty('last7Days');
      expect(response.body).toHaveProperty('recentRecords');
    });

    it('should have correct totals structure', async () => {
      const response = await request(app).get('/api/usage');
      
      expect(response.body.totals).toHaveProperty('input');
      expect(response.body.totals).toHaveProperty('output');
      expect(response.body.totals).toHaveProperty('total');
      expect(response.body.totals).toHaveProperty('cost');
      expect(response.body.totals).toHaveProperty('sessions');
    });
  });

  describe('POST /api/usage/record', () => {
    it('should record usage data', async () => {
      const response = await request(app)
        .post('/api/usage/record')
        .send({
          sessionId: 'test-session',
          sessionPath: '/path/to/session.jsonl',
          cwd: '/home/user/project',
          model: 'anthropic/claude-3-sonnet',
          tokens: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            total: 150,
          },
          cost: 0.001,
          messageCount: 5,
        });
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });

    it('should require sessionId and tokens', async () => {
      const response = await request(app)
        .post('/api/usage/record')
        .send({});
      
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('DELETE /api/usage', () => {
    it('should clear usage history', async () => {
      const response = await request(app).delete('/api/usage');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });
});

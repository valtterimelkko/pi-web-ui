import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthRoutes from '../../../src/routes/health.js';

// Mock config
vi.mock('../../../src/config.js', () => ({
  config: {
    nodeEnv: 'test',
    piAgentDir: '/root/.pi/agent',
    rateLimitMax: 100,
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  },
}));

describe('Health Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/health', healthRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/health/live', () => {
    it('should return liveness status', async () => {
      const response = await request(app).get('/api/health/live');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('uptime');
    });
  });

  describe('GET /api/health/ready', () => {
    it('should return readiness status with checks', async () => {
      const response = await request(app).get('/api/health/ready');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('checks');
      expect(response.body.checks).toHaveProperty('piAgentDir');
      expect(response.body.checks).toHaveProperty('envConfig');
      expect(response.body.checks).toHaveProperty('memory');
    });

    it('should include uptime and version', async () => {
      const response = await request(app).get('/api/health/ready');

      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('nodeEnv');
    });

    // Phase 3.4 — a high heapUsed/heapTotal ratio alone must not make the server
    // unready: V8 grows the committed heap toward full under sustained load by
    // design, so the ratio is a GC-pressure proxy, not an OOM/capacity signal.
    it('stays ready when heapUsed/heapTotal is high (warning, not 503)', async () => {
      const spy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 200 * 1024 * 1024,
        heapTotal: 100 * 1024 * 1024,
        heapUsed: 95 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 1024 * 1024,
      } as NodeJS.MemoryUsage);
      try {
        const response = await request(app).get('/api/health/ready');
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
        expect(response.body.checks.memory.status).toBe('warning');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('GET /api/health', () => {
    it('should return basic health status', async () => {
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});

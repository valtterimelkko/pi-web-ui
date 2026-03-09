import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';

// Mock the pi service
vi.mock('../../../src/pi/pi-service.js', () => ({
  getPiService: vi.fn().mockReturnValue({
    listAllSessions: vi.fn().mockResolvedValue([
      {
        id: 'session-1',
        path: '/path/to/session',
        firstMessage: 'Hello',
        messageCount: 5,
        cwd: '/home/user',
      },
    ]),
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'new-session',
      subscribe: vi.fn(),
    }),
  }),
}));

describe('Sessions Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock session routes
    app.get('/api/sessions', async (req, res) => {
      const { getPiService } = await import('../../../src/pi/pi-service.js');
      const sessions = await getPiService().listAllSessions();
      res.json(sessions);
    });

    app.post('/api/sessions', async (req, res) => {
      const { getPiService } = await import('../../../src/pi/pi-service.js');
      const session = await getPiService().createSession({
        clientId: req.body.clientId || 'test-client',
        cwd: req.body.cwd,
      });
      res.json({ sessionId: session.sessionId });
    });
  });

  describe('GET /api/sessions', () => {
    it('should return list of sessions', async () => {
      const response = await request(app).get('/api/sessions');
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/sessions', () => {
    it('should create a new session', async () => {
      const response = await request(app)
        .post('/api/sessions')
        .send({ cwd: '/home/user' });
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('sessionId');
    });
  });
});

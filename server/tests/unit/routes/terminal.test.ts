import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { terminalRouter } from '../../../src/routes/terminal.js';

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../../src/terminal/terminal-manager.js', () => ({
  terminalManager: {
    isAvailable: vi.fn(() => true),
    list: vi.fn(() => []),
    destroy: vi.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/terminal', terminalRouter);

describe('Terminal Routes', () => {
  it('GET /api/terminal/status returns available=true', async () => {
    const res = await request(app).get('/api/terminal/status');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('DELETE /api/terminal/:clientId destroys terminal', async () => {
    const res = await request(app).delete('/api/terminal/test-client');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

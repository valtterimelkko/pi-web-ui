import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockIsAvailable = vi.fn();
const mockGetProcessStatus = vi.fn(() => ({ healthy: true, managed: true, uptimeMs: 1234 }));

vi.mock('../../../src/opencode/index.js', () => ({
  getOpenCodeService: vi.fn().mockReturnValue({
    isAvailable: mockIsAvailable,
    getProcessStatus: mockGetProcessStatus,
  }),
}));

vi.mock('../../../src/config.js', () => ({
  config: {
    nodeEnv: 'test',
    piAgentDir: '/root/.pi/agent',
    rateLimitMax: 100,
    opencodeServerEnabled: true,
    opencodeServerPort: 4096,
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  },
}));

vi.mock('../../../src/routes/sessions.js', () => ({
  getWorkerPool: vi.fn().mockReturnValue({
    getStats: () => ({ total: 1, maxWorkers: 4, active: 0, idle: 1 }),
  }),
}));

vi.mock('../../../src/workers/crash-logger.js', () => ({
  getCrashLogger: vi.fn(),
}));

describe('Health Routes — OpenCode check', () => {
  let app: express.Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());

    const healthRoutes = (await import('../../../src/routes/health.js')).default;
    app.use('/api/health', healthRoutes);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports OpenCode as ok when available and enabled', async () => {
    mockIsAvailable.mockResolvedValueOnce(true);

    const response = await request(app)
      .get('/api/health/ready')
      .expect(200);

    expect(response.body.checks.opencode).toBeDefined();
    expect(response.body.checks.opencode.status).toBe('ok');
    expect(response.body.checks.opencode.message).toContain('4096');
    expect(response.body.checks.opencode.message).toContain('uptime');
  });

  it('reports OpenCode as warning when available but disabled', async () => {
    const configMock = await import('../../../src/config.js');
    (configMock.config as Record<string, unknown>).opencodeServerEnabled = false;
    mockIsAvailable.mockResolvedValueOnce(true);

    const response = await request(app)
      .get('/api/health/ready')
      .expect(200);

    expect(response.body.checks.opencode.status).toBe('warning');
    expect(response.body.checks.opencode.message).toContain('disabled');

    (configMock.config as Record<string, unknown>).opencodeServerEnabled = true;
  });

  it('reports OpenCode as warning when not installed', async () => {
    mockIsAvailable.mockResolvedValueOnce(false);

    const response = await request(app)
      .get('/api/health/ready')
      .expect(200);

    expect(response.body.checks.opencode.status).toBe('warning');
    expect(response.body.checks.opencode.message).toContain('not installed');
  });

  it('reports OpenCode as warning on check failure', async () => {
    mockIsAvailable.mockRejectedValueOnce(new Error('boom'));

    const response = await request(app)
      .get('/api/health/ready')
      .expect(200);

    expect(response.body.checks.opencode.status).toBe('warning');
    expect(response.body.checks.opencode.message).toContain('boom');
  });
});

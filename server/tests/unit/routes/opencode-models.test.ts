import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetAvailableModels = vi.fn();

vi.mock('../../../src/opencode/index.js', () => ({
  getOpenCodeService: vi.fn().mockReturnValue({
    getAvailableModels: mockGetAvailableModels,
  }),
}));

vi.mock('../../../src/pi/index.js', () => ({
  getPiService: vi.fn().mockReturnValue({
    getAvailableModels: vi.fn().mockResolvedValue([
      { id: 'openai/gpt-4', name: 'GPT-4', provider: 'openai' },
    ]),
  }),
}));

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../../../src/security/rate-limit.js', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

describe('Models API — OpenCode branch', () => {
  let app: express.Application;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());

    const modelsRouter = (await import('../../../src/routes/models.js')).default;
    app.use('/api/models', modelsRouter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns OpenCode models when sdkType=opencode', async () => {
    mockGetAvailableModels.mockResolvedValueOnce([
      { id: 'glm-5.1', name: 'GLM 5.1', provider: 'zai-coding-plan', contextWindow: 128000, maxTokens: 8192, description: 'OpenCode Direct via Z.AI Coding Plan' },
    ]);

    const response = await request(app)
      .get('/api/models?sdkType=opencode')
      .expect(200);

    expect(response.body.models).toHaveLength(1);
    expect(response.body.models[0].id).toBe('glm-5.1');
    expect(response.body.models[0].provider).toBe('zai-coding-plan');
    expect(mockGetAvailableModels).toHaveBeenCalledOnce();
  });

  it('returns Pi models when sdkType is not opencode', async () => {
    const response = await request(app)
      .get('/api/models')
      .expect(200);

    expect(response.body.models).toHaveLength(1);
    expect(response.body.models[0].id).toBe('openai/gpt-4');
    expect(mockGetAvailableModels).not.toHaveBeenCalled();
  });

  it('handles errors from getAvailableModels', async () => {
    mockGetAvailableModels.mockRejectedValueOnce(new Error('server down'));

    const response = await request(app)
      .get('/api/models?sdkType=opencode')
      .expect(500);

    expect(response.body.error).toBe('Failed to list models');
  });

  it('returns empty array when no models available', async () => {
    mockGetAvailableModels.mockResolvedValueOnce([]);

    const response = await request(app)
      .get('/api/models?sdkType=opencode')
      .expect(200);

    expect(response.body.models).toEqual([]);
  });
});

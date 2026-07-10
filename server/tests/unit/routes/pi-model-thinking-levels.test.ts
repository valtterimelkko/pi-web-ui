import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const getAvailableModels = vi.fn();

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../src/security/rate-limit.js', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: () => ({ getAvailableModels }),
}));
vi.mock('../../../src/opencode/index.js', () => ({
  getOpenCodeService: () => ({ getAvailableModels: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('../../../src/antigravity/index.js', () => ({
  getAntigravityService: () => ({ getAvailableModels: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('../../../src/claude/index.js', () => ({
  getClaudeProfiles: () => [],
}));

describe('GET /api/models?sdkType=pi thinking level capabilities', () => {
  beforeEach(() => {
    getAvailableModels.mockReset();
  });

  it('derives each model’s supported thinking levels from Pi SDK model metadata', async () => {
    getAvailableModels.mockResolvedValue([
      {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        provider: 'openai-codex',
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
      },
      {
        id: 'chat-model',
        name: 'Chat model',
        provider: 'example',
        reasoning: false,
      },
    ]);

    const { default: modelsRouter } = await import('../../../src/routes/models.js');
    const app = express();
    app.use('/api/models', modelsRouter);

    const res = await request(app).get('/api/models?sdkType=pi').expect(200);

    expect(res.body.models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.6-terra',
        thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      }),
      expect.objectContaining({
        id: 'chat-model',
        thinkingLevels: ['off'],
      }),
    ]);
  });
});

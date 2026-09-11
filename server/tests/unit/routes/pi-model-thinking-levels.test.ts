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

  it('derives google provider thinking levels per family exactly as catalogued', async () => {
    // Real shapes from the SDK dynamic model store (identical in the bundled
    // static catalogue): Gemini 3.x flash cannot disable thinking (off: null
    // → minimal..high), 3.1 pro maps low/high, mapless models (2.5 /
    // deep-research / computer-use) get the full generic range, gemma maps
    // minimal/high only. The frontend selector consumes these verbatim.
    getAvailableModels.mockResolvedValue([
      {
        id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', provider: 'google',
        reasoning: true, thinkingLevelMap: { off: null },
      },
      {
        id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', provider: 'google',
        reasoning: true, thinkingLevelMap: { off: null },
      },
      {
        id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', provider: 'google',
        reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' },
      },
      {
        id: 'gemini-2.5-computer-use-preview-10-2025', name: 'Gemini 2.5 Computer Use', provider: 'google',
        reasoning: true,
      },
      {
        id: 'gemma-4-31b-it', name: 'Gemma 4 31B IT', provider: 'google',
        reasoning: true, thinkingLevelMap: { off: null, minimal: 'MINIMAL', low: null, medium: null, high: 'HIGH' },
      },
    ]);

    const { default: modelsRouter } = await import('../../../src/routes/models.js');
    const app = express();
    app.use('/api/models', modelsRouter);

    const res = await request(app).get('/api/models?sdkType=pi').expect(200);

    const byId = (id: string) => res.body.models.find((model: { id: string }) => model.id === id);
    expect(byId('gemini-3.5-flash-lite').thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(byId('gemini-3.8-flash').thinkingLevels).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(byId('gemini-3.1-pro-preview').thinkingLevels).toEqual(['low', 'high']);
    expect(byId('gemini-2.5-computer-use-preview-10-2025').thinkingLevels).toEqual([
      'off', 'minimal', 'low', 'medium', 'high',
    ]);
    expect(byId('gemma-4-31b-it').thinkingLevels).toEqual(['minimal', 'high']);
  });
});

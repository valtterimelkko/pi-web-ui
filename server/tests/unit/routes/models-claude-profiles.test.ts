import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Pass-through auth + rate limit so we can exercise the real router.
vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../src/security/rate-limit.js', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: () => ({ getAvailableModels: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('../../../src/opencode/index.js', () => ({
  getOpenCodeService: () => ({ getAvailableModels: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('../../../src/antigravity/index.js', () => ({
  getAntigravityService: () => ({ getAvailableModels: vi.fn().mockResolvedValue([]) }),
}));

const getClaudeProfilesMock = vi.fn();
vi.mock('../../../src/claude/index.js', () => ({
  getClaudeProfiles: () => getClaudeProfilesMock(),
}));

describe('GET /api/models?sdkType=claude', () => {
  let app: express.Application;

  beforeEach(async () => {
    getClaudeProfilesMock.mockReset();
    const { default: modelsRouter } = await import('../../../src/routes/models.js');
    app = express();
    app.use(express.json());
    app.use('/api/models', modelsRouter);
  });

  it('surfaces base Claude aliases plus profile-backed entries', async () => {
    getClaudeProfilesMock.mockReturnValue([
      { id: 'glm52-claude-sdk', label: 'GLM 5.2 — Claude SDK', baseUrl: 'https://api.z.ai/api/anthropic', backend: 'sdk-subscription', model: 'sonnet' },
      { id: 'claude-opus-cli-direct', label: 'Claude Opus — CLI direct', baseUrl: undefined, backend: 'cli-direct', model: 'opus' },
    ]);

    const res = await request(app).get('/api/models?sdkType=claude').expect(200);
    const ids = res.body.models.map((m: { id: string }) => m.id);

    expect(ids).toContain('sonnet');
    expect(ids).toContain('opus');
    expect(ids).toContain('haiku');
    expect(ids).toContain('profile:glm52-claude-sdk');
    expect(ids).toContain('profile:claude-opus-cli-direct');

    const glm = res.body.models.find((m: { id: string }) => m.id === 'profile:glm52-claude-sdk');
    expect(glm.provider).toBe('zai');
    expect(glm.displayName).toBe('GLM 5.2 — Claude SDK');
    expect(glm.backend).toBe('sdk-subscription');
    expect(glm.claudeModel).toBe('sonnet');

    const native = res.body.models.find((m: { id: string }) => m.id === 'profile:claude-opus-cli-direct');
    expect(native.provider).toBe('anthropic');
    expect(native.backend).toBe('cli-direct');
    expect(native.claudeModel).toBe('opus');
  });

  it('returns only base aliases when no profiles are enabled', async () => {
    getClaudeProfilesMock.mockReturnValue([]);

    const res = await request(app).get('/api/models?sdkType=claude').expect(200);
    const ids = res.body.models.map((m: { id: string }) => m.id);

    expect(ids).toEqual(['sonnet', 'opus', 'haiku']);
    expect(ids.some((id: string) => id.startsWith('profile:'))).toBe(false);
  });
});

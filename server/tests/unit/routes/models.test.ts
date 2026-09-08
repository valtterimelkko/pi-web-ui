import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { generateSessionToken } from '../../../src/security/auth.js';
import modelsRouter from '../../../src/routes/models.js';

// Real router and cookie verification; only external services/config are fixtures.
vi.mock('../../../src/config.js', () => ({ config: { jwtSecret: 'isolated-model-route-test-signing-key', jwtExpiresIn: '1h' } }));
const services = vi.hoisted(() => ({
  pi: { getAvailableModels: vi.fn() },
  opencode: { isEnabled: vi.fn(), getAvailableModels: vi.fn() },
  commandcode: { init: vi.fn(), isEnabled: vi.fn(), getModels: vi.fn() },
}));
vi.mock('../../../src/pi/index.js', () => ({ getPiService: () => services.pi }));
vi.mock('../../../src/opencode/index.js', () => ({ getOpenCodeService: () => services.opencode }));
vi.mock('../../../src/command-code/command-code-instance.js', () => ({ getCommandCodeService: () => services.commandcode }));
vi.mock('../../../src/antigravity/index.js', () => ({ getAntigravityService: vi.fn() }));
vi.mock('../../../src/claude/index.js', () => ({ getClaudeProfiles: () => [] }));

const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', reasoning: false };
describe('Models API production router', () => {
  let app: express.Application;
  let cookie: string;
  beforeEach(() => {
    vi.resetAllMocks();
    services.pi.getAvailableModels.mockResolvedValue([model]);
    services.opencode.isEnabled.mockReturnValue(false);
    services.commandcode.isEnabled.mockReturnValue(false);
    services.commandcode.init.mockResolvedValue(undefined);
    app = express();
    app.use(express.json());
    app.use('/api/models', modelsRouter);
    cookie = `accessToken=${generateSessionToken('fixture-user')}`;
  });

  it.each([undefined, 'accessToken=not-a-valid-token'])('rejects missing/invalid auth before runtime access: %s', async value => {
    const get = request(app).get('/api/models');
    const put = request(app).put('/api/models/current').send({ modelId: 'fixture/model' });
    if (value) { get.set('Cookie', value); put.set('Cookie', value); }
    await get.expect(401);
    await put.expect(401);
    expect(services.pi.getAvailableModels).not.toHaveBeenCalled();
  });
  it('returns Pi models with SDK-derived thinking capability', async () => {
    const response = await request(app).get('/api/models').set('Cookie', cookie).expect(200);
    expect(response.body.models).toEqual([{ ...model, thinkingLevels: ['off'] }]);
    expect(services.pi.getAvailableModels).toHaveBeenCalledOnce();
  });
  it('reports service failure through the real route', async () => {
    services.pi.getAvailableModels.mockRejectedValue(new Error('fixture service unavailable'));
    const response = await request(app).get('/api/models').set('Cookie', cookie).expect(500);
    expect(response.body).toEqual({ error: 'Failed to list models' });
  });
  it.each(['opencode', 'commandcode'])('does not query a disabled %s catalogue', async runtime => {
    const response = await request(app).get(`/api/models?sdkType=${runtime}`).set('Cookie', cookie).expect(200);
    expect(response.body).toEqual({ models: [] });
    expect(services.opencode.getAvailableModels).not.toHaveBeenCalled();
    expect(services.commandcode.getModels).not.toHaveBeenCalled();
    expect(services.pi.getAvailableModels).not.toHaveBeenCalled();
  });
  it.each([
    [{}, 'modelId is required'],
    [{ modelId: 'invalid-format' }, 'Invalid model ID format'],
    [{ modelId: '/model' }, 'Invalid model ID format'],
  ])('validates the actual PUT contract for %j', async (body, error) => {
    const response = await request(app).put('/api/models/current').set('Cookie', cookie).send(body).expect(400);
    expect(response.body.error).toContain(error);
  });
  it.each(['github-copilot/gpt-5.4', 'provider/sub/model-name'])('validates without applying %s', async modelId => {
    const response = await request(app).put('/api/models/current').set('Cookie', cookie).send({ modelId }).expect(200);
    const [provider, ...parts] = modelId.split('/');
    expect(response.body).toEqual({ success: true, modelId, provider, model: parts.join('/') });
    expect(services.pi.getAvailableModels).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Readable, Writable } from 'stream';
import { createModelsRoutes } from '../../../src/internal-api/routes/models.js';

function createMockReq(
  body?: unknown,
  method = 'POST',
  url = '/api/v1/models/refresh',
): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = {};
  return req;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  });
  res.getHeader = vi.fn();
  return res;
}

function makeDeps(opencodeOverrides: Record<string, unknown>) {
  return {
    piService: { getAvailableModels: vi.fn().mockResolvedValue([]) },
    claudeService: { isAvailable: vi.fn().mockResolvedValue(false) },
    antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) },
    opencodeService: {
      isAvailable: vi.fn().mockResolvedValue(true),
      isEnabled: vi.fn().mockReturnValue(true),
      ...opencodeOverrides,
    },
  } as any;
}

describe('createModelsRoutes — handleListModels', () => {
  it('hides Internal-API-blocked Pi providers while retaining openai-codex', async () => {
    const routes = createModelsRoutes({
      piService: {
        getAvailableModels: vi.fn().mockResolvedValue([
          { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' },
          { id: 'openai/gpt-5.5', name: 'GPT-5.5 via OpenRouter', provider: 'openrouter' },
          { id: 'gpt-5.5', name: 'GPT-5.5 Codex', provider: 'openai-codex' },
          { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
        ]),
      } as any,
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      blockedPiProviders: ['openai', 'openrouter'],
    });
    const res = createMockRes();

    await routes.handleListModels(
      createMockReq(undefined, 'GET', '/api/v1/models?runtime=pi'),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).models.pi.map((model: { provider: string }) => model.provider)).toEqual([
      'openai-codex',
      'anthropic',
    ]);
  });

  it('publishes Pi SDK thinking levels including max for GPT-5.6 models', async () => {
    const routes = createModelsRoutes({
      piService: {
        getAvailableModels: vi.fn().mockResolvedValue([
          {
            id: 'openai-codex/gpt-5.6-luna',
            name: 'GPT-5.6 Luna',
            provider: 'openai-codex',
            reasoning: true,
            thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
          },
        ]),
      } as any,
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
    });
    const res = createMockRes();

    await routes.handleListModels(
      createMockReq(undefined, 'GET', '/api/v1/models?runtime=pi'),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).models.pi[0]).toMatchObject({
      id: 'openai-codex/gpt-5.6-luna',
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('advertises the full discovered Command Code catalogue with runnable status', async () => {
    const routes = createModelsRoutes({
      piService: { getAvailableModels: vi.fn().mockResolvedValue([]) } as any,
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(true),
        isShadowAvailable: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(true),
        getModels: vi.fn().mockReturnValue([
          { id: 'qwen/qwen3.8-max', displayName: 'Qwen 3.8 Max', provider: 'command-code', reasoning: true, runnable: true, supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
          { id: 'meta/muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor', provider: 'command-code', reasoning: true, runnable: true, supportsEffort: false, effortLevels: [] },
          { id: 'deepseek/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'command-code', reasoning: true, runnable: false, supportsEffort: true, effortLevels: ['high', 'max'] },
        ]),
        getShadowModels: vi.fn().mockReturnValue([]),
        getCatalogueMetadata: vi.fn().mockReturnValue({ availabilityStatus: 'available', checkedAt: '2026-08-08T03:00:00.000Z', source: 'live-discovery' }),
      } as any,
    });
    const res = createMockRes();

    await routes.handleListModels(createMockReq(undefined, 'GET', '/api/v1/models?runtime=commandcode'), res);

    expect(JSON.parse(res.body).models.commandcode).toEqual([
      expect.objectContaining({ id: 'qwen/qwen3.8-max', runnable: true }),
      expect.objectContaining({ id: 'meta/muse-spark-1.2-contributor', runnable: true }),
      expect.objectContaining({ id: 'deepseek/deepseek-v4-pro', runnable: false }),
    ]);
    expect(JSON.parse(res.body).catalogueMetadata.commandcode).toEqual({ availabilityStatus: 'available', checkedAt: '2026-08-08T03:00:00.000Z', source: 'live-discovery' });
  });

  it('keeps the full discovered Command Code catalogue visible when the narrow execution gate is unavailable', async () => {
    const routes = createModelsRoutes({
      piService: { getAvailableModels: vi.fn().mockResolvedValue([]) } as any,
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(false),
        isShadowAvailable: vi.fn().mockReturnValue(false),
        isShadowEnabled: vi.fn().mockReturnValue(true),
        getModels: vi.fn().mockReturnValue([
          { id: 'qwen/qwen3.8-max', displayName: 'Qwen 3.8 Max', provider: 'command-code', reasoning: true, runnable: false, status: 'evidence-only', browserRunnable: false, supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
          { id: 'meta/muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor', provider: 'command-code', reasoning: true, runnable: false, status: 'evidence-only', browserRunnable: false, supportsEffort: false, effortLevels: [] },
          { id: 'google/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', provider: 'command-code', reasoning: true, runnable: false, status: 'evidence-only', browserRunnable: false, supportsEffort: false, effortLevels: [] },
        ]),
      } as any,
    });
    const res = createMockRes();

    await routes.handleListModels(createMockReq(undefined, 'GET', '/api/v1/models?runtime=commandcode'), res);

    expect(JSON.parse(res.body).models.commandcode).toHaveLength(3);
    expect(JSON.parse(res.body).models.commandcode[2]).toMatchObject({ id: 'google/gemini-3.7-flash', status: 'evidence-only', runnable: false });
  });

  it('does not expose browser-only Command Code catalogue entries through the shadow Internal API', async () => {
    const routes = createModelsRoutes({
      piService: { getAvailableModels: vi.fn().mockResolvedValue([]) } as any,
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(false),
        getCatalogueMetadata: vi.fn().mockReturnValue({ availabilityStatus: 'available', checkedAt: '2026-08-08T03:00:00.000Z', source: 'live-discovery' }),
        getModels: vi.fn().mockReturnValue([{ id: 'qwen/qwen3.8-max', provider: 'command-code', runnable: false, status: 'evidence-only', browserRunnable: true, supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'] }]),
      } as any,
    });
    const res = createMockRes();

    await routes.handleListModels(createMockReq(undefined, 'GET', '/api/v1/models?runtime=commandcode'), res);

    expect(JSON.parse(res.body).models.commandcode).toEqual([]);
    expect(JSON.parse(res.body).catalogueMetadata).toBeUndefined();
  });

  it('publishes Command Code model-specific native effort capabilities', async () => {
    const routes = createModelsRoutes({
      piService: { getAvailableModels: vi.fn().mockResolvedValue([]) } as any,
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(true),
        isShadowAvailable: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(true),
        getModels: vi.fn().mockReturnValue([
          {
            id: 'qwen/qwen3.8-max', displayName: 'Qwen 3.8 Max', provider: 'command-code', reasoning: true,
            supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium',
          },
          {
            id: 'meta/muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor', provider: 'command-code', reasoning: true,
            supportsEffort: false, effortLevels: [],
          },
        ]),
      } as any,
    });
    const res = createMockRes();

    await routes.handleListModels(
      createMockReq(undefined, 'GET', '/api/v1/models?runtime=commandcode'),
      res,
    );

    expect(JSON.parse(res.body).models.commandcode).toEqual([
      expect.objectContaining({ id: 'qwen/qwen3.8-max', supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' }),
      expect.objectContaining({ id: 'meta/muse-spark-1.2-contributor', supportsEffort: false, effortLevels: [] }),
    ]);
  });

  it('publishes Claude model-specific thinking levels including max where supported', async () => {
    const routes = createModelsRoutes({
      piService: { getAvailableModels: vi.fn().mockResolvedValue([]) } as any,
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getProfiles: vi.fn().mockReturnValue([
          {
            id: 'native-sonnet',
            label: 'Native Sonnet',
            backend: 'sdk-subscription',
            model: 'claude-sonnet-4-20250514',
          },
          {
            id: 'native-haiku',
            label: 'Native Haiku',
            backend: 'cli-direct',
            model: 'haiku',
          },
          {
            id: 'glm-sonnet',
            label: 'GLM Sonnet',
            backend: 'sdk-subscription',
            model: 'sonnet',
            baseUrl: 'https://api.z.ai/api/anthropic',
          },
        ]),
      } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
    });
    const res = createMockRes();

    await routes.handleListModels(
      createMockReq(undefined, 'GET', '/api/v1/models?runtime=claude'),
      res,
    );

    expect(res.statusCode).toBe(200);
    const models = JSON.parse(res.body).models.claude;
    expect(models.find((model: any) => model.id === 'sonnet')).toMatchObject({
      reasoning: true,
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(models.find((model: any) => model.id === 'haiku')).toMatchObject({
      reasoning: true,
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    });
    expect(models.find((model: any) => model.id === 'profile:native-sonnet').thinkingLevels).toContain('max');
    expect(models.find((model: any) => model.id === 'profile:native-haiku').thinkingLevels).not.toContain('max');
    expect(models.find((model: any) => model.id === 'profile:glm-sonnet').thinkingLevels).toContain('max');
  });
});

describe('createModelsRoutes — handleRefreshModels', () => {
  const sampleResult = {
    available: true,
    cacheWarmed: true,
    recycled: true,
    recycleDeferred: false,
    runningSessions: 0,
    providerCount: 3,
    modelCount: 350,
    diff: { addedModels: ['kilo/new'], removedModels: [], addedProviders: [], removedProviders: [], changed: true },
    snapshotPath: '/home/user/.pi-web-ui/opencode-model-snapshot.json',
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('returns 503 when OpenCode is unavailable', async () => {
    const refreshModels = vi.fn();
    const routes = createModelsRoutes(makeDeps({ isAvailable: vi.fn().mockResolvedValue(false), refreshModels }));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq(), res);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('OPENCODE_UNAVAILABLE');
    expect(refreshModels).not.toHaveBeenCalled();
  });

  it('returns 503 OPENCODE_UNAVAILABLE and does NOT spawn when OpenCode is disabled', async () => {
    // The no-spawn-when-disabled guarantee: refreshModels -> warmModelCache
    // would execFile('opencode'); the isEnabled guard must reject before that.
    const refreshModels = vi.fn();
    const routes = createModelsRoutes(makeDeps({ isEnabled: vi.fn().mockReturnValue(false), refreshModels }));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq(), res);

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('OPENCODE_UNAVAILABLE');
    expect(refreshModels).not.toHaveBeenCalled();
  });

  it('returns the refresh result and forwards body options', async () => {
    const refreshModels = vi.fn().mockResolvedValue(sampleResult);
    const routes = createModelsRoutes(makeDeps({ refreshModels }));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq({ warmCache: false, recycle: true }), res);

    expect(res.statusCode).toBe(200);
    expect(refreshModels).toHaveBeenCalledWith({ warmCache: false, recycle: true });
    expect(JSON.parse(res.body)).toMatchObject({ providerCount: 3, diff: { addedModels: ['kilo/new'] } });
  });

  it('defaults missing body options to undefined (server picks defaults)', async () => {
    const refreshModels = vi.fn().mockResolvedValue(sampleResult);
    const routes = createModelsRoutes(makeDeps({ refreshModels }));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq(), res);

    expect(refreshModels).toHaveBeenCalledWith({ warmCache: undefined, recycle: undefined });
  });

  it('returns 500 when the refresh throws', async () => {
    const refreshModels = vi.fn().mockRejectedValue(new Error('boom'));
    const routes = createModelsRoutes(makeDeps({ refreshModels }));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq(), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).code).toBe('INTERNAL_ERROR');
  });
});

describe('createModelsRoutes — handleRefreshModels (runtime=pi)', () => {
  const piResult = {
    available: true,
    cacheWarmed: true,
    registered: true,
    recycled: false,
    recycleDeferred: false,
    runningSessions: 0,
    providerCount: 1,
    modelCount: 300,
    diff: { addedModels: ['openrouter/a/b'], removedModels: [], addedProviders: [], removedProviders: [], changed: true },
    snapshotPath: '/home/user/.pi-web-ui/pi-openrouter-model-snapshot.json',
    generatedAt: '2026-01-01T00:00:00.000Z',
  };

  function makePiDeps(refreshOpenRouterModels: ReturnType<typeof vi.fn>) {
    return {
      piService: { getAvailableModels: vi.fn().mockResolvedValue([]), refreshOpenRouterModels },
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false) },
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) },
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), refreshModels: vi.fn() },
    } as any;
  }

  it('dispatches to piService.refreshOpenRouterModels when runtime=pi in body', async () => {
    const refreshOpenRouterModels = vi.fn().mockResolvedValue(piResult);
    const routes = createModelsRoutes(makePiDeps(refreshOpenRouterModels));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq({ runtime: 'pi' }), res);

    expect(res.statusCode).toBe(200);
    expect(refreshOpenRouterModels).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.body)).toMatchObject({ runtime: 'pi', modelCount: 300 });
  });

  it('dispatches to piService when runtime=pi in the query string', async () => {
    const refreshOpenRouterModels = vi.fn().mockResolvedValue(piResult);
    const routes = createModelsRoutes(makePiDeps(refreshOpenRouterModels));
    const res = createMockRes();
    const req = createMockReq({});
    req.url = '/api/v1/models/refresh?runtime=pi';

    await routes.handleRefreshModels(req, res);

    expect(res.statusCode).toBe(200);
    expect(refreshOpenRouterModels).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the pi refresh throws', async () => {
    const refreshOpenRouterModels = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const routes = createModelsRoutes(makePiDeps(refreshOpenRouterModels));
    const res = createMockRes();

    await routes.handleRefreshModels(createMockReq({ runtime: 'pi' }), res);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).code).toBe('INTERNAL_ERROR');
  });
});

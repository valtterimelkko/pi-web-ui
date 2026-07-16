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
      ...opencodeOverrides,
    },
  } as any;
}

describe('createModelsRoutes — handleListModels', () => {
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

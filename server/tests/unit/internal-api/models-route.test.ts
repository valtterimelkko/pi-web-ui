import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Readable, Writable } from 'stream';
import { createModelsRoutes } from '../../../src/internal-api/routes/models.js';

function createMockReq(body?: unknown, method = 'POST'): IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessage;
  req.url = '/api/v1/models/refresh';
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

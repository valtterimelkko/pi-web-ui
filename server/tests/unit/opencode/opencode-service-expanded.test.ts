import { describe, it, expect, beforeEach, beforeAll, vi, afterEach, afterAll } from 'vitest';
import { OpenCodeService } from '../../../src/opencode/opencode-service.js';
import type { OpenCodeSession, OpenCodeSSEEvent } from '../../../src/opencode/opencode-types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSession(overrides: Partial<OpenCodeSession> = {}): OpenCodeSession {
  return {
    id: `oc-sess-${Math.random().toString(36).slice(2, 8)}`,
    slug: 'test-session',
    version: '1',
    projectID: 'proj-1',
    directory: '/tmp',
    title: 'Test Session',
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  };
}

function allMocks(session?: OpenCodeSession, extras?: Record<string, () => Response>) {
  const sess = session ?? makeSession();
  mockFetch.mockImplementation((url: string, opts: RequestInit) => {
    if (extras) {
      for (const [pattern, handler] of Object.entries(extras)) {
        if (url.includes(pattern)) return Promise.resolve(handler());
      }
    }
    if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
      return Promise.resolve(jsonResponse({ status: 'ok' }));
    }
    if (url.includes('/config/providers')) {
      return Promise.resolve(jsonResponse({ providers: [] }));
    }
    if (url.includes('/session') && opts?.method === 'POST') {
      return Promise.resolve(jsonResponse(sess));
    }
    if (url.includes('/event')) {
      return Promise.resolve(new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return Promise.resolve(jsonResponse(null));
  });
  return sess;
}

describe('OpenCodeService — getAvailableModels', () => {
  let service: OpenCodeService;
  let tmpDir: string;
  let registryPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-models-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await fs.rm(registryPath, { force: true }).catch(() => {});
    service = new OpenCodeService({ registryPath });
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('handles providers returned as an array of objects', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [
            {
              id: 'zai-coding-plan',
              name: 'Z.AI Coding Plan',
              models: [
                { id: 'glm-5.1', name: 'GLM 5.1', limit: { context: 128000, output: 8192 }, status: 'active' },
                { id: 'glm-4', name: 'GLM 4', limit: { context: 64000, output: 4096 }, status: 'active' },
              ],
            },
            {
              id: 'other-provider',
              name: 'Other',
              models: [{ id: 'x-1', name: 'X1' }],
            },
          ],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('glm-4');
    expect(models[1].id).toBe('glm-5.1');
    expect(models[0].provider).toBe('zai-coding-plan');
    expect(models[1].provider).toBe('zai-coding-plan');
    expect(models[0].contextWindow).toBe(64000);
    expect(models[1].contextWindow).toBe(128000);
    expect(models[0].description).toBe('OpenCode Direct via Z.AI Coding Plan');
  });

  it('handles providers returned as a dict (object format)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: {
            'zai-coding-plan': {
              id: 'zai-coding-plan',
              name: 'Z.AI Coding Plan',
              models: {
                'glm-5.1': { id: 'glm-5.1', name: 'GLM 5.1', limit: { context: 128000, output: 8192 } },
              },
            },
          },
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('glm-5.1');
    expect(models[0].provider).toBe('zai-coding-plan');
  });

  it('handles models as an array within a provider', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{ id: 'zai-coding-plan', models: [{ id: 'glm-5.1', name: 'GLM 5.1' }] }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('glm-5.1');
  });

  it('filters out deprecated models', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{
            id: 'zai-coding-plan',
            models: [
              { id: 'glm-5.1', name: 'GLM 5.1', status: 'active' },
              { id: 'glm-3', name: 'GLM 3', status: 'deprecated' },
            ],
          }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('glm-5.1');
  });

  it('filters out models with empty IDs', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{
            id: 'zai-coding-plan',
            models: [
              { id: '', name: 'Empty ID Model' },
              { id: 'glm-5.1', name: 'GLM 5.1' },
            ],
          }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('glm-5.1');
  });

  it('returns empty when zai-coding-plan provider is absent', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{ id: 'openai', models: [{ id: 'gpt-4', name: 'GPT-4' }] }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models).toHaveLength(0);
  });

  it('returns empty for null/undefined providers', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({ providers: null }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models).toHaveLength(0);
  });

  it('sorts models alphabetically by name', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{
            id: 'zai-coding-plan',
            models: [
              { id: 'glm-5.1', name: 'Zeta Model' },
              { id: 'glm-4', name: 'Alpha Model' },
              { id: 'glm-3', name: 'Middle Model' },
            ],
          }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models.map(m => m.name)).toEqual(['Alpha Model', 'Middle Model', 'Zeta Model']);
  });

  it('uses model id as fallback name when name is missing', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{ id: 'zai-coding-plan', models: [{ id: 'glm-5.1' }] }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('glm-5.1');
  });

  it('defaults contextWindow and maxTokens to 0 when limit is missing', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) {
        return Promise.resolve(jsonResponse({
          providers: [{ id: 'zai-coding-plan', models: [{ id: 'glm-5.1', name: 'GLM 5.1' }] }],
        }));
      }
      if (url.match(/^http:\/\/127\.0\.0\.1:\d+\/?$/)) {
        return Promise.resolve(jsonResponse({ status: 'ok' }));
      }
      return Promise.resolve(jsonResponse(null));
    });

    const models = await service.getAvailableModels();
    expect(models[0].contextWindow).toBe(0);
    expect(models[0].maxTokens).toBe(0);
  });
});

describe('OpenCodeService — setModel', () => {
  let service: OpenCodeService;
  let tmpDir: string;
  let registryPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-setmodel-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await fs.rm(registryPath, { force: true }).catch(() => {});
    service = new OpenCodeService({ registryPath });
    allMocks();
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('throws for unknown session', async () => {
    await expect(service.setModel('unknown', 'glm-5.1')).rejects.toThrow('OpenCode session not found');
  });

  it('persists model in registry and returns it', async () => {
    const { sessionId } = await service.createSession('/tmp');

    const result = await service.setModel(sessionId, 'zai-coding-plan/glm-5.1');
    expect(result).toBe('zai-coding-plan/glm-5.1');

    const entry = await service.getSession(sessionId);
    expect(entry?.model).toBe('zai-coding-plan/glm-5.1');
  });
});

describe('OpenCodeService — sendPrompt (single service instance)', () => {
  let service: OpenCodeService;
  let tmpDir: string;
  let registryPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-prompt-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await fs.rm(registryPath, { force: true }).catch(() => {});
    service = new OpenCodeService({ registryPath });
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('throws if session does not exist in registry', async () => {
    await expect(
      service.sendPrompt('nonexistent', 'hello', vi.fn(), vi.fn()),
    ).rejects.toThrow('OpenCode session not found');
  });

  it('throws if session is missing opencodeSessionId', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/config/providers')) return Promise.resolve(jsonResponse({ providers: [] }));
      return Promise.resolve(jsonResponse(null));
    });

    const registry = (service as unknown as { registry: { upsert: (entry: Record<string, unknown>) => Promise<void> } }).registry;
    await registry.upsert({
      id: 'no-oc-id',
      sdkType: 'opencode',
      path: 'no-oc-id',
      cwd: '/tmp',
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
    });

    await expect(
      service.sendPrompt('no-oc-id', 'hello', vi.fn(), vi.fn()),
    ).rejects.toThrow('missing opencodeSessionId');
  });

  it('emits agent_start and calls promptAsync with correct model', async () => {
    const sess = allMocks();
    const { sessionId } = await service.createSession('/tmp');
    await service.setModel(sessionId, 'zai-coding-plan/glm-5.1');

    const events: Array<Record<string, unknown>> = [];
    const onEvent = vi.fn((e: Record<string, unknown>) => events.push(e));
    const onComplete = vi.fn();

    let capturedBody: string | null = null;
    allMocks(sess, {
      '/prompt_async': () => {
        capturedBody = (mockFetch.mock.calls[mockFetch.mock.calls.length - 1]?.[1] as RequestInit)?.body as string;
        return new Response(null, { status: 204 });
      },
    });

    await service.sendPrompt(sessionId, 'hello world', onEvent, onComplete);

    expect(onEvent).toHaveBeenCalled();
    expect(events[0].type).toBe('agent_start');
    expect(events[0].sessionId).toBe(sessionId);

    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.model).toEqual({ providerID: 'zai-coding-plan', modelID: 'glm-5.1' });
    expect(parsed.parts).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('completes session on promptAsync error', async () => {
    const sess = allMocks();
    const { sessionId, opencodeSessionId } = await service.createSession('/tmp');
    const onComplete = vi.fn();

    allMocks(sess, {
      '/prompt_async': () => { throw new Error('server down'); },
    });

    await service.sendPrompt(sessionId, 'hello', vi.fn(), onComplete);

    expect(onComplete).toHaveBeenCalledWith(expect.any(Error));
    expect(service.isRunning(sessionId)).toBe(false);
  });

  it('passes agent parameter to promptAsync when provided', async () => {
    const sess = allMocks();
    const { sessionId } = await service.createSession('/tmp');

    let capturedBody: string | null = null;
    allMocks(sess, {
      '/prompt_async': () => {
        capturedBody = (mockFetch.mock.calls[mockFetch.mock.calls.length - 1]?.[1] as RequestInit)?.body as string;
        return new Response(null, { status: 204 });
      },
    });

    await service.sendPrompt(sessionId, 'analyze this code', vi.fn(), vi.fn(), 'plan');

    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.agent).toBe('plan');
    expect(parsed.parts).toEqual([{ type: 'text', text: 'analyze this code' }]);
  });

  it('omits agent when not provided (default build mode)', async () => {
    const sess = allMocks();
    const { sessionId } = await service.createSession('/tmp');

    let capturedBody: string | null = null;
    allMocks(sess, {
      '/prompt_async': () => {
        capturedBody = (mockFetch.mock.calls[mockFetch.mock.calls.length - 1]?.[1] as RequestInit)?.body as string;
        return new Response(null, { status: 204 });
      },
    });

    await service.sendPrompt(sessionId, 'implement feature', vi.fn(), vi.fn());

    expect(capturedBody).toBeTruthy();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.agent).toBeUndefined();
    expect(parsed.parts).toEqual([{ type: 'text', text: 'implement feature' }]);
  });

  it('marks session as running during prompt and completes on agent_end SSE', async () => {
    const sess = allMocks();
    const { sessionId, opencodeSessionId } = await service.createSession('/tmp');
    const events: Array<Record<string, unknown>> = [];
    const onEvent = vi.fn((e: Record<string, unknown>) => events.push(e));
    const onComplete = vi.fn();

    allMocks(sess, {
      '/prompt_async': () => new Response(null, { status: 204 }),
    });

    await service.sendPrompt(sessionId, 'hello', onEvent, onComplete);

    expect(service.isRunning(sessionId)).toBe(true);

    const sseEvent: OpenCodeSSEEvent = {
      type: 'session.idle',
      properties: { sessionID: opencodeSessionId },
    };
    await (service as unknown as { handleSSEEvent: (e: OpenCodeSSEEvent) => Promise<void> }).handleSSEEvent(sseEvent);

    expect(service.isRunning(sessionId)).toBe(false);
    expect(onComplete).toHaveBeenCalledWith(undefined);
  });

  it('tracks pending permissions from SSE events', async () => {
    const sess = allMocks();
    const { sessionId, opencodeSessionId } = await service.createSession('/tmp');

    allMocks(sess, {
      '/prompt_async': () => new Response(null, { status: 204 }),
    });

    await service.sendPrompt(sessionId, 'hello', vi.fn(), vi.fn());

    const permEvent: OpenCodeSSEEvent = {
      type: 'permission.updated',
      properties: {
        sessionID: opencodeSessionId,
        permission: {
          id: 'perm-123',
          status: 'pending',
          tool: 'bash',
          metadata: { toolName: 'bash', input: { command: 'ls' } },
        },
      },
    };

    await (service as unknown as { handleSSEEvent: (e: OpenCodeSSEEvent) => Promise<void> }).handleSSEEvent(permEvent);

    expect(service.isPendingPermission('perm-123')).toBe(true);
    expect(service.getSessionForPermission('perm-123')).toBe(sessionId);
  });

  it('ignores SSE events for unknown sessions', async () => {
    const event: OpenCodeSSEEvent = {
      type: 'message.updated',
      properties: { sessionID: 'unknown-oc-session' },
    };

    await expect(
      (service as unknown as { handleSSEEvent: (e: OpenCodeSSEEvent) => Promise<void> }).handleSSEEvent(event),
    ).resolves.toBeUndefined();
  });
});

describe('OpenCodeService — validateSetup', () => {
  it('returns an object with ok boolean', async () => {
    mockFetch.mockReset();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vs-'));
    try {
      const svc = new OpenCodeService({ registryPath: path.join(tmpDir, 'reg.json') });
      const available = await svc.isAvailable();
      expect(typeof available).toBe('boolean');
      await svc.shutdown().catch(() => {});
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

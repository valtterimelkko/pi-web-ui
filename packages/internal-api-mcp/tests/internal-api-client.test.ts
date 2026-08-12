import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { loadConfig, type McpConfig } from '../src/config.js';
import { InternalApiClient, InternalApiClientError } from '../src/internal-api-client.js';

const contract = {
  name: 'pi-web-ui-internal-api',
  routePrefix: '/api/v1',
  majorVersion: 'v1',
  contractVersion: '1.19.0',
  stability: 'beta',
};

const capabilities = {
  status: 'ok',
  contract,
  features: {
    piProviderPolicy: { blockedProviders: ['openai', 'openrouter'] },
    futureSecret: 'must-not-be-forwarded',
  },
  runtimes: {
    pi: { available: true, enabled: true, backendMode: 'native' },
    claude: { available: true, enabled: true, backendMode: 'sdk' },
    opencode: { available: false, enabled: false, backendMode: 'server' },
    antigravity: { available: false, enabled: false, backendMode: 'subprocess' },
    commandcode: { available: true, enabled: true },
  },
};

interface FakeApi {
  dir: string;
  socketPath: string;
  tokenPath: string;
  server: Server;
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>;
  replaceSocket?: () => Promise<void>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function makeFakeApi(
  handler: (req: IncomingMessage, body: string, res: ServerResponse, api: FakeApi) => void | Promise<void>,
  options: { token?: string } = {},
): Promise<FakeApi> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-mcp-client-'));
  const socketPath = path.join(dir, 'internal-api.sock');
  const tokenPath = path.join(dir, 'internal-api-token');
  await writeFile(tokenPath, options.token ?? 'sentinel-token', { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const requests: FakeApi['requests'] = [];

  const api = {} as FakeApi;
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    await handler(req, body, res, api);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);

  api.dir = dir;
  api.socketPath = socketPath;
  api.tokenPath = tokenPath;
  api.server = server;
  api.requests = requests;
  api.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  };
  api.replaceSocket = async () => {
    const movedPath = path.join(dir, 'old-internal-api.sock');
    await rename(socketPath, movedPath);
    const replacement = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('replacement');
    });
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(socketPath, () => resolve());
    });
    await chmod(socketPath, 0o600);
  };
  return api;
}

function configFor(api: FakeApi, overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    ...loadConfig({
      PI_WEB_UI_MCP_SOCKET_PATH: api.socketPath,
      PI_WEB_UI_MCP_TOKEN_PATH: api.tokenPath,
      PI_WEB_UI_MCP_TIMEOUT_MS: '500',
      PI_WEB_UI_MCP_MAX_RESPONSE_BYTES: '4096',
      PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES: '2048',
    }),
    ...overrides,
  };
}

async function jsonResponse(res: ServerResponse, status: number, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

describe('InternalApiClient', () => {
  const apis: FakeApi[] = [];
  afterEach(async () => {
    await Promise.all(apis.splice(0).map((api) => api.close()));
  });

  it('sends bearer auth and the exact fixed capabilities route', async () => {
    const api = await makeFakeApi(async (_req, _body, res) => jsonResponse(res, 200, capabilities));
    apis.push(api);
    const result = await new InternalApiClient(configFor(api)).getCapabilities();

    expect(result.contract).toEqual(contract);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(api.requests[0].headers.authorization).toBe('Bearer sentinel-token');
  });

  it('percent-encodes query values and parses model data after a compatibility check', async () => {
    const api = await makeFakeApi(async (req, _body, res) => {
      if (req.url === '/api/v1/capabilities') return jsonResponse(res, 200, capabilities);
      return jsonResponse(res, 200, { models: { claude: [{ id: 'profile:glm/5', displayName: 'GLM' }], commandcode: [{ id: 'secret' }] } });
    });
    apis.push(api);
    const result = await new InternalApiClient(configFor(api)).listModels('claude');

    expect(result.models.claude[0]?.id).toBe('profile:glm/5');
    expect(api.requests.map((request) => request.url)).toEqual(['/api/v1/capabilities', '/api/v1/models?runtime=claude']);
  });

  it('accepts the Internal API transcript timestamp representation', async () => {
    const api = await makeFakeApi(async (req, _body, res) => {
      if (req.url === '/api/v1/capabilities') return jsonResponse(res, 200, capabilities);
      if (req.url?.startsWith('/api/v1/sessions/') && req.url.includes('/transcript?')) {
        return jsonResponse(res, 200, {
          sessionId: 'session-1',
          runtime: 'pi',
          scope: 'visible_recent',
          itemCount: 1,
          truncated: false,
          items: [{ kind: 'assistant', text: 'OK', timestamp: '2026-08-11T18:05:08.083Z' }],
        });
      }
      return jsonResponse(res, 404, { error: 'unexpected', code: 'NOT_FOUND' });
    });
    apis.push(api);
    await expect(new InternalApiClient(configFor(api)).getTranscript('session-1')).resolves.toMatchObject({ items: [{ timestamp: '2026-08-11T18:05:08.083Z' }] });
  });

  it('omits the model query when no runtime filter is requested', async () => {
    const api = await makeFakeApi(async (req, _body, res) => {
      if (req.url === '/api/v1/capabilities') return jsonResponse(res, 200, capabilities);
      return jsonResponse(res, 200, { models: { pi: [{ id: 'model-1' }] } });
    });
    apis.push(api);
    await new InternalApiClient(configFor(api)).listModels();
    expect(api.requests.map((request) => request.url)).toEqual(['/api/v1/capabilities', '/api/v1/models']);
  });

  it('constructs create and detached dispatch requests without allowing route fragments', async () => {
    const api = await makeFakeApi(async (req, body, res) => {
      if (req.url === '/api/v1/capabilities') return jsonResponse(res, 200, capabilities);
      if (req.url === '/api/v1/sessions') return jsonResponse(res, 201, { sessionId: 'session-1', sessionPath: 'session-1', runtime: 'pi', model: 'model-1', createdAt: '2026-01-01T00:00:00.000Z', cwd: '/tmp' });
      return jsonResponse(res, 202, { sessionId: 'session/1', runId: 'run-1', detached: true, status: 'accepted' });
    });
    apis.push(api);
    const client = new InternalApiClient(configFor(api));

    await client.createSession({ runtime: 'pi', model: 'model-1', cwd: '/tmp' });
    await client.dispatchPrompt('session/1', { message: 'hello', idempotencyKey: 'key-1' });

    expect(api.requests.map((request) => request.url)).toEqual([
      '/api/v1/capabilities',
      '/api/v1/sessions',
      '/api/v1/capabilities',
      '/api/v1/sessions/session%2F1/prompt',
    ]);
    expect(JSON.parse(api.requests[1]!.body)).toEqual({ runtime: 'pi', model: 'model-1', cwd: '/tmp' });
    expect(JSON.parse(api.requests[3]!.body)).toEqual({ message: 'hello', idempotencyKey: 'key-1', verbosity: 'answers', mode: 'prompt', detach: true });
    expect(api.requests[3]!.headers['idempotency-key']).toBe('key-1');
  });

  it('preserves safe structured API error fields without leaking raw response data', async () => {
    const api = await makeFakeApi(async (req, _body, res) => {
      if (req.url === '/api/v1/capabilities') return jsonResponse(res, 200, capabilities);
      return jsonResponse(res, 403, {
        error: 'Bearer sentinel-token must not be returned',
        code: 'PROVIDER_NOT_ALLOWED',
        hint: 'token=sentinel-token',
        docs: 'authorization: secret-cookie',
        cookie: 'session=secret-cookie',
      });
    });
    apis.push(api);

    const error = await new InternalApiClient(configFor(api)).listModels('pi').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ status: 403, code: 'PROVIDER_NOT_ALLOWED' });
    expect((error as InternalApiClientError).hint).toBeUndefined();
    expect((error as InternalApiClientError).docs).toBeUndefined();
    expect(String(error)).not.toContain('sentinel-token');
    expect(String(error)).not.toContain('secret-cookie');
  });

  it('times out and closes a stalled request', async () => {
    const api = await makeFakeApi(async () => {
      await new Promise<void>(() => {});
    });
    apis.push(api);

    const error = await new InternalApiClient(configFor(api, { timeoutMs: 25 })).getCapabilities().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true });
  });

  it('rejects an oversized response before JSON parsing', async () => {
    const api = await makeFakeApi(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('x'.repeat(5000));
    });
    apis.push(api);

    const error = await new InternalApiClient(configFor(api, { maxResponseBytes: 100 })).getCapabilities().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(String(error)).not.toContain('x'.repeat(100));
  });

  it('rejects malformed or non-JSON successful responses', async () => {
    const api = await makeFakeApi(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('not-json');
    });
    apis.push(api);

    const error = await new InternalApiClient(configFor(api)).getCapabilities().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(error)).not.toContain('not-json');
  });

  it('rejects an already-aborted request before opening the socket', async () => {
    const api = await makeFakeApi(async (_req, _body, res) => jsonResponse(res, 200, capabilities));
    apis.push(api);
    const controller = new AbortController();
    controller.abort();
    const error = await new InternalApiClient(configFor(api)).getCapabilities(controller.signal).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'REQUEST_CANCELLED', retryable: false });
    expect(api.requests).toHaveLength(0);
  });

  it('supports cancellation and closes the request', async () => {
    const api = await makeFakeApi(async () => {
      await new Promise<void>(() => {});
    });
    apis.push(api);
    const controller = new AbortController();
    const promise = new InternalApiClient(configFor(api)).getCapabilities(controller.signal).catch((value: unknown) => value);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const error = await promise;
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'REQUEST_CANCELLED', retryable: false });
  });

  it('accepts the minimum supported contract version when identity matches', async () => {
    const api = await makeFakeApi(async (_req, _body, res) => jsonResponse(res, 200, {
      ...capabilities,
      contract: { ...contract, contractVersion: '1.6.0' },
    }));
    apis.push(api);
    await expect(new InternalApiClient(configFor(api)).getCapabilities()).resolves.toBeDefined();
  });

  it('rejects incompatible identity and minimum contract versions', async () => {
    const api = await makeFakeApi(async (_req, _body, res) => jsonResponse(res, 200, {
      ...capabilities,
      contract: { ...contract, name: 'other-api', contractVersion: 'not-semver' },
    }));
    apis.push(api);

    const error = await new InternalApiClient(configFor(api)).getCapabilities().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'INCOMPATIBLE_CONTRACT', retryable: false });
  });

  it('fails closed when the socket pathname is replaced during a response', async () => {
    const holder: { api?: FakeApi } = {};
    const api = await makeFakeApi(async (_req, _body, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.write(JSON.stringify(capabilities));
      await holder.api?.replaceSocket?.();
      res.end();
    });
    holder.api = api;
    apis.push(api);

    const error = await new InternalApiClient(configFor(api)).getCapabilities().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(InternalApiClientError);
    expect(error).toMatchObject({ code: 'UNSAFE_LOCAL_PATH' });
  });
});

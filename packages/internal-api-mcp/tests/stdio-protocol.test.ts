import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeAll, afterEach } from 'vitest';

const execFileAsync = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, '..');
const compiledEntry = path.join(packageDir, 'dist', 'index.js');
const contract = {
  name: 'pi-web-ui-internal-api',
  routePrefix: '/api/v1',
  majorVersion: 'v1',
  contractVersion: '1.19.0',
};
const capabilities = {
  status: 'ok',
  contract,
  features: { piProviderPolicy: { blockedProviders: ['openai'] } },
  runtimes: { pi: { available: true, enabled: true, backendMode: 'native' } },
};

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

interface FakeServer {
  dir: string;
  socketPath: string;
  tokenPath: string;
  server: Server;
  failModels: boolean;
  paths: string[];
  close(): Promise<void>;
}

async function startFakeServer(): Promise<FakeServer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-mcp-stdio-'));
  const socketPath = path.join(dir, 'internal-api.sock');
  const tokenPath = path.join(dir, 'internal-api-token');
  await writeFile(tokenPath, 'stdio-sentinel-token', { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const fake = {} as FakeServer;
  const server = createServer(async (req, res) => {
    fake.paths.push(req.url ?? '');
    await bodyOf(req);
    if (req.url === '/api/v1/capabilities') return sendJson(res, 200, capabilities);
    if (req.url === '/api/v1/models' || req.url?.startsWith('/api/v1/models?')) {
      if (fake.failModels) return sendJson(res, 503, { error: 'runtime unavailable', code: 'RUNTIME_UNAVAILABLE', hint: 'try later' });
      return sendJson(res, 200, { models: { pi: [{ id: 'model-1', displayName: 'Model 1' }] } });
    }
    if (req.url === '/api/v1/sessions') return sendJson(res, 200, { sessions: [{ sessionId: '11111111-1111-4111-8111-111111111111', runtime: 'pi', status: 'idle' }] });
    return sendJson(res, 404, { error: 'unexpected', code: 'NOT_FOUND' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);
  fake.dir = dir;
  fake.socketPath = socketPath;
  fake.tokenPath = tokenPath;
  fake.server = server;
  fake.failModels = false;
  fake.paths = [];
  fake.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  };
  return fake;
}

async function waitForExit(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error(`MCP process ${pid} did not exit`);
}

describe('compiled stdio MCP protocol', () => {
  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build', '--workspace=@pi-web-ui/internal-api-mcp'], { cwd: path.resolve(packageDir, '../..') });
  }, 120_000);

  const active: Array<{ client: Client; transport: StdioClientTransport; pid: number; fake: FakeServer; stderr: string[] }> = [];

  afterEach(async () => {
    for (const entry of active.splice(0)) {
      let cleanupError: unknown;
      try {
        await entry.client.close();
        await entry.transport.close();
        await waitForExit(entry.pid);
      } catch (error) {
        cleanupError = error;
      } finally {
        await entry.fake.close();
        expect(entry.stderr.join('')).not.toContain('stdio-sentinel-token');
      }
      if (cleanupError) throw cleanupError;
    }
  });

  async function connectClient(): Promise<{ client: Client; transport: StdioClientTransport; pid: number; fake: FakeServer; stderr: string[] }> {
    const fake = await startFakeServer();
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledEntry],
      stderr: 'pipe',
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH ?? '',
        PI_WEB_UI_MCP_SOCKET_PATH: fake.socketPath,
        PI_WEB_UI_MCP_TOKEN_PATH: fake.tokenPath,
        PI_WEB_UI_MCP_TIMEOUT_MS: '1000',
        PI_WEB_UI_MCP_MAX_RESPONSE_BYTES: '4096',
        PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES: '4096',
      },
      cwd: packageDir,
    });
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    const client = new Client({ name: 'stdio-test-client', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const pid = transport.pid;
      if (!pid) throw new Error('stdio child did not expose a pid');
      const result = { client, transport, pid, fake, stderr };
      active.push(result);
      return result;
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await fake.close();
      throw error;
    }
  }

  it('initializes the compiled server and lists exactly seven tools with annotations', async () => {
    const { client } = await connectClient();
    expect(client.getServerVersion()).toMatchObject({ name: 'pi-web-ui-internal-api-mcp', version: '0.1.0' });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'pi_web_ui_get_capabilities',
      'pi_web_ui_list_models',
      'pi_web_ui_list_sessions',
      'pi_web_ui_create_session',
      'pi_web_ui_dispatch_prompt',
      'pi_web_ui_get_run',
      'pi_web_ui_get_transcript',
    ]);
    expect(listed.tools).toHaveLength(7);
    expect(listed.tools.find((tool) => tool.name === 'pi_web_ui_get_capabilities')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(listed.tools.find((tool) => tool.name === 'pi_web_ui_dispatch_prompt')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('traverses MCP to the fake Unix socket and returns JSON content', async () => {
    const { client, fake } = await connectClient();
    const result = await client.callTool({ name: 'pi_web_ui_get_capabilities', arguments: {} });
    expect(result.isError).not.toBe(true);
    const envelope = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '');
    expect(envelope).toMatchObject({ ok: true, tool: 'pi_web_ui_get_capabilities', data: { contract } });
    expect(fake.paths).toEqual(['/api/v1/capabilities']);
  });

  it('returns protocol-valid errors for invalid arguments and structured API failures', async () => {
    const { client, fake } = await connectClient();
    const invalid = await client.callTool({ name: 'pi_web_ui_list_sessions', arguments: { extra: true } });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]?.type).toBe('text');
    fake.failModels = true;
    const failed = await client.callTool({ name: 'pi_web_ui_list_models', arguments: { runtime: 'pi' } });
    expect(failed.isError).toBe(true);
    const envelope = JSON.parse(failed.content[0]!.type === 'text' ? failed.content[0]!.text : '');
    expect(envelope.error).toMatchObject({ code: 'RUNTIME_UNAVAILABLE', retryable: true });
  });

  it('rejects unknown tools and closes the compiled process cleanly', async () => {
    const { client, pid } = await connectClient();
    const unknown = await client.callTool({ name: 'not_a_tool', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.type === 'text' ? unknown.content[0].text : '').toContain('not found');
    await client.close();
    await waitForExit(pid);
  });
});

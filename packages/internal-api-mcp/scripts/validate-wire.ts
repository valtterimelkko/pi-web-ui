import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { withValidationCleanup } from '../src/validation-safety.js';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, '../../..');
const packageDir = path.resolve(import.meta.dirname, '..');
const compiledEntry = path.join(packageDir, 'dist', 'index.js');
const sentinelToken = 'mcp-wire-sentinel-token';
const expectedTools = [
  'pi_web_ui_get_capabilities',
  'pi_web_ui_list_models',
  'pi_web_ui_list_sessions',
  'pi_web_ui_create_session',
  'pi_web_ui_dispatch_prompt',
  'pi_web_ui_get_run',
  'pi_web_ui_get_transcript',
];
const wireSessionId = '11111111-1111-4111-8111-111111111111';
const wireRunId = '22222222-2222-4222-8222-222222222222';
const contract = {
  name: 'pi-web-ui-internal-api',
  routePrefix: '/api/v1',
  majorVersion: 'v1',
  contractVersion: '1.19.0',
};

async function bodyOf(req: IncomingMessage): Promise<void> {
  for await (const chunk of req) {
    // The fake server deliberately consumes request bodies without retaining them.
    void chunk;
  }
}

async function sendJson(res: ServerResponse, status: number, value: unknown): Promise<void> {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

interface FakeApi {
  dir: string;
  socketPath: string;
  tokenPath: string;
  server: Server;
  requests: Array<{ method: string; url: string; authorization?: string }>;
  unexpected: string[];
  failModels: boolean;
}

async function startFakeApi(): Promise<FakeApi> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-mcp-wire-'));
  const socketPath = path.join(dir, 'internal-api.sock');
  const tokenPath = path.join(dir, 'internal-api-token');
  await writeFile(tokenPath, sentinelToken, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const api = {} as FakeApi;
  const server = createServer(async (req, res) => {
    await bodyOf(req);
    const url = req.url ?? '';
    api.requests.push({ method: req.method ?? '', url, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${sentinelToken}`) {
      return sendJson(res, 401, { error: 'unauthorized', code: 'UNAUTHORIZED' });
    }
    if (req.method === 'GET' && url === '/api/v1/capabilities') {
      return sendJson(res, 200, {
        status: 'ok',
        contract,
        features: { piProviderPolicy: { blockedProviders: ['openai', 'openrouter'] } },
        runtimes: { pi: { available: true, enabled: true, backendMode: 'native' }, commandcode: { available: true } },
      });
    }
    if (req.method === 'GET' && (url === '/api/v1/models' || url.startsWith('/api/v1/models?'))) {
      if (api.failModels) return sendJson(res, 503, { error: 'runtime unavailable', code: 'RUNTIME_UNAVAILABLE', hint: 'retry later' });
      return sendJson(res, 200, {
        models: { pi: [{ id: 'model-1', displayName: 'Model 1', provider: 'pi' }], commandcode: [{ id: 'qwen/qwen3.8-max' }] },
      });
    }
    if (req.method === 'GET' && url === '/api/v1/sessions') {
      return sendJson(res, 200, {
        sessions: [{ sessionId: wireSessionId, runtime: 'pi', status: 'idle', sessionPath: '/secret/native.jsonl' }],
      });
    }
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      return sendJson(res, 201, {
        sessionId: wireSessionId,
        runtime: 'pi',
        model: 'model-1',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    }
    if (req.method === 'POST' && url === `/api/v1/sessions/${wireSessionId}/prompt`) {
      return sendJson(res, 202, {
        sessionId: wireSessionId,
        runId: wireRunId,
        detached: true,
        status: 'accepted',
      });
    }
    if (req.method === 'GET' && url === `/api/v1/runs/${wireRunId}`) {
      return sendJson(res, 200, {
        runId: wireRunId,
        sessionId: wireSessionId,
        runtime: 'pi',
        status: 'completed',
        outputEvidence: { disposition: 'text' },
      });
    }
    if (req.method === 'GET' && url === `/api/v1/sessions/${wireSessionId}/transcript?scope=visible_full`) {
      return sendJson(res, 200, {
        sessionId: wireSessionId,
        runtime: 'pi',
        scope: 'visible_full',
        items: [{ kind: 'assistant', text: 'wire answer' }],
      });
    }
    api.unexpected.push(`${req.method ?? ''} ${url}`);
    return sendJson(res, 404, { error: 'unexpected route', code: 'NOT_FOUND' });
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
  api.requests = [];
  api.unexpected = [];
  api.failModels = false;
  return api;
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return;
    }
  }
  throw new Error('MCP child did not exit within the cleanup deadline');
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  return item?.type === 'text' ? item.text ?? '' : '';
}

async function run(): Promise<void> {
  await execFileAsync('npm', ['run', 'build', '--workspace=@pi-web-ui/internal-api-mcp'], { cwd: rootDir });
  const api = await startFakeApi();
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  let pid: number | undefined;
  const stderr: string[] = [];

  await withValidationCleanup(async () => {
    await client?.close();
    await transport?.close();
    if (pid) await waitForExit(pid);
    await new Promise<void>((resolve, reject) => api.server.close((error) => error ? reject(error) : resolve()));
    await rm(api.dir, { recursive: true, force: true });
  }, async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [compiledEntry],
      stderr: 'pipe',
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH ?? '',
        PI_WEB_UI_MCP_SOCKET_PATH: api.socketPath,
        PI_WEB_UI_MCP_TOKEN_PATH: api.tokenPath,
        PI_WEB_UI_MCP_TIMEOUT_MS: '1500',
        PI_WEB_UI_MCP_MAX_RESPONSE_BYTES: '4096',
        PI_WEB_UI_MCP_MAX_TOOL_OUTPUT_BYTES: '4096',
      },
      cwd: packageDir,
    });
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    client = new Client({ name: 'pi-web-ui-mcp-wire-validator', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    pid = transport.pid ?? undefined;
    if (!pid) throw new Error('compiled MCP process did not expose a pid');

    const serverVersion = client.getServerVersion();
    if (serverVersion?.name !== 'pi-web-ui-internal-api-mcp' || serverVersion.version !== '0.1.0') throw new Error('unexpected MCP server identity');
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    if (JSON.stringify(names) !== JSON.stringify(expectedTools)) throw new Error('MCP tool catalogue drifted from the seven-tool MVP');
    if (!listed.tools.find((tool) => tool.name === 'pi_web_ui_get_capabilities')?.annotations?.readOnlyHint) throw new Error('read-only annotation missing');
    if (!listed.tools.find((tool) => tool.name === 'pi_web_ui_dispatch_prompt')?.annotations?.destructiveHint) throw new Error('dispatch destructive annotation missing');

    await client.callTool({ name: 'pi_web_ui_get_capabilities', arguments: {} });
    await client.callTool({ name: 'pi_web_ui_list_models', arguments: { runtime: 'pi' } });
    await client.callTool({ name: 'pi_web_ui_list_sessions', arguments: {} });
    const created = await client.callTool({ name: 'pi_web_ui_create_session', arguments: { runtime: 'pi', model: 'model-1' } });
    if (created.isError) throw new Error('compiled create-session tool failed on the wire');
    const dispatched = await client.callTool({ name: 'pi_web_ui_dispatch_prompt', arguments: { sessionId: wireSessionId, message: 'wire validation prompt' } });
    if (dispatched.isError) throw new Error('compiled dispatch tool failed on the wire');
    const run = await client.callTool({ name: 'pi_web_ui_get_run', arguments: { runId: wireRunId } });
    if (run.isError) throw new Error('compiled run-receipt tool failed on the wire');
    const transcript = await client.callTool({ name: 'pi_web_ui_get_transcript', arguments: { sessionId: wireSessionId, scope: 'visible_full' } });
    if (transcript.isError) throw new Error('compiled transcript tool failed on the wire');
    const invalid = await client.callTool({ name: 'pi_web_ui_list_sessions', arguments: { unexpected: true } });
    if (!invalid.isError) throw new Error('invalid schema call unexpectedly succeeded');

    api.failModels = true;
    const failed = await client.callTool({ name: 'pi_web_ui_list_models', arguments: { runtime: 'pi' } });
    if (!failed.isError || !textOf(failed).includes('RUNTIME_UNAVAILABLE')) throw new Error('structured API error was not preserved');
    if (stderr.join('').includes(sentinelToken)) throw new Error('token appeared on MCP stderr');
    if (api.unexpected.length > 0) throw new Error(`unexpected fake API route: ${api.unexpected[0]}`);
  });

  const report = [
    '✅ MCP WIRE-VALIDATED',
    'MCP protocol/client initialization: passed',
    `Server: ${'pi-web-ui-internal-api-mcp'} / 0.1.0`,
    `Tools: ${expectedTools.length} exact names, annotations, and compiled calls passed`,
    `Fake socket: ${api.socketPath}`,
    'Fixed-route/auth assertions: passed',
    'Schema and structured-error assertions: passed',
    'Stdout protocol cleanliness: passed (official SDK initialization/list/call succeeded)',
    'Stderr/token sentinel scan: passed',
    'Cleanup: MCP exited, fake socket server stopped, temporary directory removed',
  ].join('\n');
  console.log(report);
}

run().catch((error: unknown) => {
  console.error(`❌ MCP WIRE VALIDATION FAILED: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});

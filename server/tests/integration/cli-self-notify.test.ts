/**
 * Integration: scripts/notify.sh — the terminal CLI self-notification helper.
 *
 * Spawns the real bash script against a mock Unix-socket HTTP server that
 * mimics POST /api/v1/notifications, and asserts the script forms the request
 * correctly (method, path, bearer token, JSON body with the standard emoji
 * formatting) and maps HTTP status / missing-socket to the right exit code.
 *
 * The script is what an agent (claude / glm / pi / opencode / agy) calls from
 * the terminal to ping the operator; this test pins its contract so the docs
 * that tell agents to call it stay accurate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR_HERE = path.dirname(fileURLToPath(import.meta.url));
// server/tests/integration → up three → repo root → scripts/notify.sh
const SCRIPT = path.resolve(TEST_DIR_HERE, '..', '..', '..', 'scripts', 'notify.sh');
const FAKE_TOKEN = 'test-bearer-token-12345';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function buildServer(
  socketPath: string,
  captured: CapturedRequest[],
  status: number,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', contract: { name: 'pi-web-ui-internal-api' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'accepted',
        notification: { id: 'fake-id', createdAt: 'now' },
        statusUrl: '/api/v1/notifications/fake-id',
      }));
    });
  });
  return server;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  args: string[],
  envOverrides: Record<string, string>,
  stdin?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += c;
    });
    child.stderr?.on('data', (c) => {
      stderr += c;
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? null, stdout, stderr }));
  });
}

describe('scripts/notify.sh — CLI self-notification helper', () => {
  let dir: string;
  let socketPath: string;
  let tokenPath: string;
  let server: http.Server;
  let captured: CapturedRequest[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-notify-script-'));
    socketPath = path.join(dir, 'internal-api.sock');
    tokenPath = path.join(dir, 'internal-api-token');
    await fs.writeFile(tokenPath, FAKE_TOKEN, { mode: 0o600 });
    captured = [];
    server = buildServer(socketPath, captured, 202);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function env(): Record<string, string> {
    return {
      PI_WEB_UI_NOTIFY_SOCKET: socketPath,
      PI_WEB_UI_NOTIFY_TOKEN_FILE: tokenPath,
      PI_WEB_UI_NOTIFY_WAIT_MS: '1000',
      PI_WEB_UI_NOTIFY_RETRY_MS: '20',
      PI_WEB_UI_NOTIFY_SPOOL_DIR: path.join(dir, 'ingress'),
    };
  }

  it('POSTs a well-formed done notification to the explicit-emit endpoint', async () => {
    const res = await runScript(['done', 'restarted prod', 'all green; service restarted.'], env());
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('/api/v1/notifications/fake-id');
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/notifications');
    expect(req.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(req.body)).toEqual({
      title: '✅ Done: restarted prod',
      body: 'all green; service restarted.',
    });
  });

  it('formats question and blocked kinds with the standard prefixes', async () => {
    await runScript(['question', 'which index?', 'add index on sessions.userId?'], env());
    expect(JSON.parse(captured[0].body).title).toBe('❓ Question: which index?');

    await runScript(['blocked', 'need creds', 'no TELEGRAM_BOT_TOKEN set'], env());
    expect(JSON.parse(captured[1].body).title).toBe('⚠️ Blocked: need creds');
  });

  it('formats milestone notifications with a low-noise progress prefix', async () => {
    await runScript(['milestone', 'phase 3 complete', 'health and diagnostics green'], env());
    expect(JSON.parse(captured[0].body).title).toBe('📍 Milestone: phase 3 complete');
  });

  it('accepts a custom kind as a literal label', async () => {
    await runScript(['deploy', 'staging pushed', 'sha abc123'], env());
    expect(JSON.parse(captured[0].body).title).toBe('📢 deploy: staging pushed');
  });

  it('reads the body from stdin when omitted', async () => {
    const res = await runScript(['done', 'summary only'], env(), 'piped body via stdin');
    expect(res.code).toBe(0);
    expect(JSON.parse(captured[0].body).body).toBe('piped body via stdin');
  });

  it('falls back to the title summary as body when no body is given', async () => {
    // No stdin (child.stdin.end() with nothing), no body arg → body = title summary.
    const res = await runScript(['done', 'nothing else'], env());
    expect(res.code).toBe(0);
    expect(JSON.parse(captured[0].body).body).toBe('nothing else');
  });

  it('preserves multi-line / special characters in the body (safe JSON escaping)', async () => {
    const tricky = 'line one\nline "two" with quotes & backslash: \\ done\n\tindented';
    const res = await runScript(['done', 'tricky body', tricky], env());
    expect(res.code).toBe(0);
    expect(JSON.parse(captured[0].body).body).toBe(tricky);
  });

  it('durably spools and exits successfully when the restart wait expires', async () => {
    const spoolDir = path.join(dir, 'offline-ingress');
    const res = await runScript(
      ['done', 'x', 'y'],
      {
        ...env(),
        PI_WEB_UI_NOTIFY_SOCKET: path.join(dir, 'does-not-exist.sock'),
        PI_WEB_UI_NOTIFY_WAIT_MS: '0',
        PI_WEB_UI_NOTIFY_SPOOL_DIR: spoolDir,
      },
    );
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('queued locally');
    const files = await fs.readdir(spoolDir);
    expect(files).toHaveLength(1);
    const queued = JSON.parse(await fs.readFile(path.join(spoolDir, files[0]), 'utf8')) as {
      idempotencyKey: string;
      title: string;
    };
    expect(queued.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(queued.title).toBe('✅ Done: x');
  });

  it('keeps an existing same-key spool record and refuses a conflicting overwrite', async () => {
    const spoolDir = path.join(dir, 'collision-ingress');
    const offlineEnv = {
      ...env(),
      PI_WEB_UI_NOTIFY_SOCKET: path.join(dir, 'offline.sock'),
      PI_WEB_UI_NOTIFY_WAIT_MS: '0',
      PI_WEB_UI_NOTIFY_SPOOL_DIR: spoolDir,
      PI_WEB_UI_NOTIFY_IDEMPOTENCY_KEY: 'stable-key',
    };

    expect((await runScript(['done', 'same', 'payload'], offlineEnv)).code).toBe(0);
    expect((await runScript(['done', 'same', 'payload'], offlineEnv)).code).toBe(0);
    const [fileName] = await fs.readdir(spoolDir);
    const recordPath = path.join(spoolDir, fileName);
    const before = await fs.readFile(recordPath, 'utf8');

    const conflict = await runScript(['done', 'same', 'different'], offlineEnv);
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain('conflict');
    expect(await fs.readFile(recordPath, 'utf8')).toBe(before);
  });

  it('waits for a restarting server and submits once using the same durable key', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const pending = runScript(['done', 'waited', 'ready now'], {
      ...env(),
      PI_WEB_UI_NOTIFY_WAIT_MS: '2000',
      PI_WEB_UI_NOTIFY_RETRY_MS: '20',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    server = buildServer(socketPath, captured, 202);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const res = await pending;
    expect(res.code).toBe(0);
    expect(captured).toHaveLength(1);
  });

  it('treats HTTP 429 as retryable and spools after the bounded wait', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = buildServer(socketPath, captured, 429);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const spoolDir = path.join(dir, 'rate-limited-ingress');

    const res = await runScript(['done', 'x', 'y'], {
      ...env(),
      PI_WEB_UI_NOTIFY_WAIT_MS: '0',
      PI_WEB_UI_NOTIFY_SPOOL_DIR: spoolDir,
    });

    expect(res.code).toBe(0);
    expect(res.stderr).toContain('queued locally');
    expect(await fs.readdir(spoolDir)).toHaveLength(1);
  });

  it('exits non-zero and surfaces the status when the server rejects (HTTP 4xx)', async () => {
    // Recreate the server with a 400 status for this test only.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = buildServer(socketPath, captured, 400);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const res = await runScript(['done', 'x', 'y'], env());
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('HTTP 400');
    await expect(fs.readdir(path.join(dir, 'ingress'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

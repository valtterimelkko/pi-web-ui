import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const LOCK_SCRIPT = path.join(ROOT, 'scripts', 'with-production-lock.sh');
const WAIT_SCRIPT = path.join(ROOT, 'scripts', 'wait-for-internal-api.mjs');

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(command: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    collect(child).then(resolve, reject);
  });
}

function collect(child: ChildProcess): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('production-control helper scripts', () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'pi-production-control-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('holds one flock for the entire argument-vector command and preserves exit status', async () => {
    const lockPath = path.join(dir, 'production.lock');
    const first = spawn('bash', [LOCK_SCRIPT, 'bash', '-c', 'sleep 0.25; exit 7'], {
      env: { ...process.env, PI_WEB_UI_PRODUCTION_LOCK: lockPath },
    });
    const completedPromise = collect(first);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const blocked = await run('bash', [LOCK_SCRIPT, 'true'], { PI_WEB_UI_PRODUCTION_LOCK: lockPath });
    const completed = await completedPromise;

    expect(blocked.code).toBe(75);
    expect(blocked.stderr).toContain('already in progress');
    expect(completed.code).toBe(7);
  });

  it('refuses a symbolic-link lock path without modifying its target', async () => {
    const target = path.join(dir, 'target');
    const lockPath = path.join(dir, 'production.lock');
    await writeFile(target, 'do-not-touch');
    await symlink(target, lockPath);

    const result = await run('bash', [LOCK_SCRIPT, 'true'], { PI_WEB_UI_PRODUCTION_LOCK: lockPath });

    expect(result.code).toBe(73);
    expect(result.stderr).toContain('symbolic-link');
    expect(await readFile(target, 'utf8')).toBe('do-not-touch');
  });

  it('passes metacharacters as literal arguments instead of evaluating them', async () => {
    const marker = path.join(dir, 'must-not-exist');
    const result = await run('bash', [
      LOCK_SCRIPT,
      process.execPath,
      '-e',
      'process.stdout.write(process.argv[1])',
      `literal;touch ${marker}`,
    ], { PI_WEB_UI_PRODUCTION_LOCK: path.join(dir, 'literal.lock') });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`literal;touch ${marker}`);
    await expect(import('node:fs/promises').then((fs) => fs.stat(marker))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits until the expected Internal API appears on the disposable socket', async () => {
    const socketPath = path.join(dir, 'api.sock');
    const pending = run(process.execPath, [WAIT_SCRIPT], {
      PI_WEB_UI_WAIT_SOCKET: socketPath,
      PI_WEB_UI_WAIT_TIMEOUT_MS: '2000',
      PI_WEB_UI_WAIT_INTERVAL_MS: '20',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', contract: { name: 'pi-web-ui-internal-api' } }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const result = await pending;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ready');
  });

  it('times out on a socket serving the wrong API identity', async () => {
    const socketPath = path.join(dir, 'wrong.sock');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', contract: { name: 'something-else' } }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const result = await run(process.execPath, [WAIT_SCRIPT], {
      PI_WEB_UI_WAIT_SOCKET: socketPath,
      PI_WEB_UI_WAIT_TIMEOUT_MS: '100',
      PI_WEB_UI_WAIT_INTERVAL_MS: '20',
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('timed out');
  });
});

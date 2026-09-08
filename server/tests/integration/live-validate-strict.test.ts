import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface StubOptions {
  buildMode: string;
}

async function startStubBackend(options: StubOptions): Promise<{ socketPath: string; tokenPath: string; recordDir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'pi-live-validate-strict-'));
  temporaryRoots.push(root);
  const socketPath = join(root, 'validation.sock');
  const tokenPath = join(root, 'validation-token');
  const recordDir = join(root, 'records');
  mkdirSync(recordDir);
  writeFileSync(tokenPath, 'strict-test-token\n', 'utf8');

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/v1/health') {
      send(200, {
        status: 'ok',
        uptime: 1,
        buildIdentity: { buildId: `build-stub-${options.buildMode}`, identityStatus: 'known', buildMode: options.buildMode },
        bootIdentity: { bootId: 'boot-stub-1', startedAt: new Date().toISOString() },
      });
      return;
    }
    if (req.url === '/api/v1/capabilities') {
      send(200, {
        contract: { contractVersion: '1.36.0' },
        runtimes: {
          pi: { enabled: true, available: true },
          claude: { enabled: true, available: false },
          opencode: { enabled: false, available: false },
          antigravity: { enabled: false, available: false },
          commandcode: { enabled: true, available: false },
        },
      });
      return;
    }
    send(404, { error: 'not found in stub' });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(socketPath, done));
  return { socketPath, tokenPath, recordDir };
}

async function runWrapper(socketPath: string, tokenPath: string, recordDir: string, extraArgs: string[]) {
  const scriptPath = join(repoRoot, 'scripts/live-validate.ts');
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  // Async spawn (not spawnSync): the stub backend lives in this worker's event
  // loop and must keep serving the child's HTTP requests while we wait.
  const child = spawn(
    tsxCli,
    [scriptPath,
      '--socket', socketPath, '--token-path', tokenPath, '--record-dir', recordDir, ...extraArgs],
    {
      cwd: repoRoot,
      // The vitest worker environment (loader flags, pool vars) must not leak
      // into the spawned validation wrapper: run it with a clean node env.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('VITEST_') && !['NODE_OPTIONS', 'NODE_ENV'].includes(key))),
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 25_000);
    child.on('error', (error) => { clearTimeout(timer); console.error('WRAPPER SPAWN ERROR:', error.message); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  if (status === -1) throw new Error('wrapper spawn failed; see SPAWN ERROR above');
  return { status, stdout, stderr };
}

function readWrittenRecord(recordDir: string): Record<string, unknown> {
  const files = readdirSync(recordDir).filter((name) => name.startsWith('acceptance-') && name.endsWith('.json'));
  expect(files.length).toBeGreaterThanOrEqual(1);
  const latest = files.sort().at(-1);
  return JSON.parse(readFileSync(join(recordDir, latest), 'utf8'));
}

describe('live-validate strict wrapper (real entrypoint against stub backend)', () => {
  it('refuses the wrong build mode before running scenarios and exits non-zero', async () => {
    const stub = await startStubBackend({ buildMode: 'source' });
    const result = await runWrapper(stub.socketPath, stub.tokenPath, stub.recordDir, [
      '--strict', '--expect-mode', 'compiled', '--runtime', 'pi', '--scenario', 'commandcode-fixture-smoke',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("backend build mode is 'source'");
    expect(result.stderr).toContain("expected 'compiled'");
    // No scenario was executed against the wrong build.
    expect(result.stdout).not.toContain('commandcode-fixture-smoke');
  }, 90_000);

  it('fails a skipped required scenario, writes the proof record with captured identity', async () => {
    const stub = await startStubBackend({ buildMode: 'compiled' });
    const result = await runWrapper(stub.socketPath, stub.tokenPath, stub.recordDir, [
      '--strict', '--expect-mode', 'compiled', '--entrypoint-mode', 'compiled', '--scope', 'fixture',
      '--runtime', 'pi', '--scenario', 'commandcode-fixture-smoke', '--require', 'commandcode-fixture-smoke',
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STRICT');
    const record = readWrittenRecord(stub.recordDir);
    expect(record).toMatchObject({
      schemaVersion: 1,
      verdict: 'failed',
      entrypointMode: 'compiled',
      scope: 'fixture',
      identity: { source: 'health', buildMode: 'compiled', buildId: 'build-stub-compiled' },
    });
    expect(JSON.stringify(record.matrix)).toContain('commandcode-fixture-smoke');
    expect(JSON.stringify(record.reasons)).toContain('skipped');
  }, 90_000);

  it('marks a missing required scenario indeterminate with a distinct exit code', async () => {
    const stub = await startStubBackend({ buildMode: 'compiled' });
    const result = await runWrapper(stub.socketPath, stub.tokenPath, stub.recordDir, [
      '--strict', '--runtime', 'pi', '--scenario', 'commandcode-fixture-smoke',
      '--require', 'smoke',
    ]);
    expect(result.status).toBe(2);
    const record = readWrittenRecord(stub.recordDir);
    expect(record).toMatchObject({ verdict: 'indeterminate' });
    expect(JSON.stringify(record.reasons)).toContain('missing');
  }, 90_000);

  it('writes a fresh record per run instead of overwriting prior evidence', async () => {
    const stub = await startStubBackend({ buildMode: 'compiled' });
    const first = await runWrapper(stub.socketPath, stub.tokenPath, stub.recordDir, [
      '--strict', '--runtime', 'pi', '--scenario', 'commandcode-fixture-smoke', '--require', 'commandcode-fixture-smoke',
    ]);
    expect(first.status).toBe(1);
    const before = readdirSync(stub.recordDir).length;
    const second = await runWrapper(stub.socketPath, stub.tokenPath, stub.recordDir, [
      '--strict', '--runtime', 'pi', '--scenario', 'commandcode-fixture-smoke', '--require', 'commandcode-fixture-smoke',
    ]);
    expect(second.status).toBe(1);
    const after = readdirSync(stub.recordDir).length;
    expect(after).toBeGreaterThan(before);
    for (const name of readdirSync(stub.recordDir)) {
      const content = readFileSync(join(stub.recordDir, name), 'utf8');
      expect(content.trim().endsWith('}')).toBe(true);
    }
  }, 90_000);
});

/**
 * B3a pristine-pi-ai live-proof harness.
 *
 * Builds a DISPOSABLE module-resolution root whose `@earendil-works/pi-ai`
 * copies are pristine npm-published 0.87.1 (the shared worktree node_modules
 * carry the pre-B3a patch), then boots the compiled pi-web-ui server from that
 * root with the full validation isolation envelope. The shared tree is only
 * ever READ: pristine copies are extracted from `npm pack`, the pi-coding-agent
 * copy is duplicated with its NESTED pi-ai (the copy in-process hosted sessions
 * resolve) replaced pristine, and every other dependency is a symlink. Nothing
 * is written to, hard-linked over, or patched in the shared tree.
 *
 * Usage (run from the worktree root):
 *   npx tsx server/tests/unit/pi-ai/pristine-harness.mjs build  <root> [--fixture-port P]
 *   npx tsx server/tests/unit/pi-ai/pristine-harness.mjs serve  <root> [--fixture-port P] [--env KEY=VAL]...
 *   npx tsx server/tests/unit/pi-ai/pristine-harness.mjs stop   <root>
 *
 * `serve` prints one JSON line on readiness:
 *   { ready: true, root, port, socketPath, tokenPath, metricsDir, pid }
 *
 * Run the whole proof under `systemd-run --scope --collect` so the disposable
 * server never shares the production service cgroup (the validation-server
 * cgroup guard's rule, honoured even though this launcher is bespoke).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_AI_VERSION = '0.87.1';
const PATCH_MARKER = 'PARTIAL_ARGS_PARSE_INTERVAL_MS';
const here = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(here, '..', '..', '..', '..');
const sharedNodeModules = path.join(worktreeRoot, 'node_modules');

function fail(message) {
  process.stderr.write(`[pristine-harness] ERROR: ${message}\n`);
  process.exit(1);
}

function log(message) {
  process.stderr.write(`[pristine-harness] ${message}\n`);
}

function getFlag(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function envFlags(args) {
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') {
      const [key, ...rest] = (args[i + 1] ?? '').split('=');
      if (!key || rest.length === 0) fail(`bad --env override: ${args[i + 1]}`);
      overrides[key] = rest.join('=');
      i += 1;
    } else if (args[i]?.startsWith('--env ')) {
      const [key, ...rest] = args[i].slice('--env '.length).split('=');
      if (!key || rest.length === 0) fail(`bad --env override: ${args[i]}`);
      overrides[key] = rest.join('=');
    }
  }
  return overrides;
}

export async function findFreeTcpPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function assertPristinePiAi(piAiDir, label) {
  const pkg = JSON.parse(readFileSync(path.join(piAiDir, 'package.json'), 'utf8'));
  if (pkg.version !== PI_AI_VERSION) fail(`${label}: pi-ai version ${pkg.version}, expected ${PI_AI_VERSION}`);
  const adapter = readFileSync(path.join(piAiDir, 'dist', 'api', 'openai-completions.js'), 'utf8');
  if (adapter.includes(PATCH_MARKER)) fail(`${label}: pi-ai copy carries the B3a patch marker — not pristine`);
}

async function fetchPristinePiAi(packDir) {
  mkdirSync(packDir, { recursive: true });
  const tarball = path.join(packDir, `earendil-works-pi-ai-${PI_AI_VERSION}.tgz`);
  const extracted = path.join(packDir, 'package');
  if (!existsSync(extracted)) {
    log('npm pack @earendil-works/pi-ai@0.87.1 …');
    const pack = spawnSync('npm', ['pack', `@earendil-works/pi-ai@${PI_AI_VERSION}`], {
      cwd: packDir, encoding: 'utf8', timeout: 120_000,
    });
    if (pack.status !== 0 || !existsSync(tarball)) {
      fail(`npm pack failed (exit ${pack.status}): ${pack.stderr?.slice(0, 400)}`);
    }
    const tar = spawnSync('tar', ['xzf', tarball], { cwd: packDir, encoding: 'utf8', timeout: 60_000 });
    if (tar.status !== 0 || !existsSync(extracted)) fail(`tar extract failed (exit ${tar.status})`);
  }
  assertPristinePiAi(extracted, 'npm-published tarball');
  return extracted;
}

function buildScratchRoot(root, fixturePort) {
  if (!existsSync(sharedNodeModules)) fail(`shared node_modules not found at ${sharedNodeModules}`);
  const nodeModules = path.join(root, 'node_modules');
  const earendil = path.join(nodeModules, '@earendil-works');
  mkdirSync(earendil, { recursive: true });

  // 1) Pristine root-level pi-ai (what direct server imports resolve).
  const pristine = path.join(root, 'pack', 'package');
  const rootPiAi = path.join(earendil, 'pi-ai');
  if (!existsSync(rootPiAi)) {
    fetchPristinePiAi(path.join(root, 'pack'));
    cpSync(pristine, rootPiAi, { recursive: true, dereference: false });
  }
  assertPristinePiAi(rootPiAi, 'root copy');

  // 2) pi-coding-agent copy with its NESTED pi-ai replaced pristine.
  const sharedAgent = path.join(sharedNodeModules, '@earendil-works', 'pi-coding-agent');
  const scratchAgent = path.join(earendil, 'pi-coding-agent');
  if (!existsSync(scratchAgent)) {
    log('copying pi-coding-agent (physical duplicate; shared tree untouched) …');
    cpSync(sharedAgent, scratchAgent, { recursive: true, dereference: false });
    const nested = path.join(scratchAgent, 'node_modules', '@earendil-works', 'pi-ai');
    rmSync(nested, { recursive: true, force: true });
    if (!existsSync(pristine)) fetchPristinePiAi(path.join(root, 'pack'));
    cpSync(pristine, nested, { recursive: true, dereference: false });
  }
  assertPristinePiAi(path.join(scratchAgent, 'node_modules', '@earendil-works', 'pi-ai'), 'nested copy');

  // 3) Every other dependency: symlink into the shared tree (read-only use).
  for (const entry of readdirSync(sharedNodeModules)) {
    if (entry === '@earendil-works' || entry.startsWith('.')) continue;
    const target = path.join(nodeModules, entry);
    if (existsSync(target)) continue;
    symlinkSync(path.join(sharedNodeModules, entry), target);
  }
  const sharedEarendil = path.join(sharedNodeModules, '@earendil-works');
  for (const entry of readdirSync(sharedEarendil)) {
    if (entry === 'pi-ai' || entry === 'pi-coding-agent' || entry.startsWith('.')) continue;
    const target = path.join(earendil, entry);
    if (existsSync(target)) continue;
    symlinkSync(path.join(sharedEarendil, entry), target);
  }

  // 4) A real (non-symlink) copy of the built server so upward resolution hits
  // the scratch node_modules (Node resolves symlinked ancestors to realpath).
  const scratchServer = path.join(root, 'server');
  if (!existsSync(scratchServer)) {
    const sourceServer = path.join(worktreeRoot, 'server');
    log('copying built server/dist …');
    for (const entry of readdirSync(sourceServer)) {
      if (entry === 'node_modules' || entry === 'test-results.json') continue;
      cpSync(path.join(sourceServer, entry), path.join(scratchServer, entry), { recursive: true, dereference: true });
    }
  }
  if (!existsSync(path.join(scratchServer, 'dist', 'index.js'))) {
    fail('scratch server/dist/index.js missing — run `npm run build` in the worktree first');
  }

  // 5) State dirs + fixture agent dir + Agent OS interception.
  const stateDir = path.join(root, 'state');
  for (const dir of [
    'workspace', 'pi-sessions', 'watches', 'run-receipts', 'pins', 'notifications', 'metrics', 'bin', 'logs',
    path.join('home', '.pi', 'agent'),
  ]) {
    mkdirSync(path.join(stateDir, dir), { recursive: true, mode: 0o700 });
  }
  const agentDir = path.join(stateDir, 'home', '.pi', 'agent');
  writeFileSync(path.join(agentDir, 'models.json'), `${JSON.stringify({
  providers: {
    'b3a-fixture': {
      name: 'B3A Fixture Provider',
      baseUrl: `http://127.0.0.1:${fixturePort}/v1`,
      api: 'openai-completions',
      apiKey: 'sk-b3a-fixture-local-only',
      models: [
        {
          id: 'b3a-runaway',
          name: 'B3A Runaway Fixture',
          contextWindow: 200000,
          maxTokens: 65536,
          input: ['text'],
          compat: { supportsUsageInStreaming: true, supportsFinishReason: true },
        },
      ],
    },
  },
  }, null, 2)}\n`);
  writeFileSync(path.join(agentDir, 'auth.json'), `${JSON.stringify({
    'b3a-fixture': { type: 'api_key', key: 'sk-b3a-fixture-local-only' },
  })}\n`);

  // agent-os interception: PATH stub first (bare `agent-os` resolves to the
  // no-op), AGENT_OS_BIN for the extension's own spawns, vault root redirect.
  const agentOsStubSource = path.join(worktreeRoot, 'scripts', 'heap-soak', 'agent-os-stub.mjs');
  if (!existsSync(agentOsStubSource)) fail('heap-soak agent-os stub not found');
  const binDir = path.join(stateDir, 'bin');
  const stubLink = path.join(binDir, 'agent-os');
  try { rmSync(stubLink); } catch { /* not present yet */ }
  symlinkSync(agentOsStubSource, stubLink);

  log(`scratch root ready: ${root}`);
  return { root, agentDir, stateDir };
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`timed out waiting for ${filePath}`);
}

async function waitReady(socketPath, tokenPath, port, timeoutMs) {
  await waitForFile(socketPath, timeoutMs);
  await waitForFile(tokenPath, timeoutMs);
  const token = readFileSync(tokenPath, 'utf8').trim();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await new Promise((resolve) => {
      const req = net.connect(socketPath);
      const chunks = [];
      req.on('connect', () => {
        req.write(`GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('error', () => resolve(false));
      req.on('close', () => {
        const body = Buffer.concat(chunks).toString();
        resolve(body.includes('200'));
      });
    });
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  fail(`server did not become healthy on ${socketPath} within ${timeoutMs} ms`);
}

async function serve(root, args) {
  const overrides = envFlags(args);
  const stateDir = path.join(root, 'state');
  // Defensive: a previous crash may have left the detached server alive (it
  // holds the process-file lock and the socket). Stop it before booting.
  if (existsSync(path.join(stateDir, 'server.pid'))) stop(root);
  const fixturePort = Number(getFlag(args, '--fixture-port') ?? 0);
  if (!fixturePort) fail('serve requires --fixture-port (the models.json baseUrl points at it)');
  const port = await findFreeTcpPort();
  const claudeWsPort = await findFreeTcpPort();
  const claudeHookPort = await findFreeTcpPort();
  const opencodePort = await findFreeTcpPort();

  // Import the REAL isolation builder from the worktree source (tsx resolves
  // the .js specifier to .ts) so the envelope cannot drift from validate:server.
  const { buildValidationIsolationEnv } = await import(
    path.join(worktreeRoot, 'server', 'src', 'live-validation', 'validation-server-env.js')
  );
  const isolation = buildValidationIsolationEnv({
    validationDir: stateDir,
    port: String(port),
    claudeWsPort: String(claudeWsPort),
    claudeHookPort: String(claudeHookPort),
    opencodePort: String(opencodePort),
  });
  // The A2 telemetry + validation guards canonicalise against the run dir;
  // declare it explicitly so OBSERVABILITY_METRICS_DIR is honoured.
  isolation.PI_WEB_UI_VALIDATION_DIR = stateDir;

  const agentDir = path.join(stateDir, 'home', '.pi', 'agent');
  const fakeHome = path.join(stateDir, 'home');
  const socketPath = path.join(stateDir, 'internal-api.sock');
  const tokenPath = path.join(stateDir, 'internal-api-token');
  for (const stale of [socketPath]) {
    try { rmSync(stale); } catch { /* not present */ }
  }

  const env = {
    ...process.env,
    ...isolation,
    NODE_ENV: 'test',
    NODE_OPTIONS: '--max-old-space-size=4096',
    // Runtime isolation (heap-soak recipe): fake HOME, isolated agent dir,
    // Agent OS interception at all three layers.
    HOME: fakeHome,
    PI_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    PATH: `${path.join(stateDir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    AGENT_OS_BIN: path.join(worktreeRoot, 'scripts', 'heap-soak', 'agent-os-stub.mjs'),
    BOARD_STORE_DIR: path.join(stateDir, 'board'),
    AGENT_OS_VAULT_ROOT: path.join(fakeHome, 'agent-os-memory-vault'),
    PI_WEB_UI_WATCH_WAKE_SOCKET: socketPath,
    PI_WEB_UI_WATCH_WAKE_TOKEN_FILE: tokenPath,
    PI_WEB_UI_GOAL_HOME: path.join(stateDir, 'goal-home'),
    OBSERVABILITY_METRICS_DIR: path.join(stateDir, 'metrics'),
    // Short proof windows need per-second samples (default cadence is ~30s).
    OBSERVABILITY_METRICS_INTERVAL_MS: '1000',
    // No ambient keys may leak into the fixture provider path; proxies must
    // not intercept the loopback fixture either.
    OPENROUTER_API_KEY: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*', no_proxy: '*',
    ...overrides,
  };
  mkdirSync(path.join(stateDir, 'board'), { recursive: true });
  mkdirSync(path.join(stateDir, 'goal-home'), { recursive: true });

  log(`spawning pristine server on port ${port} (env overrides: ${Object.keys(overrides).join(', ') || 'none'}) …`);
  mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const outFd = openSync(path.join(stateDir, 'logs', 'server-out.log'), 'a');
  const errFd = openSync(path.join(stateDir, 'logs', 'server-err.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'server', 'dist', 'index.js')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env,
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);
  writeFileSync(path.join(stateDir, 'server.pid'), String(child.pid));
  writeFileSync(path.join(stateDir, 'serve-meta.json'), `${JSON.stringify({ root, port, socketPath, tokenPath, metricsDir: path.join(stateDir, 'metrics'), pid: child.pid }, null, 2)}\n`);

  await waitReady(socketPath, tokenPath, port, 90_000);
  const meta = { ready: true, root, port, socketPath, tokenPath, metricsDir: path.join(stateDir, 'metrics'), pid: child.pid };
  process.stdout.write(`${JSON.stringify(meta)}\n`);
}

function stop(root) {
  const pidFile = path.join(root, 'state', 'server.pid');
  if (!existsSync(pidFile)) fail(`no pid file at ${pidFile}`);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    process.kill(-pid, 'SIGTERM'); // the child is its own group leader (detached)
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { /* gone */ break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  log(`server group ${pid} stopped`);
}

async function main() {
  const [command, root, ...rest] = process.argv.slice(2);
  if (!root) fail('usage: pristine-harness.mjs <build|serve|stop> <root> [options]');
  if (command === 'build') {
    const fixturePort = Number(getFlag(rest, '--fixture-port') ?? 0);
    if (!fixturePort) fail('build requires --fixture-port');
    buildScratchRoot(root, fixturePort);
    return;
  }
  if (command === 'serve') {
    await serve(root, rest);
    return;
  }
  if (command === 'stop') {
    stop(root);
    return;
  }
  fail(`unknown command: ${command}`);
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));

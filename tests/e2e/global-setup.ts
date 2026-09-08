import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';

type ValidationHealth = {
  buildIdentity?: {
    identityStatus?: string;
    buildId?: string;
  };
  buildId?: string;
};

type E2eEnvironment = {
  TEST_URL: string;
  TEST_AUTH_PASSWORD: string;
  TEST_BACKEND_BUILD_ID: string;
  runDir: string;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
};

const ENV_FILE = '/tmp/step4-e2e-env.json';
const LAUNCH_LOG = '/tmp/step4-e2e-launch.log';
const STOP_LOG = '/tmp/step4-e2e-stop.log';
const TEARDOWN_EVIDENCE = '/tmp/step4-e2e-teardown-evidence.json';

let validationProcess: ChildProcess | undefined;
let validationRunDir: string | undefined;

function waitForExit(process: ChildProcess): Promise<ProcessResult> {
  let output = '';
  for (const stream of [process.stdout, process.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      output += chunk;
    });
  }

  return new Promise((resolveResult, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => resolveResult({ code, signal, output }));
  });
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await fs.writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return (await fs.readFile(path, 'utf8')).trim();
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function getHealth(socketPath: string, token: string): Promise<ValidationHealth> {
  const response = await new Promise<{ statusCode?: number; body: string }>((resolveResponse, reject) => {
    const request = httpRequest({
      socketPath,
      path: '/api/v1/health',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveResponse({ statusCode: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });

  if (response.statusCode !== 200) {
    throw new Error(`Validation health returned HTTP ${response.statusCode}: ${response.body}`);
  }

  const health = JSON.parse(response.body) as ValidationHealth;
  if (health.buildIdentity?.identityStatus !== 'known') {
    throw new Error(`Validation build identity is not known: ${response.body}`);
  }
  return health;
}

async function waitForLaunch(child: ChildProcess): Promise<{ socketPath: string; tokenPath: string; port: number; output: string }> {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let output = '';
    let settled = false;
    let socketPath: string | undefined;
    let tokenPath: string | undefined;
    let port: number | undefined;
    let timeout: NodeJS.Timeout;

    const finishIfReady = () => {
      if (!socketPath || !tokenPath || port === undefined || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveLaunch({ socketPath, tokenPath, port, output });
    };

    const inspect = (chunk: string) => {
      output += chunk;
      if (output.length > 250_000) output = output.slice(-250_000);
      socketPath ??= output.match(/Listening on Unix socket:\s*(\S+)/)?.[1];
      tokenPath ??= output.match(/API token ready at:\s*(\S+)/)?.[1];
      const portMatch = output.match(/Server running on port\s+(\d+)/);
      if (portMatch) port = Number(portMatch[1]);
      // Keep compatibility with the validation launcher's aligned diagnostics.
      socketPath ??= output.match(/\bsocket\s*:\s*(\S+)/)?.[1];
      finishIfReady();
    };

    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', inspect);
    }

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectLaunch(new Error(`Timed out waiting for validation server launch. Output:\n${output}`));
    }, 120_000);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectLaunch(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectLaunch(new Error(`Validation server exited before launch (code=${code}, signal=${signal}). Output:\n${output}`));
    });
    finishIfReady();
  });
}

async function processGroupGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function stopValidationServer(): Promise<void> {
  if (!validationProcess || !validationRunDir) return;

  const stopProcess = spawn(process.execPath, [
    resolve('scripts/validation-server-stop.mjs'),
    '--dir',
    validationRunDir,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopResult = await waitForExit(stopProcess);
  await writePrivateFile(STOP_LOG, stopResult.output);

  const pid = validationProcess.pid;
  const groupGone = pid === undefined ? false : await processGroupGone(pid);
  const stopperVerifiedGone = /terminated and verified gone/i.test(stopResult.output);
  await writePrivateFile(TEARDOWN_EVIDENCE, JSON.stringify({
    runDir: validationRunDir,
    pid,
    stopExitCode: stopResult.code,
    stopSignal: stopResult.signal,
    processGroupGone: groupGone,
    stopperVerifiedGone,
    checkedAt: new Date().toISOString(),
  }, null, 2));

  if (!groupGone && !stopperVerifiedGone) {
    throw new Error(`Validation server process group ${pid ?? '<unknown>'} is still alive; evidence preserved at ${TEARDOWN_EVIDENCE}`);
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), 'step4-e2e-'));
  const home = join(workspaceRoot, 'home');
  const temporaryDirectory = join(workspaceRoot, 'tmp');
  const piAgentDirectory = join(workspaceRoot, 'pi-agent');
  const piCodingAgentDirectory = join(workspaceRoot, 'pi-coding-agent');
  await Promise.all([
    fs.mkdir(home, { recursive: true, mode: 0o700 }),
    fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(piAgentDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(piCodingAgentDirectory, { recursive: true, mode: 0o700 }),
  ]);

  const authPassword = randomBytes(24).toString('base64url');
  const authPasswordHash = await bcrypt.hash(authPassword, 10);
  const childEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: temporaryDirectory,
    PI_AGENT_DIR: piAgentDirectory,
    PI_CODING_AGENT_DIR: piCodingAgentDirectory,
    AUTH_PASSWORD: authPasswordHash,
  };

  validationProcess = spawn('npm', ['run', 'validate:server', '--', '--command-code-fixture'], {
    cwd: process.cwd(),
    env: childEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const launch = await waitForLaunch(validationProcess);
    await writePrivateFile(LAUNCH_LOG, launch.output);
    validationRunDir = dirname(launch.socketPath);
    const token = await waitForFile(launch.tokenPath);
    const health = await getHealth(launch.socketPath, token);
    const buildId = health.buildIdentity?.buildId ?? health.buildId;
    if (!buildId) throw new Error(`Validation health did not include a build ID: ${JSON.stringify(health)}`);

    const environment: E2eEnvironment = {
      TEST_URL: `http://localhost:${launch.port}`,
      TEST_AUTH_PASSWORD: authPassword,
      TEST_BACKEND_BUILD_ID: buildId,
      runDir: validationRunDir,
    };
    await writePrivateFile(ENV_FILE, JSON.stringify(environment, null, 2));
    process.env.TEST_URL = environment.TEST_URL;
    process.env.PLAYWRIGHT_TEST_BASE_URL = environment.TEST_URL;

    return stopValidationServer;
  } catch (error) {
    await writePrivateFile(LAUNCH_LOG, `Launch failed: ${String(error)}\n`);
    if (validationProcess.pid) {
      try { process.kill(-validationProcess.pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
    throw error;
  }
}

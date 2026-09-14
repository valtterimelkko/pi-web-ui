/**
 * The authenticated compiled-app lane.
 *
 * Boots the REAL compiled server through the repo's own disposable validation
 * launcher (isolated state dir, throwaway bcrypt password, only the TTS
 * credential imported from the production env file), logs in over HTTP exactly
 * as the browser does, builds the endpoint corpus through the real `/api/tts`,
 * then drives the real product player against the LIVE endpoint with the
 * cookie attached — capturing the OS output exactly as the product lane does.
 *
 * Denial control: the same endpoint, same server, no cookie → must refuse.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface DisposableApp {
  baseUrl: string;
  password: string;
  cookieHeader: string;
  process: ChildProcess;
  dir: string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('no free port'));
      srv.close();
    });
    srv.on('error', reject);
  });
}

function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url);
        if (response.status < 500) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error(`server not ready at ${url}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

export async function bootDisposableApp(options: {
  repoRoot: string;
  workDir: string;
  envFile?: string;
  log: (message: string) => void;
}): Promise<DisposableApp> {
  const dist = path.join(options.repoRoot, 'server', 'dist', 'index.js');
  if (!existsSync(dist)) throw new Error('compiled server missing: run npm run build first');

  // Throwaway credentials: a fresh bcrypt password per boot, never the
  // production secret. Only OPENAI_API_KEY (the TTS credential) is imported
  // from the production env file, by the launcher's allowlist mechanism.
  const { default: bcrypt } = await import('bcrypt');
  const password = `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const hash = bcrypt.hashSync(password, 10);

  const dir = path.join(options.workDir, `app-server-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const args = [path.join(options.repoRoot, 'scripts', 'validation-server.ts'), '--compiled', '--dir', dir, '--port', String(port)];
  if (options.envFile) args.push('--env-file', options.envFile, '--env-key', 'OPENAI_API_KEY');
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', AUTH_PASSWORD: hash };
  // Never inject a shell value for the TTS key: the launcher's env-file
  // import only fills UNSET variables (shell precedence), so an explicit empty
  // string here would shadow the imported credential with nothing.
  delete childEnv.OPENAI_API_KEY;
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: options.repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const banner: string[] = [];
  const stdio = child.stdout as NodeJS.ReadableStream;
  const errio = child.stderr as NodeJS.ReadableStream;
  const rl = createInterface({ input: stdio });
  rl.on('line', (line) => banner.push(line));
  errio.on('data', (chunk: Buffer) => banner.push(chunk.toString('utf8')));

  const stop = async () => {
    if (child.pid && !child.killed) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        resolve(undefined);
      }, 8000);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  };

  try {
    await waitForHttp(`${baseUrl}/api/health`, 60_000);
  } catch (error) {
    writeFileSync(path.join(options.workDir, 'app-server-boot.log'), banner.join('\n'));
    await stop();
    throw error;
  }
  options.log(`app server up: ${baseUrl} (pid ${child.pid})`);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) {
    writeFileSync(path.join(options.workDir, 'app-server-login.log'), banner.join('\n'));
    await stop();
    throw new Error(`login failed: HTTP ${login.status}`);
  }
  const setCookie = login.headers.getSetCookie?.() ?? [];
  const cookieHeader = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  if (!cookieHeader) {
    await stop();
    throw new Error('login returned no cookie');
  }
  return { baseUrl, password, cookieHeader, process: child, dir, stop };
}

/** The denial control: the same endpoint, no credentials, must refuse. */
export async function assertUnauthenticatedDenied(app: DisposableApp): Promise<{ ok: boolean; detail: string }> {
  const denied = await fetch(`${app.baseUrl}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: app.baseUrl },
    body: JSON.stringify({ text: 'must not be synthesised' }),
  });
  const ok = denied.status === 401 || denied.status === 403;
  return { ok, detail: `no-cookie POST /api/tts → HTTP ${denied.status} (expected 401/403)` };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

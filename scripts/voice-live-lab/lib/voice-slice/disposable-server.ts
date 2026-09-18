/**
 * Voice Mode vertical slice (plan Phase 5 / Track F) — disposable server.
 *
 * Boots the lab's disposable validation server (`boot-disposable-server.sh`)
 * from THIS repository, discovers its ephemeral HTTP port from the boot log,
 * and stops it again. Nothing here touches production: the state dir is a
 * fresh temp directory, the unit is a per-run systemd scope, and the auth
 * password for the disposable instance is a known per-run value (the server
 * runs with NODE_ENV=test, where a plaintext AUTH_PASSWORD is accepted).
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface DisposableServerOptions {
  /** Repo root the server boots from (the slice runs its own worktree). */
  repoRoot: string;
  /** Env passed through to the server (GEMINI_API_KEY, LOG_FORMAT, …). */
  env?: Record<string, string | undefined>;
  /** Password for the disposable server (NODE_ENV=test accepts plaintext). */
  authPassword?: string;
  /** systemd scope unit name (must be unique per concurrent run). */
  unitName?: string;
  log?: (line: string) => void;
}

export interface DisposableServer {
  stateDir: string;
  logPath: string;
  socketPath: string;
  tokenPath: string;
  httpPort: number;
  authPassword: string;
  stop(): Promise<void>;
}

function waitForFile(pathToCheck: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (existsSync(pathToCheck)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${pathToCheck}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** Extract the ephemeral HTTP port the validation server printed at boot. */
export function parseServerPort(logText: string): number | null {
  const match = /^\s*port\s*:\s*(\d+)\s*$/m.exec(logText);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export async function bootDisposableServer(options: DisposableServerOptions): Promise<DisposableServer> {
  const log = options.log ?? (() => {});
  const repoRoot = path.resolve(options.repoRoot);
  const script = path.join(repoRoot, 'scripts', 'voice-live-lab', 'boot-disposable-server.sh');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'voice-slice-'));
  const unitName = options.unitName ?? `voice-slice-${process.pid}-${Date.now().toString(36)}`;
  const authPassword = options.authPassword ?? `slice-${Math.random().toString(36).slice(2)}`;
  const scriptEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    VOICE_LAB_REPO: repoRoot,
    VOICE_LAB_DIR: stateDir,
    VOICE_LAB_UNIT: unitName,
    VOICE_LAB_POINTER: path.join(stateDir, 'current'),
    AUTH_PASSWORD: authPassword,
    LOG_FORMAT: options.env?.LOG_FORMAT ?? 'json',
  };

  const boot = spawnSync('bash', [script, 'boot'], {
    env: scriptEnv,
    encoding: 'utf8',
    timeout: 240_000,
  });
  const bootOutput = `${boot.stdout ?? ''}${boot.stderr ?? ''}`;
  if (boot.status !== 0) {
    throw new Error(`disposable server failed to boot (exit ${boot.status}):\n${bootOutput.slice(-4000)}`);
  }

  const logPath = path.join(stateDir, 'server.log');
  const socketPath = path.join(stateDir, 'internal-api.sock');
  const tokenPath = path.join(stateDir, 'internal-api-token');
  await waitForFile(socketPath, 30_000);

  // The banner prints the reserved port; read it from the log (the script's
  // stdout is not guaranteed to carry it).
  let port: number | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && port === null) {
    try {
      port = parseServerPort(readFileSync(logPath, 'utf8'));
    } catch {
      /* log not readable yet */
    }
    if (port === null) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (port === null) {
    throw new Error(`could not discover the disposable server's HTTP port from ${logPath}`);
  }
  log(`disposable server ready: port=${port} stateDir=${stateDir}`);

  return {
    stateDir,
    logPath,
    socketPath,
    tokenPath,
    httpPort: port,
    authPassword,
    stop: async () => {
      spawnSync('bash', [script, 'stop'], {
        env: scriptEnv,
        encoding: 'utf8',
        timeout: 60_000,
      });
      // The scope teardown is asynchronous in systemd; the temp state dir is
      // left in place so evidence stays readable, and only a best-effort
      // cleanup of the process scope is done here.
      void spawn;
    },
  };
}

/** Remove a run's state dir (only after its evidence has been copied out). */
export function removeStateDir(stateDir: string): void {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Health probe (used by the runner before it starts speaking). */
export async function waitForHealth(httpPort: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${httpPort}/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`disposable server did not become healthy on port ${httpPort}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

import { spawn, ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import type { OpenCodeConfig } from './opencode-types.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('OpenCodeProcessManager');


export interface OpenCodeProcessStatus {
  healthy: boolean;
  managed: boolean;
  pid?: number;
  startedAt?: number;
  uptimeMs?: number;
}

export class OpenCodeProcessManager {
  private config: OpenCodeConfig;
  private process: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private healthy: boolean = false;
  private restartCount: number = 0;
  private maxRestarts: number = 5;
  private shuttingDown: boolean = false;
  private serverStartedAt: number | null = null;
  private attachedExternal: boolean = false;

  constructor(config: OpenCodeConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync('which opencode', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.process || this.starting) {
      if (this.starting) await this.starting;
      return;
    }

    this.shuttingDown = false;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    if (!this.config.enabled) {
      throw new Error('OpenCode integration is disabled');
    }

    // If a server is already running at this address, attach to it without spawning
    const alreadyUp = await this.isHealthy();
    if (alreadyUp) {
      logger.info('[OpenCodeProcessManager] Server already running, attaching');
      this.serverStartedAt = this.serverStartedAt ?? Date.now();
      this.attachedExternal = true;
      return;
    }

    const args = ['serve', '--hostname', this.config.host, '--port', String(this.config.port)];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.password) {
      env.OPENCODE_SERVER_PASSWORD = this.config.password;
    }

    this.process = spawn('opencode', args, {
      cwd: this.config.workingDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      logger.error('[OpenCodeProcessManager] Process error:', err.message);
      this.process = null;
      this.healthy = false;
      this.serverStartedAt = null;
      this.attachedExternal = false;
    });

    this.process.on('exit', (code, signal) => {
      logger.info(`[OpenCodeProcessManager] Process exited code=${code} signal=${signal}`);
      this.process = null;
      this.healthy = false;
      this.serverStartedAt = null;
      this.attachedExternal = false;
      if (!this.shuttingDown && this.restartCount < this.maxRestarts) {
        const delay = Math.min(1000 * Math.pow(2, this.restartCount), 30000);
        this.restartCount++;
        logger.info(`[OpenCodeProcessManager] Restarting in ${delay}ms (attempt ${this.restartCount})`);
        setTimeout(() => { void this.start(); }, delay);
      }
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.error(`[OpenCodeProcessManager] stderr:`, text);
    });

    await this.waitForHealthy();
    this.serverStartedAt = Date.now();
    this.attachedExternal = false;
    this.restartCount = 0;
  }

  private async waitForHealthy(maxWaitMs: number = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const response = await fetch(this.getBaseUrl(), {
          headers: this.getAuthHeaders(),
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          this.healthy = true;
          return;
        }
      } catch {
        // not ready
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`OpenCode server did not become healthy within ${maxWaitMs}ms`);
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (!this.process) {
      this.healthy = false;
      this.serverStartedAt = null;
      this.attachedExternal = false;
      return;
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL');
        this.healthy = false;
        this.serverStartedAt = null;
        this.attachedExternal = false;
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        this.healthy = false;
        this.serverStartedAt = null;
        this.attachedExternal = false;
        resolve();
      });

      this.process!.kill('SIGTERM');
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(this.getBaseUrl(), {
        headers: this.getAuthHeaders(),
        signal: AbortSignal.timeout(2000),
      });
      this.healthy = response.ok;
      return this.healthy;
    } catch {
      this.healthy = false;
      return false;
    }
  }

  getStatus(): OpenCodeProcessStatus {
    const startedAt = this.serverStartedAt ?? undefined;
    return {
      healthy: this.healthy,
      managed: Boolean(this.process) && !this.attachedExternal,
      pid: this.process?.pid,
      startedAt,
      uptimeMs: startedAt ? Date.now() - startedAt : undefined,
    };
  }

  async recycle(reason: string): Promise<void> {
    logger.info(`[OpenCodeProcessManager] Recycling OpenCode server: ${reason}`);
    this.shuttingDown = true;

    if (this.process) {
      await this.stop();
    } else if (this.attachedExternal) {
      this.killExternalServer();
      this.healthy = false;
      this.serverStartedAt = null;
      this.attachedExternal = false;
      await new Promise(r => setTimeout(r, 1000));
    }

    this.shuttingDown = false;
    await this.start();
  }

  private killExternalServer(): void {
    const pattern = `opencode serve.*--port ${this.config.port}`;
    let output = '';
    try {
      output = execSync(`pgrep -f ${JSON.stringify(pattern)}`, { timeout: 2000, encoding: 'utf-8' });
    } catch {
      return;
    }

    const currentPid = process.pid;
    const pids = output
      .split(/\s+/)
      .map(pid => Number(pid))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== currentPid);

    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already exited or not permitted; best effort.
      }
    }
  }

  getBaseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  getAuthHeaders(): Record<string, string> {
    if (!this.config.password) return {};
    const encoded = Buffer.from(`:${this.config.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
}

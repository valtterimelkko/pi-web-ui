import { spawn, ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import type { OpenCodeConfig } from './opencode-types.js';

export class OpenCodeProcessManager {
  private config: OpenCodeConfig;
  private process: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private healthy: boolean = false;
  private restartCount: number = 0;
  private maxRestarts: number = 5;
  private shuttingDown: boolean = false;

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
      console.error('[OpenCodeProcessManager] Process error:', err.message);
      this.process = null;
      this.healthy = false;
    });

    this.process.on('exit', (code, signal) => {
      console.log(`[OpenCodeProcessManager] Process exited code=${code} signal=${signal}`);
      this.process = null;
      this.healthy = false;
      if (!this.shuttingDown && this.restartCount < this.maxRestarts) {
        const delay = Math.min(1000 * Math.pow(2, this.restartCount), 30000);
        this.restartCount++;
        console.log(`[OpenCodeProcessManager] Restarting in ${delay}ms (attempt ${this.restartCount})`);
        setTimeout(() => { void this.start(); }, delay);
      }
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[OpenCodeProcessManager] stderr:`, text);
    });

    await this.waitForHealthy();
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
    if (!this.process) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process!.kill('SIGTERM');
    });
  }

  async isHealthy(): Promise<boolean> {
    if (!this.process) return false;
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

  getBaseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  getAuthHeaders(): Record<string, string> {
    if (!this.config.password) return {};
    const encoded = Buffer.from(`:${this.config.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
}

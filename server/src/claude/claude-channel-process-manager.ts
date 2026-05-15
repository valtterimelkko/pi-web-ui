import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

export interface ChannelProcessState {
  process: ChildProcess | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  startedAt: number | null;
  error?: string;
}

export interface ClaudeChannelProcessManagerConfig {
  pluginDir: string;
  wsPort: number;
  hookPort: number;
  cwd: string;
  claudePath?: string;
  permissionMode?: string;
}

const DEFAULT_PERMISSION_MODE = 'acceptEdits';
const READY_POLL_INTERVAL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

export class ClaudeChannelProcessManager {
  private cfg: ClaudeChannelProcessManagerConfig;
  private state: ChannelProcessState = {
    process: null,
    status: 'stopped',
    startedAt: null,
  };

  constructor(cfg: ClaudeChannelProcessManagerConfig) {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    if (this.state.status === 'running' || this.state.status === 'starting') {
      return;
    }

    const pluginJsonPath = join(this.cfg.pluginDir, '.claude-plugin', 'plugin.json');
    if (!existsSync(pluginJsonPath)) {
      throw new Error(`Plugin not found at ${this.cfg.pluginDir}: missing .claude-plugin/plugin.json`);
    }

    this.state.status = 'starting';
    this.state.error = undefined;

    const claudePath = this.cfg.claudePath || 'claude';
    const permissionMode = this.cfg.permissionMode || DEFAULT_PERMISSION_MODE;

    const args = [
      '--plugin-dir', this.cfg.pluginDir,
      '--permission-mode', permissionMode,
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    env.CLAUDE_CHANNEL_WS_PORT = String(this.cfg.wsPort);
    env.CLAUDE_CHANNEL_HOOK_PORT = String(this.cfg.hookPort);
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const proc = spawn(claudePath, args, {
      cwd: this.cfg.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.state.process = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log(`[ClaudeChannel] stdout: ${text}`);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[ClaudeChannel] stderr: ${text}`);
      }
      if (text.toLowerCase().includes('authentication') || text.toLowerCase().includes('permission denied') || text.toLowerCase().includes('unauthorized')) {
        this.state.status = 'error';
        this.state.error = text;
      }
    });

    proc.on('error', (err: Error) => {
      console.error(`[ClaudeChannel] process error: ${err.message}`);
      this.state.status = 'error';
      this.state.error = err.message;
      this.state.process = null;
    });

    proc.on('exit', (code, signal) => {
      if (this.state.status !== 'error') {
        if (code !== 0 && code !== null) {
          this.state.status = 'error';
          this.state.error = `Process exited with code=${code}, signal=${signal ?? 'null'}`;
        } else {
          this.state.status = 'stopped';
        }
      }
      this.state.process = null;
      this.state.startedAt = null;
    });

    try {
      await this.waitForReady(DEFAULT_READY_TIMEOUT_MS);
      this.state.startedAt = Date.now();
      this.state.status = 'running';
    } catch (err) {
      this.state.status = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      throw err;
    }
  }

  async stop(): Promise<void> {
    const proc = this.state.process;
    if (!proc || this.state.status === 'stopped') {
      this.state.status = 'stopped';
      this.state.process = null;
      return;
    }

    try {
      proc.kill('SIGTERM');
    } catch {
      this.state.status = 'stopped';
      this.state.process = null;
      return;
    }

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        proc.on('exit', () => resolve(true));
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
      }),
    ]);

    if (!exited) {
      try {
        proc.kill('SIGKILL');
      } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        proc.on('exit', () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }

    this.state.status = 'stopped';
    this.state.process = null;
    this.state.startedAt = null;
  }

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  getState(): ChannelProcessState {
    return { ...this.state };
  }

  async waitForReady(timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthCheck()) {
        return;
      }
      if (this.state.status === 'error') {
        throw new Error(this.state.error || 'Claude channel process entered error state');
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`Claude channel process did not become ready within ${timeoutMs}ms`);
  }

  async healthCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.cfg.wsPort}`);
      const cleanup = () => {
        try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ }
      };
      ws.on('open', () => {
        cleanup();
        resolve(true);
      });
      ws.on('error', () => {
        cleanup();
        resolve(false);
      });
    });
  }
}

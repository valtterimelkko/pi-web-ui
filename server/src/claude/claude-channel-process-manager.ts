import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import pty from 'node-pty';

export interface ChannelProcessState {
  pid: number | null;
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
    pid: null,
    status: 'stopped',
    startedAt: null,
  };
  private ptyProcess: pty.IPty | null = null;

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
      '--dangerously-load-development-channels', 'server:pi-claude-channel',
      '--mcp-config', join(this.cfg.pluginDir, '.mcp.json'),
      '--permission-mode', permissionMode,
    ];

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CHANNEL_WS_PORT = String(this.cfg.wsPort);
    env.CLAUDE_CHANNEL_HOOK_PORT = String(this.cfg.hookPort);
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const proc = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.cfg.cwd,
      env,
    });

    this.ptyProcess = proc;
    this.state.pid = proc.pid;

    let confirmed = false;
    proc.onData((data: string) => {
      const text = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
      if (text) {
        console.log(`[ClaudeChannel] output: ${text.slice(0, 500)}`);
      }
      if (!confirmed && (text.includes('Entertoconfirm') || text.includes('Enter to confirm') || text.includes('local development'))) {
        setTimeout(() => {
          proc.write('\r');
          confirmed = true;
        }, 500);
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      const code = exitCode ?? (signal ? -1 : 0);
      if (this.state.status !== 'error') {
        if (code !== 0) {
          this.state.status = 'error';
          this.state.error = `Process exited with code=${code}, signal=${signal ?? 'null'}`;
        } else {
          this.state.status = 'stopped';
        }
      }
      this.ptyProcess = null;
      this.state.pid = null;
      this.state.startedAt = null;
    });

    try {
      await this.waitForReady(DEFAULT_READY_TIMEOUT_MS);
      this.state.startedAt = Date.now();
      this.state.status = 'running';
    } catch (err) {
      this.state.status = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
      try { proc.kill(); } catch { /* ignore */ }
      throw err;
    }
  }

  async stop(): Promise<void> {
    const proc = this.ptyProcess;
    if (!proc || this.state.status === 'stopped') {
      this.state.status = 'stopped';
      this.ptyProcess = null;
      this.state.pid = null;
      return;
    }

    try {
      proc.kill('SIGTERM');
    } catch {
      this.state.status = 'stopped';
      this.ptyProcess = null;
      this.state.pid = null;
      return;
    }

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        proc.onExit(() => resolve(true));
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
        proc.onExit(() => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }

    this.state.status = 'stopped';
    this.ptyProcess = null;
    this.state.pid = null;
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

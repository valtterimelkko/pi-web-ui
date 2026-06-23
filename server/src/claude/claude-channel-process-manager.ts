import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import pty from 'node-pty';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('ClaudeChannel');


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
  /** Quiet window (ms) with no PTY busy indicator before a turn is declared idle. */
  idleQuietMs?: number;
  /** How often (ms) to re-check the idle condition. */
  idleCheckIntervalMs?: number;
  /** Minimum gap (ms) between forwarded PTY activity pings. */
  activityThrottleMs?: number;
}

const DEFAULT_PERMISSION_MODE = 'dontAsk';
const DEFAULT_ALLOWED_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'Skill', 'TodoWrite',
  'Computer', 'Playwright',
  'mcp__pi-claude-channel__reply',
  'mcp__pi-claude-channel__status',
  'mcp__pi-claude-channel__fetch_history',
  'mcp__pi-claude-channel__request_permission',
  'mcp__pi-claude-channel__send_event',
];
const READY_POLL_INTERVAL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const AUTH_ERROR_COOLDOWN_MS = 5000;
const AUTH_ERROR_PATTERN = /(?:Please run \/login|API Error:\s*401|Invalid authentication credentials)/i;

// Busy-state tracking. Claude Code keeps an "esc to interrupt" footer and an
// animated spinner glyph on screen for the entire duration of an active turn.
// Either one means "Claude is working". A turn is only considered finished
// once NO busy indicator has appeared for a sustained quiet window — scraping
// for a single `❯` prompt frame is unreliable because Claude renders that
// input box continuously, even mid-turn, which caused false turn-completions.
const BUSY_INDICATOR_PATTERN = /esc\s*to\s*interrupt|[✻✽✶✢]/i;
const DEFAULT_IDLE_QUIET_MS = 12_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 3_000;
const DEFAULT_ACTIVITY_THROTTLE_MS = 2_000;

export class ClaudeChannelProcessManager extends EventEmitter {
  private cfg: ClaudeChannelProcessManagerConfig;
  private state: ChannelProcessState = {
    pid: null,
    status: 'stopped',
    startedAt: null,
  };
  private ptyProcess: pty.IPty | null = null;
  private _currentModel: string | null = null;
  private _currentThinkingLevel: string | null = null;
  private lastAuthErrorAt = 0;
  private isBusyState = false;
  private lastBusyAt = 0;
  private lastActivityEmitAt = 0;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleQuietMs: number;
  private readonly idleCheckIntervalMs: number;
  private readonly activityThrottleMs: number;

  constructor(cfg: ClaudeChannelProcessManagerConfig) {
    super();
    this.cfg = cfg;
    this.idleQuietMs = cfg.idleQuietMs ?? DEFAULT_IDLE_QUIET_MS;
    this.idleCheckIntervalMs = cfg.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS;
    this.activityThrottleMs = cfg.activityThrottleMs ?? DEFAULT_ACTIVITY_THROTTLE_MS;
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
      '--permission-mode', permissionMode,
      '--allowedTools', ...DEFAULT_ALLOWED_TOOLS,
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
    let lastAutoApprove = 0;
    proc.onData((data: string) => {
      const text = this.sanitizePtyOutput(data);
      const logText = text.trim();
      if (logText) {
        logger.info(`[ClaudeChannel] output: ${logText.slice(0, 500)}`);
      }
      this.detectAuthError(text);
      if (!confirmed && (text.includes('Entertoconfirm') || text.includes('Enter to confirm') || text.includes('local development'))) {
        setTimeout(() => {
          proc.write('\r');
          confirmed = true;
        }, 500);
      }

      if (confirmed && Date.now() - lastAutoApprove > 2000) {
        const isToolPermissionPrompt = /esctointerrupt|esc.*to.*interrupt/.test(text)
          && (/\d+\s+\w+/.test(text) || text.includes('manage'));
        if (isToolPermissionPrompt) {
          lastAutoApprove = Date.now();
          setTimeout(() => {
            proc.write('\r');
            logger.info('[ClaudeChannel] Auto-approved tool permission prompt');
          }, 300);
        }

        // Auto-confirm model switch dialog ("Switch model? ... 1. Yes ... 2. No")
        // This appears when switching from a cached model (e.g. haiku→opus) and
        // blocks the PTY until the user picks an option.
        const isModelSwitchPrompt = /Switch\s*model\s*\?/i.test(text)
          || /Yesswitchto/i.test(text);
        if (isModelSwitchPrompt) {
          lastAutoApprove = Date.now();
          setTimeout(() => {
            proc.write('1\r');
            logger.info('[ClaudeChannel] Auto-confirmed model switch dialog');
          }, 300);
        }
      }

      this.trackBusyState(text);
    });

    this.startIdleWatch();

    proc.onExit(({ exitCode, signal }) => {
      this.stopIdleWatch();
      this.isBusyState = false;
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

      // Port conflict diagnostic: log who's listening on our WS port.
      // A stale process from a previous run can silently occupy the port,
      // causing our WS client to talk to the wrong plugin.
      this.logPortDiagnostic(this.cfg.wsPort).catch(() => { /* legitimate: port diagnostic is best-effort */ });
    } catch (err) {
      this.state.status = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
      try { proc.kill(); } catch { /* ignore */ }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.stopIdleWatch();
    this.isBusyState = false;
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

  /**
   * Send an Escape keypress to the PTY to interrupt Claude Code's current
   * turn. Claude Code interactive mode shows "esc to interrupt" during active
   * tool use — pressing Escape is the only reliable way to stop a running turn.
   * A small delay + second press handles the case where Claude shows a
   * confirmation prompt ("Are you sure?") after the first Escape.
   */
  sendInterrupt(): void {
    const proc = this.ptyProcess;
    if (!proc) return;
    proc.write('\x1b');
    setTimeout(() => {
      if (this.ptyProcess) {
        this.ptyProcess.write('\x1b');
      }
    }, 300);
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

  switchModel(model: string): boolean {
    const proc = this.ptyProcess;
    if (!proc) return false;
    if (this._currentModel === model) return false;
    this._currentModel = model;
    proc.write(`/model ${model}\r`);
    return true;
  }

  setThinkingLevel(level: string): boolean {
    const proc = this.ptyProcess;
    if (!proc) return false;
    // Map the Web UI thinking levels to Claude Code /effort values.
    // Claude Code supports: low, medium, high.
    // Web UI levels: off, minimal, low, medium, high, xhigh
    const effortMap: Record<string, string> = {
      off: 'low',
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
    };
    const effort = effortMap[level] ?? 'medium';
    if (this._currentThinkingLevel === effort) return false;
    this._currentThinkingLevel = effort;
    proc.write(`/effort ${effort}\r`);
    return true;
  }

  /**
   * Send `/clear` to the PTY to wipe Claude's conversation context.
   * This is used when a new Pi Web UI session sends its first prompt,
   * ensuring Claude starts with a clean slate and no context bleeding
   * from prior sessions.
   *
   * Returns after a brief delay to allow Claude Code to process the command.
   */
  async clearContext(): Promise<void> {
    const proc = this.ptyProcess;
    if (!proc) return;
    proc.write('/clear\r');
    logger.info('[ClaudeChannel] Sent /clear to PTY for context isolation');
    await new Promise((r) => setTimeout(r, 1500));
  }

  /**
   * Tell the busy tracker that a prompt was just dispatched to Claude. This
   * makes `isBusy()` true immediately, before any PTY output is rendered, and
   * arms the idle watcher so the turn's completion can be detected.
   */
  markPromptSent(): void {
    this.isBusyState = true;
    this.lastBusyAt = Date.now();
    this.lastActivityEmitAt = 0;
  }

  /**
   * Tell the busy tracker that the current turn finished (e.g. Claude called
   * the `reply` tool). Clears the busy state without waiting for the quiet
   * window so `isBusy()` stops reporting a stale turn.
   */
  markPromptComplete(): void {
    this.isBusyState = false;
  }

  /** Whether Claude appears to be actively working on a turn. */
  isBusy(): boolean {
    return this.isBusyState;
  }

  /**
   * Poll `isBusy()` until it returns false or the timeout expires.
   * Returns true if idle was reached, false on timeout.
   */
  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isBusyState && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !this.isBusyState;
  }

  /** Timestamp (ms) of the most recent PTY busy indicator, or null if never set. */
  getLastBusyAt(): number | null {
    return this.lastBusyAt > 0 ? this.lastBusyAt : null;
  }

  /**
   * Scan a PTY frame for busy indicators. Unlike the old prompt-scraping
   * detector, this looks at the WHOLE frame: Claude renders the
   * "esc to interrupt" footer ABOVE the `❯` input box, so checking only the
   * text after the prompt missed it and force-completed live turns.
   */
  private trackBusyState(text: string): void {
    const now = Date.now();
    if (BUSY_INDICATOR_PATTERN.test(text)) {
      this.lastBusyAt = now;
      if (!this.isBusyState) {
        this.isBusyState = true;
        this.emit('busy');
      }
    }
    // While a turn is active, forward throttled activity pings so the Web UI
    // heartbeat can show genuine liveness even when Claude never calls
    // send_event for its intermediate tool use.
    if (this.isBusyState && now - this.lastActivityEmitAt >= this.activityThrottleMs) {
      this.lastActivityEmitAt = now;
      this.emit('activity');
    }
  }

  private startIdleWatch(): void {
    this.stopIdleWatch();
    this.idleCheckTimer = setInterval(() => {
      if (!this.isBusyState) return;
      if (Date.now() - this.lastBusyAt < this.idleQuietMs) return;
      // No busy indicator for the full quiet window — the turn has ended.
      this.isBusyState = false;
      this.emit('idle');
    }, this.idleCheckIntervalMs);
    if (typeof this.idleCheckTimer.unref === 'function') {
      this.idleCheckTimer.unref();
    }
  }

  private stopIdleWatch(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  private detectAuthError(text: string): void {
    if (!AUTH_ERROR_PATTERN.test(text)) return;
    const now = Date.now();
    if (now - this.lastAuthErrorAt < AUTH_ERROR_COOLDOWN_MS) return;
    this.lastAuthErrorAt = now;
    this.emit('auth_error', {
      message: 'Claude Code authentication expired. Please run /login or `claude auth login` on the server, then retry.',
    });
  }

  private sanitizePtyOutput(text: string): string {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const oscPattern = new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, 'g');
    const csiPattern = new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, 'g');
    const shortEscPattern = new RegExp(`${esc}[=>][0-9;]*`, 'g');

    return text
      // OSC/title-control sequences, e.g. ESC ] 0;... BEL
      .replace(oscPattern, '')
      // CSI control sequences, e.g. ESC [ ?25h / ESC [ 1m
      .replace(csiPattern, '')
      // Other short escape controls seen in Claude's TUI.
      .replace(shortEscPattern, '');
  }

  /**
   * Log which process(es) are listening on the configured WS port.
   * Helps diagnose port conflicts with stale processes from previous runs.
   */
  private async logPortDiagnostic(port: number): Promise<void> {
    try {
      const { execSync } = await import('node:child_process');
      const output = execSync(
        `ss -tlnp 'sport = :${port}' 2>/dev/null || netstat -tlnp 2>/dev/null | grep ':${port}'`,
        { encoding: 'utf-8', timeout: 3000 },
      ).trim();
      if (output) {
        logger.info(`[ClaudeChannel] Port ${port} diagnostic: ${output.replace(/\n/g, ' | ')}`);
      } else {
        logger.info(`[ClaudeChannel] Port ${port} diagnostic: no listener found`);
      }
    } catch {
      // Diagnostic only — never fail startup.
    }
  }
}

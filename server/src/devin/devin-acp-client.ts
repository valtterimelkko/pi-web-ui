import { spawn, type ChildProcess } from 'node:child_process';
import { devinSpawnEnv } from './devin-spawn-env.js';
import { isAgentToClientRequest, nextRequestId, parseAcpLine, type AcpMessage } from './devin-acp-protocol.js';
import type { AcpSessionUpdate } from './devin-event-adapter.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('DevinAcpClient');

/**
 * One `devin acp` child per live session (plan D1): lazy spawn, idle shutdown
 * (the service stops it), respawn → `session/load` by the service.
 *
 * Wire (live-validated v3000.12.28): JSON-RPC 2.0 over stdio, one object per
 * line. The client speaks the ACP v1 handshake (`initialize` with fs/terminal
 * client capabilities false), creates or loads a session, prompts, cancels,
 * sets config options, and answers agent→client requests by policy:
 * - `session/request_permission` → select the allow option (plan D6; children
 *   also run `bypass` mode, this is the belt to that braces).
 * - anything else → JSON-RPC method-not-found (-32601).
 *
 * Unknown agent notifications (`_cognition.ai/*`) are ignored safely (log at
 * debug); `session/update` goes to the injected handler.
 */

export interface DevinAcpClientOptions {
  cwd: string;
  /** HOME for the child — throwaway in tests/validation (plan D2/D1). */
  devinHome: string;
  executablePath: string;
  /** Resume an existing native session (session/load) instead of session/new. */
  resumeNativeSessionId?: string;
  /** Injectable spawn (tests); production spawns the real CLI. */
  spawnFn?: typeof spawn;
  onSessionUpdate?: (update: AcpSessionUpdate) => void;
  /** Bounded init timeout: initialize + session/new must complete inside it. */
  initTimeoutMs?: number;
  /** Extra allow-listed env values (DEVIN_* only; D2 keeps everything else out). */
  extraEnv?: Record<string, string>;
}

export interface AcpTurnResult {
  stopReason?: string;
  cancelled: boolean;
  usage: { input: number; output: number; cachedRead?: number; total?: number };
  error?: string;
}

interface PendingRequest {
  resolve: (message: AcpMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const INIT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_600_000;

export class DevinAcpClient {
  private readonly options: DevinAcpClientOptions;
  private readonly spawnFn: typeof spawn;
  private child: ChildProcess | null = null;
  /** Newline-delimited JSON reassembly buffer over the child's stdout. */
  private lineBuffer = '';
  private pending = new Map<string | number, PendingRequest>();
  private nextIdCounter = 0;
  private updateHandler: (update: AcpSessionUpdate) => void;
  /** True while a `session/load` handshake is in flight. Review fix 1: replay
   *  `session/update` notifications that arrive before the load resolves are
   *  dropped — they must never reach the live turn handler or its turnText. */
  private loadPending = false;
  nativeSessionId: string | null = null;
  hasExited = false;
  exitCode: number | null = null;
  /** Args used for the last spawn (test assertion surface; never the model flag). */
  lastSpawnArgs: string[] = [];

  constructor(options: DevinAcpClientOptions) {
    this.options = options;
    this.spawnFn = options.spawnFn ?? spawn;
    this.updateHandler = options.onSessionUpdate ?? (() => undefined);
  }

  onSessionUpdate(handler: (update: AcpSessionUpdate) => void): void {
    this.updateHandler = handler;
  }

  private childEnv(): NodeJS.ProcessEnv {
    return devinSpawnEnv(this.options.devinHome, { ...process.env, ...(this.options.extraEnv ?? {}) });
  }

  /**
   * Spawn `devin acp`, run the ACP v1 handshake, and create (`session/new`)
   * or resume (`session/load`) the session. Idempotent: a started client is
   * returned as-is.
   */
  async start(): Promise<{ nativeSessionId: string }> {
    if (this.child && !this.hasExited && this.nativeSessionId) {
      return { nativeSessionId: this.nativeSessionId };
    }
    // `devin acp` only: never `devin -p` (brief: ACP only). No --model flag:
    // the flag LOSES to the config file (plan §2) — the model is set per
    // session through session/set_config_option.
    this.lastSpawnArgs = ['acp'];
    const child = this.spawnFn(this.options.executablePath, this.lastSpawnArgs, {
      cwd: this.options.cwd,
      env: this.childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.hasExited = false;
    this.exitCode = null;

    child.on('exit', (code) => {
      this.hasExited = true;
      this.exitCode = code ?? null;
      const error = new Error(`devin acp exited (code ${code ?? 'signal'})`);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    child.on('error', (err) => {
      // Review fix 2a: a spawn failure (ENOENT/EACCES on the binary) must
      // never surface as an uncaught 'error' event (it would graceful-shutdown
      // the whole control plane). Mark exited and fail pending requests.
      this.hasExited = true;
      this.exitCode = null;
      const error = err instanceof Error ? err : new Error(String(err));
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      logger.warn('devin acp process error: %s', error.message);
    });
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.lineBuffer += chunk;
      let idx = this.lineBuffer.indexOf('\n');
      while (idx >= 0) {
        const line = this.lineBuffer.slice(0, idx);
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        this.onLine(line);
        idx = this.lineBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      // The CLI writes its own structured logs to stderr; keep one bounded line.
      const text = d.toString().split('\n').filter(Boolean).pop();
      if (text) logger.debug('devin acp stderr: %s', text.slice(0, 400));
    });

    // ACP v1 handshake — fs/terminal client capabilities false (we never serve
    // files or terminals to the agent; the session request_permission answer
    // and bypass mode cover tool permissions). Review fix 2: the whole
    // handshake (initialize / session/new / session/load /
    // set_config_option) is wrapped — any failure or timeout stops the child
    // before rethrowing, so a failed start never leaks the spawned process.
    try {
      const init = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'pi-web-ui', version: '1.0.0' },
      }, this.options.initTimeoutMs ?? INIT_TIMEOUT_MS);
      if (init.error) {
        throw new Error(`devin acp initialize failed: ${init.error.message}`);
      }

      if (this.options.resumeNativeSessionId) {
        this.loadPending = true;
        try {
          const loaded = await this.request('session/load', {
            sessionId: this.options.resumeNativeSessionId,
            cwd: this.options.cwd,
            mcpServers: [],
          }, this.options.initTimeoutMs ?? INIT_TIMEOUT_MS);
          if (loaded.error) {
            throw new Error(`devin acp session/load failed: ${loaded.error.message}`);
          }
          this.nativeSessionId = this.options.resumeNativeSessionId;
        } finally {
          this.loadPending = false;
        }
      } else {
        const created = await this.request('session/new', {
          cwd: this.options.cwd,
          mcpServers: [],
        }, this.options.initTimeoutMs ?? INIT_TIMEOUT_MS);
        if (created.error || !created.result || typeof (created.result as { sessionId?: unknown }).sessionId !== 'string') {
          throw new Error(`devin acp session/new failed: ${created.error?.message ?? 'no sessionId in result'}`);
        }
        this.nativeSessionId = (created.result as { sessionId: string }).sessionId;
      }

      // Plan D6: children run bypass mode. The mode config option exists on
      // every session (live-validated availableModes include `bypass`). A
      // failure here is a handshake failure: stop the child and rethrow.
      await this.setConfigOption('mode', 'bypass');
    } catch (error) {
      this.stop();
      throw error;
    }

    return { nativeSessionId: this.nativeSessionId };
  }

  private onLine(line: string): void {
    const parsed = parseAcpLine(line);
    if (parsed.kind === 'invalid') {
      logger.debug('devin acp unparsable line: %s', parsed.reason);
      return;
    }
    const message = parsed.message;
    if (isAgentToClientRequest(message)) {
      this.answerAgentRequest(message);
      return;
    }
    if (message.method === 'session/update') {
      if (this.loadPending) {
        // Review fix 1: session/load replay — dropped. It is history the
        // service already holds in its own turn store; it must never reach
        // the live turn handler, its events or its turnText.
        const kind = (message as unknown as { params?: { update?: { sessionUpdate?: string } } }).params?.update?.sessionUpdate;
        logger.debug('devin acp replay update dropped during session/load: %s', kind ?? '<none>');
        return;
      }
      try {
        this.updateHandler(message as unknown as AcpSessionUpdate);
      } catch (error) {
        logger.warn('session/update handler failed: %s', error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
      return;
    }
    // Unknown agent notification (_cognition.ai/* and friends): ignore safely.
    logger.debug('devin acp notification ignored: %s', message.method ?? '<none>');
  }

  /** Agent→client request answering by policy (plan D6). */
  private answerAgentRequest(message: AcpMessage): void {
    if (message.method === 'session/request_permission') {
      const params = (message.params ?? {}) as { options?: Array<{ optionId?: string; kind?: string }> };
      const options = Array.isArray(params.options) ? params.options : [];
      const allow = options.find((o) => typeof o.kind === 'string' && o.kind.startsWith('allow'))
        ?? options.find((o) => typeof o.optionId === 'string' && o.optionId.startsWith('allow'))
        ?? options[0];
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        result: { outcome: { outcome: 'selected', optionId: allow?.optionId ?? '' } },
      });
      return;
    }
    // fs/read_text_file, terminal/… and future extensions: method-not-found.
    this.write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not supported by pi-web-ui: ${message.method}` },
    });
  }

  private write(message: AcpMessage): void {
    if (!this.child?.stdin || this.hasExited) {
      logger.warn('devin acp write dropped (no stdin or exited): %s', message.method ?? 'response');
      return;
    }
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private request(method: string, params: unknown, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<AcpMessage> {
    if (this.hasExited) {
      return Promise.reject(new Error(`devin acp exited; cannot send ${method}`));
    }
    const requestId = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`devin acp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id: requestId, method, params });
    });
  }

  private nextId(): string {
    this.nextIdCounter += 1;
    return `piw-${nextRequestId()}-${this.nextIdCounter}`;
  }
  /** Send one user turn; resolves with the terminal prompt result. */
  async prompt(text: string): Promise<AcpTurnResult> {
    if (!this.nativeSessionId) throw new Error('devin acp client not started');
    const response = await this.request('session/prompt', {
      sessionId: this.nativeSessionId,
      prompt: [{ type: 'text', text }],
    });
    if (response.error) {
      return { cancelled: false, usage: { input: 0, output: 0 }, error: response.error.message };
    }
    const result = (response.result ?? {}) as {
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; totalTokens?: number };
    };
    const usage = {
      input: result.usage?.inputTokens ?? 0,
      output: result.usage?.outputTokens ?? 0,
      ...(result.usage?.cachedReadTokens !== undefined ? { cachedRead: result.usage.cachedReadTokens } : {}),
      ...(result.usage?.totalTokens !== undefined ? { total: result.usage.totalTokens } : {}),
    };
    return {
      ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
      cancelled: result.stopReason === 'cancelled',
      usage,
    };
  }

  /** session/cancel (idempotent; the pending prompt resolves 'cancelled'). */
  cancel(): void {
    logger.info('cancel requested: nativeId=%s exited=%s hasChild=%s', this.nativeSessionId, this.hasExited, Boolean(this.child?.stdin));
    if (!this.nativeSessionId || this.hasExited) return;
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.nativeSessionId } });
  }

  /** Set a session config option (`model`, `mode`) — never a spawn flag.
   *  Wire shape (live-probed v3000.12.28): {sessionId, configId, value}; the
   *  result echoes the session's updated configOptions. */
  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.nativeSessionId) throw new Error('devin acp client not started');
    const response = await this.request('session/set_config_option', {
      sessionId: this.nativeSessionId,
      configId,
      value,
    }, 10_000);
    if (response.error) throw new Error(`session/set_config_option ${configId} failed: ${response.error.message}`);
  }

  /** Stop the child (SIGTERM then SIGKILL after a grace period). */
  stop(graceMs = 3000): void {
    const child = this.child;
    if (!child || this.hasExited) return;
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, graceMs);
    if (typeof killer.unref === 'function') killer.unref();
    try { child.stdin?.end(); } catch { /* already closed */ }
  }
}

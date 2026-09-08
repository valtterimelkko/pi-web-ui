import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../logging/logger.js';
import { mapAgyUsage } from './agy-event-normalizer.js';
import { parseAgyLine, type ParsedAgyLine } from './agy-event-types.js';

const logger = createLogger('AgyStreamProcess');

/**
 * One persistent agy process in `--input-format stream-json
 * --output-format stream-json` mode (plan Phase 3 / T3.1–T3.7).
 *
 * Live-validated behaviours this class relies on (2026-09-08, agy 1.1.27):
 * - one `result` event per turn, in write order (FIFO);
 * - a user event written while a turn runs is queued by agy and executed as
 *   the next turn — so queueing is a plain write-through;
 * - SIGTERM/SIGINT mid-turn produce a closing `result` (ERROR) then exit;
 * - stdin close after the current turn completes exits cleanly with 0;
 * - malformed stdout lines / unknown event names never crash the stream.
 *
 * The parent (AntigravityService) owns respawn-with-`--conversation`,
 * persistence, and user-facing failure bodies; this class owns the child
 * lifecycle, framing, queue bookkeeping, and watchdogs.
 */

/** Flattened outcome of one turn. `reason` is set only for parent-caused or
 * infra failures; agy's own verdict lives in `status`/`error`. */
export interface AgyTurnOutcome {
  status?: string;
  response?: string;
  usage?: Record<string, number>;
  error?: string;
  numTurns?: number;
  durationSeconds?: number;
  conversationId?: string;
  reason?: 'timeout' | 'stall' | 'aborted' | 'process-exited';
}

interface PendingTurn {
  resolve: (outcome: AgyTurnOutcome) => void;
  hardTimer: ReturnType<typeof setTimeout>;
}

export interface AgyStreamProcessOptions {
  sessionId: string;
  cwd: string;
  /** Canonical slug (agy-models.canonicalizeAgyModelId before construction). */
  model?: string;
  /** Durable conversation id to resume; MUST be validated non-empty upstream
   *  (an empty string resumes an unrelated recent conversation — live-validated). */
  conversationId?: string | null;
  extraArgs?: string[];
  timeoutMs: number;
  stallTimeoutMs: number;
  idleTimeoutMs: number;
  /** Every parsed stdout line (the service feeds its AgyEventNormalizer). */
  onEvent: (parsed: ParsedAgyLine) => void;
  spawnFn?: typeof spawn;
}

const AGY_BINARY = process.env.AGY_BINARY || '/root/.local/bin/agy';
const ABORT_GRACE_MS = 5_000;

export class AgyStreamProcess {
  private readonly opts: AgyStreamProcessOptions;
  private child: ChildProcess | null = null;
  private buffer = '';
  private pending: PendingTurn[] = [];
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private abortGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortRequested = false;
  private exited = false;
  private stderrSampleCount = 0;
  private _conversationId: string | null = null;
  private _permissionMode: string | null = null;

  constructor(options: AgyStreamProcessOptions) {
    this.opts = options;
  }

  /** Conversation id as reported by the stream (init/result events). */
  get conversationId(): string | null {
    return this._conversationId;
  }

  get permissionMode(): string | null {
    return this._permissionMode;
  }

  get hasPendingTurns(): boolean {
    return this.pending.length > 0;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  private buildArgs(): string[] {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (this.opts.model) args.push('--model', this.opts.model);
    // Never pass an empty/whitespace id: agy resumes an UNRELATED recent
    // conversation for the empty string (live-validated hazard).
    const conv = this.opts.conversationId?.trim();
    if (conv) args.push('--conversation', conv);
    if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);
    return args;
  }

  async start(): Promise<void> {
    if (this.child && !this.exited) return;
    const spawnFn = this.opts.spawnFn ?? spawn;
    const env = { ...process.env, PATH: `/root/.local/bin:${process.env.PATH ?? ''}` };
    const child = spawnFn(AGY_BINARY, this.buildArgs(), {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = false;
    this.abortRequested = false;
    this.stderrSampleCount = 0;

    child.stdout?.on('data', (chunk: Buffer | string) => this.feedStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer | string) => this.feedStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.on('close', (code) => this.onClose(code));
    child.on('error', (err) => {
      // Spawn-level failure: surface like an exit so pending turns unblock.
      logger.errorObject('agy stream process error', err);
      this.onClose(-1);
    });

    // Newly armed idle clock; the first writeTurn cancels it.
    this.armIdleTimer();
  }

  private feedStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const parsed = parseAgyLine(line);
      this.onActivity();
      if (parsed.kind === 'init') {
        this._conversationId = parsed.conversationId;
        this._permissionMode = parsed.init.permission_mode ?? null;
      } else if (parsed.kind === 'result') {
        this._conversationId = parsed.conversationId;
        this.resolveHeadFromResult(parsed);
      }
      try {
        this.opts.onEvent(parsed);
      } catch (error) {
        logger.warn('onEvent observer threw (non-fatal): %s', error instanceof Error ? error.message : String(error));
      }
      if (parsed.kind === 'invalid') {
        // Rate-bound visibility: first few, then every 50th.
        this.stderrSampleCount++;
        if (this.stderrSampleCount <= 5 || this.stderrSampleCount % 50 === 0) {
          logger.warn('agy stdout line unparseable (count=%d): %.120s', this.stderrSampleCount, line);
        }
      }
    }
  }

  private feedStderr(chunk: string): void {
    const text = chunk.trim();
    if (!text) return;
    // agy diagnostics (warnings, soft-denials) — bounded sampling, never fatal.
    if (this.stderrSampleCount <= 20) logger.warn('agy stderr: %.200s', text);
  }

  private onClose(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.clearTimers();
    const reason: AgyTurnOutcome['reason'] = this.abortRequested ? 'aborted' : 'process-exited';
    for (const turn of this.pending) {
      clearTimeout(turn.hardTimer);
      turn.resolve({ reason });
    }
    this.pending = [];
    logger.info('agy stream process exited code=%s pendingResolved=%s', code, reason);
  }

  private resolveHeadFromResult(parsed: Extract<ParsedAgyLine, { kind: 'result' }>): void {
    const head = this.pending.shift();
    clearTimeout(head?.hardTimer ?? undefined);
    if (!head) return;
    const result = parsed.result;
    head.resolve({
      status: result.status,
      response: result.response,
      usage: mapAgyUsage(result.usage),
      error: result.error,
      numTurns: result.num_turns,
      durationSeconds: result.duration_seconds,
      conversationId: result.conversation_id,
      ...(this.abortRequested ? { reason: 'aborted' as const } : {}),
    });
    if (this.pending.length === 0) this.armIdleTimer();
    else this.armTurnTimer(this.pending[0]);
  }

  /** Write one turn prompt. Resolves with THIS turn's result (FIFO). Writes
   *  are fire-and-forget into stdin — agy buffers mid-turn writes itself. */
  writeTurn(prompt: string): Promise<AgyTurnOutcome> {
    const stdin = this.child?.stdin;
    if (this.exited || !this.child || !stdin || stdin.destroyed) {
      return Promise.reject(new Error('agy stream process has exited; respawn required'));
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return new Promise<AgyTurnOutcome>((resolve) => {
      const hardTimer = setTimeout(() => {
        logger.warn('turn exceeded hard ceiling (%dms); SIGTERM', this.opts.timeoutMs);
        this.child?.kill('SIGTERM');
        this.resolveAllPendingWithReason('timeout');
      }, this.opts.timeoutMs);
      if (typeof hardTimer.unref === 'function') hardTimer.unref();
      const turn: PendingTurn = { resolve, hardTimer };
      this.pending.push(turn);
      stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      if (this.pending.length === 1) this.armStallTimer();
    });
  }

  /** Abort the in-flight work: SIGTERM, consume the closing result with a
   *  grace window, then escalate to SIGKILL. */
  abort(): void {
    if (this.exited || this.pending.length === 0) return;
    this.abortRequested = true;
    this.child?.kill('SIGTERM');
    this.abortGraceTimer = setTimeout(() => {
      if (!this.exited) this.child?.kill('SIGKILL');
    }, ABORT_GRACE_MS);
    if (typeof this.abortGraceTimer.unref === 'function') this.abortGraceTimer.unref();
  }

  private resolveAllPendingWithReason(reason: NonNullable<AgyTurnOutcome['reason']>): void {
    for (const turn of this.pending) {
      clearTimeout(turn.hardTimer);
      turn.resolve({ reason });
    }
    this.pending = [];
  }

  private armTurnTimer(_turn: PendingTurn): void {
    // Hard ceilings are armed per-turn at write time; nothing extra to do here
    // beyond restarting the stall clock for the new head.
    this.armStallTimer();
  }

  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.pending.length === 0) return;
    this.stallTimer = setTimeout(() => {
      if (this.pending.length === 0 || this.exited) return;
      logger.warn('no stream events for %dms; SIGTERM (stall)', this.opts.stallTimeoutMs);
      this.child?.kill('SIGTERM');
      this.resolveAllPendingWithReason('stall');
    }, this.opts.stallTimeoutMs);
    if (typeof this.stallTimer.unref === 'function') this.stallTimer.unref();
  }

  private onActivity(): void {
    if (this.pending.length > 0) this.armStallTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.length > 0 || this.exited) return;
      logger.info('idle timeout reached; closing agy stdin (graceful exit)');
      const stdin = this.child?.stdin;
      if (stdin && !stdin.destroyed) stdin.end();
    }, this.opts.idleTimeoutMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  private clearTimers(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.abortGraceTimer) clearTimeout(this.abortGraceTimer);
    this.stallTimer = null;
    this.idleTimer = null;
    this.abortGraceTimer = null;
  }
}

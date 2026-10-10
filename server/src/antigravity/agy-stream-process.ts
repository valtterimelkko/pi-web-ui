import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../logging/logger.js';
import { applySessionIdentityEnv, type SessionEnvIdentity } from '../session-env-identity.js';
import { planSpawnForSession, planSpawnOwn, placementForSpawn } from '../placement/index.js';
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
  /** Hard-ceiling timer. Armed only while the turn is the HEAD of the queue, so
   *  a queued follow-up is never charged for the time it spent waiting. */
  hardTimer: ReturnType<typeof setTimeout> | null;
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
  /** Per-turn hard ceiling (a runaway backstop, not a work limit). */
  timeoutMs: number;
  /** Max silence on the wire while the model is thinking/answering. */
  stallTimeoutMs: number;
  /** Max silence while a tool step is in flight. agy emits NOTHING between a
   *  tool's ACTIVE and DONE updates (live-measured: a `sleep 150` is one 151 s
   *  gap), so a healthy long build/test needs a window longer than the model-
   *  silence one. Defaults to `stallTimeoutMs` (the pre-fix behaviour). */
  toolStallTimeoutMs?: number;
  idleTimeoutMs: number;
  /** Every parsed stdout line (the service feeds its AgyEventNormalizer). */
  onEvent: (parsed: ParsedAgyLine) => void;
  spawnFn?: typeof spawn;
  /** Contract 1.47.0: Pi Web UI session identity exported to the agy env. */
  sessionIdentity?: SessionEnvIdentity;
}

const AGY_BINARY = process.env.AGY_BINARY || '/root/.local/bin/agy';
const ABORT_GRACE_MS = 5_000;

export class AgyStreamProcess {
  private readonly opts: AgyStreamProcessOptions;
  private child: ChildProcess | null = null;
  /** D0: placement plan for the current child (undefined when unplaced). */
  private placementLaunch: { cleanup(): void } | undefined;
  private buffer = '';
  private pending: PendingTurn[] = [];
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private abortGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortRequested = false;
  /** step_index of tool steps reported ACTIVE and not yet finished. */
  private activeToolSteps = new Set<number>();
  private exited = false;
  /** A SIGTERM has been sent (stall, ceiling or abort) but the child has not closed yet.
   *  Its closing `result` ("interrupted") must never be matched to a NEW turn, so the
   *  process is unusable from this instant and the service respawns. */
  private terminating = false;
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
    return this.exited || this.terminating;
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
    const env = applySessionIdentityEnv(
      { ...process.env, PATH: `/root/.local/bin:${process.env.PATH ?? ''}` },
      this.opts.sessionIdentity,
    );
    // D0 placement: the persistent agy child is bound to its antigravity session
    // (registry session id) when present, else its own group. Unplaced when off.
    const agyKey = this.opts.sessionIdentity?.sessionId ?? this.opts.sessionId;
    const launch = (agyKey
      ? planSpawnForSession(placementForSpawn(), { kind: 'rt', runtime: 'antigravity', id: agyKey }, [AGY_BINARY, ...this.buildArgs()], env)
      : planSpawnOwn(placementForSpawn(), [AGY_BINARY, ...this.buildArgs()], env))
      ?? { file: AGY_BINARY, args: this.buildArgs(), env, group: '', cleanup: () => {} };
    this.placementLaunch = launch;
    const child = spawnFn(launch.file, launch.args, {
      cwd: this.opts.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exited = false;
    this.terminating = false;
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
      this.trackToolSteps(parsed);
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
    this.placementLaunch?.cleanup();
    this.placementLaunch = undefined;
    const reason: AgyTurnOutcome['reason'] = this.abortRequested ? 'aborted' : 'process-exited';
    for (const turn of this.pending) {
      if (turn.hardTimer) clearTimeout(turn.hardTimer);
      turn.resolve({ reason });
    }
    this.pending = [];
    logger.info('agy stream process exited code=%s pendingResolved=%s', code, reason);
  }

  private resolveHeadFromResult(parsed: Extract<ParsedAgyLine, { kind: 'result' }>): void {
    const head = this.pending.shift();
    if (head?.hardTimer) clearTimeout(head.hardTimer);
    this.activeToolSteps.clear();
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
    if (this.exited || this.terminating || !this.child || !stdin || stdin.destroyed) {
      return Promise.reject(new Error('agy stream process has exited; respawn required'));
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    return new Promise<AgyTurnOutcome>((resolve) => {
      const turn: PendingTurn = { resolve, hardTimer: null };
      this.pending.push(turn);
      stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      if (this.pending.length === 1) {
        this.armHardTimer(turn);
        this.armStallTimer();
      }
    });
  }

  /** Abort the in-flight work: SIGTERM, consume the closing result with a
   *  grace window, then escalate to SIGKILL. */
  abort(): void {
    if (this.exited || this.pending.length === 0) return;
    this.abortRequested = true;
    this.terminating = true;
    this.child?.kill('SIGTERM');
    this.abortGraceTimer = setTimeout(() => {
      if (!this.exited) this.child?.kill('SIGKILL');
    }, ABORT_GRACE_MS);
    if (typeof this.abortGraceTimer.unref === 'function') this.abortGraceTimer.unref();
  }

  private resolveAllPendingWithReason(reason: NonNullable<AgyTurnOutcome['reason']>): void {
    for (const turn of this.pending) {
      if (turn.hardTimer) clearTimeout(turn.hardTimer);
      turn.resolve({ reason });
    }
    this.pending = [];
  }

  private armTurnTimer(turn: PendingTurn): void {
    // A queued turn becomes the head: its own ceiling and stall clock start now.
    this.armHardTimer(turn);
    this.armStallTimer();
  }

  private armHardTimer(turn: PendingTurn): void {
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    const timer = setTimeout(() => {
      logger.warn('turn exceeded hard ceiling (%dms); SIGTERM', this.opts.timeoutMs);
      this.terminating = true;
      this.child?.kill('SIGTERM');
      this.resolveAllPendingWithReason('timeout');
    }, this.opts.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    turn.hardTimer = timer;
  }

  /** agy is silent for a tool's whole run, so remember which tool steps are open. */
  private trackToolSteps(parsed: ParsedAgyLine): void {
    if (parsed.kind !== 'step' || parsed.step.step_type !== 'tool') return;
    if (parsed.step.state === 'ACTIVE') this.activeToolSteps.add(parsed.step.step_index);
    else this.activeToolSteps.delete(parsed.step.step_index);
  }

  private currentStallWindowMs(): number {
    const tool = this.opts.toolStallTimeoutMs;
    return this.activeToolSteps.size > 0 && tool !== undefined ? Math.max(tool, this.opts.stallTimeoutMs) : this.opts.stallTimeoutMs;
  }

  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.pending.length === 0) return;
    const windowMs = this.currentStallWindowMs();
    this.stallTimer = setTimeout(() => {
      if (this.pending.length === 0 || this.exited) return;
      logger.warn('no stream events for %dms%s; SIGTERM (stall)', windowMs, this.activeToolSteps.size > 0 ? ' with a tool in flight' : '');
      this.terminating = true;
      this.child?.kill('SIGTERM');
      this.resolveAllPendingWithReason('stall');
    }, windowMs);
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

  /** Graceful stop (model switch / dispose): close stdin, let the current
   *  state drain, process exits 0. Idempotent. */
  stop(): void {
    if (this.exited) return;
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
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

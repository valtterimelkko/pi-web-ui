/**
 * B3b — pi-web-ui-side per-run output-token and streamed-byte budgets
 * (the rest of B3, beside B3a's tool-argument budget).
 *
 * WHY THIS EXISTS
 * The 2026-09-12 stall class is bigger than tool-call arguments: ANY runaway
 * generation — endless prose, thinking, or tool-call streams — monopolises
 * the event loop and grows the heap for as long as the provider keeps
 * streaming. B3a bounds the quadratic tool-argument parse; this module bounds
 * the total generated volume per run from pi-web-ui's side of the boundary
 * (owner rule: upstream packages stay pristine; only public APIs are used).
 *
 * WHAT IS COUNTED
 * Installed at the single in-process Pi funnel (PiService.createSession's
 * `session.subscribe` closure), per run (agent_start → agent_end):
 *   - streamed bytes: every public `text_delta` / `thinking_delta` /
 *     `toolcall_delta` character string, counted as UTF-8 bytes (the LIVE
 *     mid-stream bound — counting is O(delta) with no allocation);
 *   - output tokens: the public `usage.output` each assistant message
 *     reports at `message_end`, summed across the run's messages. pi-ai
 *     reports usage only in the final streaming chunk, i.e. AT MESSAGE END —
 *     so the token cap trips at message boundaries and the byte cap is the
 *     live bound within a message. Providers that report no usage (0.05% of
 *     measured assistant messages) simply never trip the token cap; the byte
 *     cap still bounds them.
 *
 * HOW IT ENFORCES
 * When a cap trips it:
 *   1. emits one synthetic `run_budget_exceeded` event through the same
 *      handler (`data.budget` distinguishes "output_tokens" from
 *      "streamed_bytes"; the receipt itself persists only the terminal code),
 *      then
 *   2. aborts the turn via the PUBLIC `AgentSession.abort()` — the loop then
 *      ends the run normally with `stopReason: "aborted"`.
 * The Internal API's Pi dispatch path turns the synthetic event into a
 * `PiRunBudgetExceededError`, which `runtimeErrorCode` maps to the
 * `RUN_BUDGET_EXCEEDED` receipt terminal code (the same code B3a uses; the
 * budget kind travels on the event stream).
 *
 * Zero-cap configuration disables the guard entirely. The abort follows the
 * bounded pattern B3a's corrections 03–05 pinned: exactly one attempt in
 * flight at a time, a settled rejection leaves the run un-latched so the
 * next delta retries (bounded at 3 attempts, then one error-level log and a
 * terminal latch), a merely slow abort never spawns duplicates, and this
 * run's state is captured so a queued follow-up run is never touched.
 */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { createLogger } from '../logging/logger.js';

const logger = createLogger('RunBudget');

/** Normalized event type emitted when a cap trips (contract 1.50.0). */
export const RUN_BUDGET_EXCEEDED_EVENT = 'run_budget_exceeded';

/** Which per-run budget tripped (contract 1.50.0). */
export type RunBudgetKind = 'output_tokens' | 'streamed_bytes';

export interface RunBudgetCaps {
  /** Per-run cap on summed assistant output tokens; 0 disables the dimension. */
  outputTokens: number;
  /** Per-run cap on streamed assistant bytes (text + thinking + tool args); 0 disables. */
  streamedBytes: number;
}

/** Minimal abort surface used from the guard (public AgentSession API). */
interface AbortableSession {
  abort: () => Promise<void>;
}

/** Event sink for the synthetic breach event (the session's own handler). */
type SyntheticEmitter = (event: Record<string, unknown>) => void;

/**
 * The error the Internal API maps to the RUN_BUDGET_EXCEEDED receipt code.
 * Carries which budget tripped, the cap and the observed size for the
 * dispatch error message; the persisted receipt holds only the code — the
 * structured details travel on the session event stream.
 */
export class PiRunBudgetExceededError extends Error {
  readonly budget: RunBudgetKind;
  readonly cap: number;
  readonly observed: number;

  constructor(budget: RunBudgetKind, cap: number, observed: number) {
    const what = budget === 'output_tokens' ? 'output tokens' : 'streamed assistant output';
    const unit = budget === 'output_tokens' ? 'tokens' : 'bytes';
    const formattedCap = cap.toLocaleString('en-GB');
    const formattedObserved = observed.toLocaleString('en-GB');
    super(
      `This run's ${what} exceeded the ${formattedCap}-${unit} budget (${formattedObserved} observed); ` +
        'the turn was aborted to stop the runaway generation from monopolising the event loop and heap.',
    );
    this.name = 'PiRunBudgetExceededError';
    this.budget = budget;
    this.cap = cap;
    this.observed = observed;
  }
}

interface BudgetRunState {
  streamedBytes: number;
  outputTokens: number;
  /** Terminal latch: no further counting or abort attempts this run. */
  breached: boolean;
  /** The synthetic reason event is emitted at most once per run. */
  syntheticEmitted: boolean;
  abortAttempts: number;
  /** One abort attempt in flight at a time; retries only after a settled rejection. */
  abortInFlight: boolean;
}

/** Bounded abort retries (mirrors B3a correction 03). */
const MAX_ABORT_ATTEMPTS = 3;

/** Reusable scratch for UTF-8 length counting: O(delta) time, no allocation
 *  for deltas that fit. Oversized deltas fall back to a one-shot encode. */
const ENCODER = new TextEncoder();
const SCRATCH_BYTES = 64 * 1024;
const SCRATCH = new Uint8Array(SCRATCH_BYTES);

function utf8Length(text: string): number {
  if (text.length <= SCRATCH_BYTES / 4) {
    const result = ENCODER.encodeInto(text, SCRATCH);
    return result.written;
  }
  return ENCODER.encode(text).length;
}

/**
 * Per-session guard. One instance per PiService session, captured by that
 * session's subscribe closure. Never throws; an abort rejection is logged and
 * swallowed (the upstream loop still terminates the run its own way).
 */
export class RunBudgetGuard {
  private readonly caps: RunBudgetCaps;
  private run: BudgetRunState = RunBudgetGuard.freshRun();

  constructor(caps: RunBudgetCaps) {
    this.caps = caps;
  }

  private static freshRun(): BudgetRunState {
    return { streamedBytes: 0, outputTokens: 0, breached: false, syntheticEmitted: false, abortAttempts: 0, abortInFlight: false };
  }

  /**
   * Observe one raw session event. Must be called for EVERY event so
   * `agent_start` resets the run; only streamed deltas and assistant
   * `message_end` usage accumulate.
   */
  observe(session: AbortableSession, event: AgentSessionEvent | unknown, emit: SyntheticEmitter): void {
    if (event === null || typeof event !== 'object') return;
    const type = (event as { type?: unknown }).type;

    if (type === 'agent_start') {
      this.run = RunBudgetGuard.freshRun();
      return;
    }
    if (this.caps.outputTokens <= 0 && this.caps.streamedBytes <= 0) return;
    if (this.run.breached) return;

    if (type === 'message_update') {
      const assistantEvent = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
      if (assistantEvent === null || typeof assistantEvent !== 'object') return;
      const assistantType = (assistantEvent as { type?: unknown }).type;
      if (assistantType !== 'text_delta' && assistantType !== 'thinking_delta' && assistantType !== 'toolcall_delta') return;
      if (this.caps.streamedBytes <= 0) return;
      const delta = (assistantEvent as { delta?: unknown }).delta;
      if (typeof delta !== 'string' || delta.length === 0) return;
      this.run.streamedBytes += utf8Length(delta);
      if (this.run.streamedBytes > this.caps.streamedBytes) {
        this.breach(session, emit, 'streamed_bytes', this.caps.streamedBytes, this.run.streamedBytes);
      }
      return;
    }

    if (type === 'message_end') {
      if (this.caps.outputTokens <= 0) return;
      const message = (event as { message?: unknown }).message;
      if (message === null || typeof message !== 'object') return;
      if ((message as { role?: unknown }).role !== 'assistant') return;
      const usage = (message as { usage?: unknown }).usage;
      if (usage === null || typeof usage !== 'object') return;
      const output = (usage as { output?: unknown }).output;
      if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0) return;
      this.run.outputTokens += output;
      if (this.run.outputTokens > this.caps.outputTokens) {
        this.breach(session, emit, 'output_tokens', this.caps.outputTokens, this.run.outputTokens);
      }
    }
  }

  private breach(
    session: AbortableSession,
    emit: SyntheticEmitter,
    budget: RunBudgetKind,
    cap: number,
    observed: number,
  ): void {
    // Capture THIS run: agent_start replaces this.run, and abort() settles on
    // the idle transition — a queued follow-up can start the next run before
    // the promise resolves, so the callbacks below must mutate only the run
    // they belonged to, never the new one (B3a correction 04 pattern).
    const run = this.run;
    // Emit the reason BEFORE aborting so every observer sees it before the
    // aborted turn's terminal events — exactly once per run.
    if (!run.syntheticEmitted) {
      run.syntheticEmitted = true;
      try {
        emit({
          type: RUN_BUDGET_EXCEEDED_EVENT,
          timestamp: Date.now(),
          data: { budget, cap, observed },
        });
      } catch (emitError) {
        logger.warn(`synthetic budget event could not be emitted: ${emitError instanceof Error ? emitError.message : String(emitError)}`);
      }
    }
    // Fire-and-forget: abort() awaits the run's idle transition upstream; a
    // rejection must not escape into the event pipeline. Exactly one attempt
    // is in flight at a time: a rejected abort leaves the run un-latched so
    // the NEXT delta retries (bounded), while a merely SLOW abort never
    // spawns duplicate attempts (B3a corrections 03–05 pattern).
    if (!run.abortInFlight) {
      const attempt = run.abortAttempts + 1;
      run.abortAttempts = attempt;
      run.abortInFlight = true;
      void session.abort().then(
        () => {
          run.abortInFlight = false;
          run.breached = true;
        },
        (abortError: unknown) => {
          run.abortInFlight = false;
          if (attempt >= MAX_ABORT_ATTEMPTS) {
            run.breached = true;
            logger.error(
              `session.abort() failed ${attempt} times after the ${budget} budget breach ` +
                `(${abortError instanceof Error ? abortError.message : String(abortError)}); ` +
                'giving up for this run — the run may continue past the caps',
            );
          } else {
            logger.warn(
              `session.abort() attempt ${attempt}/${MAX_ABORT_ATTEMPTS} failed after the ${budget} budget breach: ` +
                `${abortError instanceof Error ? abortError.message : String(abortError)}; will retry on the next delta`,
            );
          }
        },
      );
    }
  }
}

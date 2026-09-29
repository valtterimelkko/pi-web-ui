/**
 * B3a — pi-web-ui-side streaming tool-argument budget (per-tool-call and
 * per-run caps on streamed tool-call argument characters).
 *
 * WHY THIS EXISTS
 * pi-ai's openai-completions adapter re-parses the accumulated tool-call
 * argument buffer on EVERY streamed delta (upstream behaviour, left pristine
 * by owner decision): linear per call, quadratic over the stream, synchronous
 * on the event loop. The 2026-09-12 production stall (~11 minutes) was one
 * runaway generation accumulating ~460 KB of tool arguments; measured on
 * pristine 0.87.1 this integrates to ~141 s of pure main-thread CPU. Until
 * 2026-09-29 a local node_modules patch bounded it; this module replaces that
 * patch from pi-web-ui's side of the boundary (owner rule: upstream packages
 * stay pristine).
 *
 * HOW IT ENFORCES
 * Installed at the single in-process Pi funnel (PiService.createSession's
 * `session.subscribe` closure), it counts the public `toolcall_delta` strings
 * per tool call and per run (agent_start → agent_end). When a cap trips it:
 *   1. emits one synthetic `tool_args_budget_exceeded` event through the same
 *      handler (so browser subscribers, Internal API observers, the broker and
 *      the receipt event record all see the reason), then
 *   2. aborts the turn via the PUBLIC `AgentSession.abort()` — the loop then
 *      ends the run normally with `stopReason: "aborted"`.
 * The Internal API's Pi dispatch path turns the synthetic event into a
 * `PiToolArgsBudgetExceededError`, which `runtimeErrorCode` maps to the
 * `RUN_BUDGET_EXCEEDED` receipt terminal code.
 *
 * Zero-cap configuration disables the guard entirely; counting is O(1) per
 * delta and every other event costs one property read. All upstream symbols
 * used here are public types/events; nothing in this module imports or edits
 * package internals.
 */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { createLogger } from '../logging/logger.js';

const logger = createLogger('ToolArgsBudget');

/** Normalized event type emitted when a cap trips (contract 1.48.0). */
export const TOOL_ARGS_BUDGET_EXCEEDED_EVENT = 'tool_args_budget_exceeded';

export interface ToolArgsBudgetCaps {
  /** Per-tool-call cap in chars; 0 disables the per-call dimension. */
  callChars: number;
  /** Per-run (agent_start → agent_end) aggregate cap in chars; 0 disables. */
  turnChars: number;
}

/** Minimal abort surface used from the guard (public AgentSession API). */
interface AbortableSession {
  abort: () => Promise<void>;
}

/** Event sink for the synthetic breach event (the session's own handler). */
type SyntheticEmitter = (event: Record<string, unknown>) => void;

/**
 * The error the Internal API maps to the RUN_BUDGET_EXCEEDED receipt code.
 * Carries the cap, the observed size and which cap tripped, so the receipt
 * message is actionable without re-deriving anything.
 */
export class PiToolArgsBudgetExceededError extends Error {
  readonly scope: 'call' | 'turn';
  readonly capChars: number;
  readonly observedChars: number;

  constructor(scope: 'call' | 'turn', capChars: number, observedChars: number) {
    const formattedCap = capChars.toLocaleString('en-GB');
    const formattedObserved = observedChars.toLocaleString('en-GB');
    super(
      `Streamed tool argument ${scope === 'call' ? 'for a single tool call' : 'across this run'} ` +
        `exceeded the ${formattedCap}-character budget (${formattedObserved} observed); ` +
        'the turn was aborted to bound synchronous per-delta parsing (2026-09-12 stall class).',
    );
    this.name = 'PiToolArgsBudgetExceededError';
    this.scope = scope;
    this.capChars = capChars;
    this.observedChars = observedChars;
  }
}

interface BudgetRunState {
  turnTotal: number;
  perCall: Map<number, number>;
  breached: boolean;
}

/**
 * Per-session guard. One instance per PiService session, captured by that
 * session's subscribe closure. Never throws; an abort rejection is logged and
 * swallowed (the upstream loop still terminates the run its own way).
 */
export class ToolArgsBudgetGuard {
  private readonly caps: ToolArgsBudgetCaps;
  private run: BudgetRunState = ToolArgsBudgetGuard.freshRun();

  constructor(caps: ToolArgsBudgetCaps) {
    this.caps = caps;
  }

  private static freshRun(): BudgetRunState {
    return { turnTotal: 0, perCall: new Map<number, number>(), breached: false };
  }

  /**
   * Observe one raw session event. Must be called for EVERY event so
   * `agent_start` resets the run; only `toolcall_delta` events accumulate.
   */
  observe(session: AbortableSession, event: AgentSessionEvent | unknown, emit: SyntheticEmitter): void {
    if (event === null || typeof event !== 'object') return;
    const type = (event as { type?: unknown }).type;

    if (type === 'agent_start') {
      this.run = ToolArgsBudgetGuard.freshRun();
      return;
    }
    if (type !== 'message_update') return;
    if (this.caps.callChars <= 0 && this.caps.turnChars <= 0) return;
    if (this.run.breached) return;

    const assistantEvent = (event as { assistantMessageEvent?: unknown }).assistantMessageEvent;
    if (assistantEvent === null || typeof assistantEvent !== 'object') return;
    const assistantType = (assistantEvent as { type?: unknown }).type;

    if (assistantType === 'toolcall_start' || assistantType === 'toolcall_end') {
      const contentIndex = (assistantEvent as { contentIndex?: unknown }).contentIndex;
      if (typeof contentIndex === 'number') this.run.perCall.delete(contentIndex);
      return;
    }
    if (assistantType !== 'toolcall_delta') return;

    const delta = (assistantEvent as { delta?: unknown }).delta;
    if (typeof delta !== 'string' || delta.length === 0) return;
    const rawIndex = (assistantEvent as { contentIndex?: unknown }).contentIndex;
    const contentIndex = typeof rawIndex === 'number' ? rawIndex : undefined;

    this.run.turnTotal += delta.length;
    if (typeof contentIndex === 'number') {
      this.run.perCall.set(contentIndex, (this.run.perCall.get(contentIndex) ?? 0) + delta.length);
    }

    const callObserved = contentIndex !== undefined ? this.run.perCall.get(contentIndex) ?? 0 : 0;
    if (this.caps.callChars > 0 && callObserved > this.caps.callChars) {
      this.breach(session, emit, 'call', this.caps.callChars, callObserved, contentIndex);
      return;
    }
    if (this.caps.turnChars > 0 && this.run.turnTotal > this.caps.turnChars) {
      this.breach(session, emit, 'turn', this.caps.turnChars, this.run.turnTotal, contentIndex);
    }
  }

  private breach(
    session: AbortableSession,
    emit: SyntheticEmitter,
    scope: 'call' | 'turn',
    capChars: number,
    observedChars: number,
    contentIndex: number | undefined,
  ): void {
    this.run.breached = true;
    const error = new PiToolArgsBudgetExceededError(scope, capChars, observedChars);
    logger.warn(
      `${error.message}${contentIndex !== undefined ? ` (contentIndex=${contentIndex})` : ''} — aborting the turn`,
    );
    // Emit the reason BEFORE aborting so every observer sees it before the
    // aborted turn's terminal events.
    try {
      emit({
        type: TOOL_ARGS_BUDGET_EXCEEDED_EVENT,
        timestamp: Date.now(),
        data: {
          scope,
          capChars,
          observedChars,
          ...(contentIndex !== undefined ? { contentIndex } : {}),
        },
      });
    } catch (emitError) {
      logger.warn(`synthetic budget event could not be emitted: ${emitError instanceof Error ? emitError.message : String(emitError)}`);
    }
    // Fire-and-forget: abort() awaits the run's idle transition upstream; a
    // rejection must not escape into the event pipeline.
    void session.abort().catch((abortError: unknown) => {
      logger.warn(`session.abort() after budget breach failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
    });
  }
}

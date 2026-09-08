import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { AgyEnvelope, AgyInit, AgyStepUpdate, ParsedAgyLine, AgyUsage } from './agy-event-types.js';

/**
 * Pure agy stream-json → NormalizedEvent translator with a per-turn
 * accumulator (plan Phase 1 / T1.1–T1.8).
 *
 * Division of responsibility with AntigravityService:
 * - The **service** owns per-turn lifecycle events that are agy-independent:
 *   `agent_start` and the user-message triple are emitted when a prompt is
 *   accepted (a persistent process emits `init` ONCE, while turns are many —
 *   so `agent_start` cannot be derived from init; this refines plan T1.1,
 *   which was written against the one-shot shape).
 * - The **normalizer** owns everything from the stream: assistant message
 *   open/append/close, tool execution events, stream_activity ticks, and the
 *   closing `agent_end` with the mapped usage + terminal status.
 * - Failure-body synthesis (aborted vs timeout vs agy error text) stays in
 *   the service, which owns the failure taxonomy; the normalizer only
 *   reports `agyStatus`/`error` on the terminal `agent_end`.
 */

export interface AgyToolCallRecord {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  output?: string;
  isError: boolean;
  errorMessage?: string;
}

export interface AgyNormalizerOptions {
  sessionId: string;
  /** Conversation id expected from the store/registry; mismatches fire the callback (T1.7). */
  expectedConversationId?: string | null;
  onConversationIdMismatch?: (info: { expected: string | null; actual: string; source: 'init' | 'result' }) => void;
}

export interface AgyNormalizerState {
  conversationId: string | null;
  initModel: string | null;
  permissionMode: string | null;
  /** True while an assistant message_start has no matching message_end. */
  assistantMessageOpen: boolean;
  /** Concatenated text_delta content for the current turn. */
  turnText: string;
  /** Tool calls recorded during the current turn. */
  turnTools: AgyToolCallRecord[];
}

/** Map agy usage tokens to the neutral keys used across runtimes (additive). */
export function mapAgyUsage(usage: AgyUsage | undefined): Record<string, number> {
  if (!usage) return {};
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    thinking: usage.thinking_tokens,
    cacheRead: usage.cache_read_tokens,
    total: usage.total_tokens,
  };
}

export class AgyEventNormalizer {
  private readonly sessionId: string;
  private readonly expectedConversationId: string | null;
  private readonly onConversationIdMismatch?: AgyNormalizerOptions['onConversationIdMismatch'];

  private assistantMessageId: string | null = null;
  private _lastResult: AgyEnvelope | null = null;
  private _lastTurn: { text: string; tools: AgyToolCallRecord[]; result: AgyEnvelope } | null = null;

  readonly state: AgyNormalizerState = {
    conversationId: null,
    initModel: null,
    permissionMode: null,
    assistantMessageOpen: false,
    turnText: '',
    turnTools: [],
  };

  constructor(options: AgyNormalizerOptions) {
    this.sessionId = options.sessionId;
    this.expectedConversationId = options.expectedConversationId ?? null;
    this.onConversationIdMismatch = options.onConversationIdMismatch;
  }

  /** Terminal envelope of the most recent completed turn (null before one). */
  get lastResult(): AgyEnvelope | null {
    return this._lastResult;
  }

  /** Snapshot of the most recent completed turn (captured before reset). */
  get lastTurn(): { text: string; tools: AgyToolCallRecord[]; result: AgyEnvelope } | null {
    return this._lastTurn;
  }

  /** True while a turn has produced output but not yet seen its result. */
  get turnInFlight(): boolean {
    return this.state.assistantMessageOpen || this.state.turnText.length > 0 || this.state.turnTools.length > 0;
  }

  private ev(type: string, timestamp: number, data: Record<string, unknown>): NormalizedEvent {
    return { type, sessionId: this.sessionId, timestamp, data };
  }

  private noteConversationId(id: string | null, source: 'init' | 'result'): void {
    if (!id) return;
    const previous = this.state.conversationId;
    this.state.conversationId = id;
    if (previous === id) return;
    if (this.expectedConversationId !== null && this.expectedConversationId !== id) {
      // Silent new-conversation hazard (live-validated: an unknown --conversation id
      // creates a fresh conversation without erroring). Surface, never rebind silently.
      this.onConversationIdMismatch?.({ expected: this.expectedConversationId, actual: id, source });
    }
  }

  /**
   * Feed one already-parsed line; returns the normalized events it produces.
   * Never throws: parse failures are decided upstream in parseAgyLine.
   */
  onParsed(parsed: ParsedAgyLine, timestamp: number = Date.now()): NormalizedEvent[] {
    switch (parsed.kind) {
      case 'init':
        return this.onInit(parsed, timestamp);
      case 'step':
        return this.onStep(parsed.step, timestamp);
      case 'result':
        return this.onResult(parsed, timestamp);
      case 'unknown':
      case 'invalid':
        return [];
    }
  }

  private onInit(parsed: Extract<ParsedAgyLine, { kind: 'init' }>, _timestamp: number): NormalizedEvent[] {
    this.noteConversationId(parsed.conversationId, 'init');
    const init: AgyInit = parsed.init;
    this.state.initModel = init.model ?? null;
    this.state.permissionMode = init.permission_mode ?? null;
    return [];
  }

  private onStep(step: AgyStepUpdate, timestamp: number): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];

    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
        if (!this.state.assistantMessageOpen) {
          this.assistantMessageId = randomUUID();
          this.state.assistantMessageOpen = true;
          events.push(this.ev('message_start', timestamp, { id: this.assistantMessageId, role: 'assistant' }));
        }
        this.state.turnText += step.text_delta;
        events.push(
          this.ev('message_update', timestamp, {
            id: this.assistantMessageId,
            assistantMessageEvent: { type: 'text_delta', delta: step.text_delta },
          }),
        );
      }
      // agent_response DONE without text_delta is a reasoning-only model call —
      // no user-facing event (live-validated: most intermediate DONEs are textless).
      return events;
    }

    if (step.step_type === 'tool') {
      if (step.state === 'ACTIVE') {
        const toolCallId = randomUUID();
        this.state.turnTools.push({
          toolCallId,
          toolName: step.tool_name ?? 'unknown',
          isError: false,
        });
        events.push(
          this.ev('tool_execution_start', timestamp, {
            toolCallId,
            toolName: step.tool_name ?? 'unknown',
          }),
        );
        return events;
      }

      // DONE: patch the matching open record (last with this name and no output yet)
      const record = [...this.state.turnTools]
        .reverse()
        .find((t) => t.toolName === (step.tool_name ?? 'unknown') && t.output === undefined);
      const info = step.tool_info;
      const output = typeof info?.output === 'string' ? info.output : undefined;
      const isError = info?.error !== undefined;
      const errorMessage = info?.error?.message;
      if (record) {
        record.args = info?.parameters;
        record.output = output;
        record.isError = isError;
        record.errorMessage = errorMessage;
      } else {
        // DONE without a seen ACTIVE (stream tail loss) — record outright.
        const toolCallId = randomUUID();
        this.state.turnTools.push({
          toolCallId,
          toolName: step.tool_name ?? 'unknown',
          args: info?.parameters,
          output,
          isError,
          errorMessage,
        });
        events.push(
          this.ev('tool_execution_start', timestamp, {
            toolCallId,
            toolName: step.tool_name ?? 'unknown',
            args: info?.parameters,
          }),
        );
      }
      const emitId = record?.toolCallId ?? this.state.turnTools[this.state.turnTools.length - 1].toolCallId;
      events.push(
        this.ev('tool_execution_end', timestamp, {
          toolCallId: emitId,
          result: output ?? (errorMessage ? `error: ${errorMessage}` : ''),
          isError,
        }),
      );
      return events;
    }

    // user_input / system_message / unknown / checkpoint / future types:
    // liveness tick only — never user-facing content.
    events.push(
      this.ev('stream_activity', timestamp, {
        stepIndex: step.step_index,
        stepType: step.step_type,
        state: step.state,
        ...(step.tool_name ? { toolName: step.tool_name } : {}),
      }),
    );
    return events;
  }

  private onResult(parsed: Extract<ParsedAgyLine, { kind: 'result' }>, timestamp: number): NormalizedEvent[] {
    this.noteConversationId(parsed.conversationId, 'result');
    const result = parsed.result;
    this._lastResult = result;

    const events: NormalizedEvent[] = [];
    if (this.state.assistantMessageOpen && this.assistantMessageId) {
      events.push(this.ev('message_end', timestamp, { id: this.assistantMessageId }));
      this.state.assistantMessageOpen = false;
      this.assistantMessageId = null;
    }

    const data: Record<string, unknown> = {
      result: null,
      usage: mapAgyUsage(result.usage),
      agyStatus: result.status,
      numTurns: result.num_turns,
      durationSeconds: result.duration_seconds,
    };
    if (result.error) data.error = result.error;
    if (result.status === 'WAITING') data.waiting = true;
    events.push(this.ev('agent_end', timestamp, data));

    // Turn boundary (T1.6): snapshot for the service, then reset per-turn
    // accumulation; ids for the next turn are generated fresh on its first delta.
    this._lastTurn = { text: this.state.turnText, tools: [...this.state.turnTools], result };
    this.state.turnText = '';
    this.state.turnTools = [];
    return events;
  }
}

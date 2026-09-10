import { randomUUID } from 'node:crypto';
import type { NormalizedEvent, ChildCardProjection } from '@pi-web-ui/shared';
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
  /** When true the result event does NOT emit message_end/agent_end: the
   *  caller (AntigravityService) emits terminal events itself after durable
   *  persistence, preserving the legacy ordering invariant. */
  suppressTerminalEvents?: boolean;
  /** Background-task children to seed tracking with (respawn parity: the
   *  service re-seeds a fresh normalizer from its durable per-session meta so
   *  a process respawn does not forget still-running tasks). */
  initialBackgroundChildren?: ChildCardProjection[];
}

export interface AgyNormalizerState {
  conversationId: string | null;
  initModel: string | null;
  permissionMode: string | null;
  /** True while an assistant message_start has no matching message_end. */
  assistantMessageOpen: boolean;
  /** Id of the open (or most recently closed) assistant message. */
  assistantMessageId: string | null;
  /** Concatenated text_delta content for the current turn. */
  turnText: string;
  /** Tool calls recorded during the current turn. */
  turnTools: AgyToolCallRecord[];
}

/** Internal per-task record: the wire-safe projection plus the server-only
 *  completion-watch hint (never serialized onto the wire). */
export interface AgyBackgroundTaskRecord {
  projection: ChildCardProjection;
  /** Directory whose message JSONs carry the task's completion receipt
 *  (derived from the "Task logs are available at:" line). */
  watchDir?: string;
}

// ── Background task content patterns (live wire, 2026-09-10) ─────────────────

/** agy demotes a long run_command: "Tool is running as a background task with task id: <conv>/task-N". */
const BG_START_PATTERN = /Tool is running as a background task with task id:\s*(\S+)/;
/** Human-readable command line: "Task Description: <command>". */
const BG_DESCRIPTION_PATTERN = /Task Description:\s*([^\n]+)/;
/** Where the task's own stdout lands; sibling `messages/` dir gets the receipt. */
const BG_LOGS_PATTERN = /Task logs are available at:\s*(\S+)/;
/** agy's high-priority wake message when the task exits. */
const BG_COMPLETE_PATTERN = /Task id "([^"]+)" finished with result/;
/** Exit code line inside the completion receipt. */
const BG_EXIT_CODE_PATTERN = /The command exited with code (\d+)/;

/** Convert the file:// task-log URL into the sibling messages directory that
 *  receives the completion receipt JSON. Returns undefined when absent/foreign. */
export function taskLogUrlToMessagesDir(logUrl: string): string | undefined {
  if (!logUrl.startsWith('file://')) return undefined;
  const logPath = logUrl.slice('file://'.length);
  const idx = logPath.lastIndexOf('/.system_generated/tasks/');
  if (idx < 0) return undefined;
  return `${logPath.slice(0, idx)}/.system_generated/messages`;
}

/** Extract the background-task-relevant text of a step from every carrier the
 *  wire has shown (passthrough `content`, `text_delta`, `tool_info.output`). */
function stepContentProbe(step: AgyStepUpdate): string {
  const parts: string[] = [];
  if (typeof step.text_delta === 'string') parts.push(step.text_delta);
  const content = (step as unknown as Record<string, unknown>).content;
  if (typeof content === 'string') parts.push(content);
  if (typeof step.tool_info?.output === 'string') parts.push(step.tool_info.output);
  return parts.join('\n');
}

/** Max label length for a background child (matches MAX_TASK_CHARS spirit). */
const BG_LABEL_MAX = 200;

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

/** Write-family tools whose agy DONE step reports EMPTY output: synthesize a
 *  friendly result from the args so the card (and the stored record) says what
 *  happened instead of nothing. Maps tool name → the arg key holding the path. */
const WRITE_FAMILY_RESULT_ARG: Record<string, string> = {
  write_to_file: 'TargetFile',
};

/** Resolve the user-facing result text for a completed tool call. Real output
 *  wins; empty write-family output becomes "Wrote <path>"; errors surface the
 *  message. Stored in the turn record too, so replay matches live exactly. */
export function resolveToolResultText(
  toolName: string,
  args: unknown,
  output: string | undefined,
  isError: boolean,
  errorMessage: string | undefined,
): string {
  if (isError) return output ?? (errorMessage ? `error: ${errorMessage}` : '');
  if (output !== undefined && output.length > 0) return output;
  const pathKey = WRITE_FAMILY_RESULT_ARG[toolName];
  if (pathKey && args && typeof args === 'object') {
    const value = (args as Record<string, unknown>)[pathKey];
    if (typeof value === 'string' && value.length > 0) return `Wrote ${value}`;
  }
  return '';
}

export class AgyEventNormalizer {
  private readonly sessionId: string;
  private readonly expectedConversationId: string | null;
  private readonly onConversationIdMismatch?: AgyNormalizerOptions['onConversationIdMismatch'];

  private assistantMessageId: string | null = null;
  private _lastResult: AgyEnvelope | null = null;
  private _lastTurn: { text: string; tools: AgyToolCallRecord[]; result: AgyEnvelope } | null = null;

  /** Background-task children tracked across turns (NOT reset on result).
   *  Insertion-ordered: oldest task first. */
  private readonly backgroundTasks = new Map<string, AgyBackgroundTaskRecord>();

  readonly state: AgyNormalizerState = {
    conversationId: null,
    initModel: null,
    permissionMode: null,
    assistantMessageOpen: false,
    assistantMessageId: null,
    turnText: '',
    turnTools: [],
  };
  private readonly suppressTerminalEvents: boolean;

  constructor(options: AgyNormalizerOptions) {
    this.sessionId = options.sessionId;
    this.expectedConversationId = options.expectedConversationId ?? null;
    this.onConversationIdMismatch = options.onConversationIdMismatch;
    this.suppressTerminalEvents = options.suppressTerminalEvents ?? false;
    for (const child of options.initialBackgroundChildren ?? []) {
      if (child && typeof child.id === 'string') {
        this.backgroundTasks.set(child.id, { projection: { ...child } });
      }
    }
  }

  /** Terminal envelope of the most recent completed turn (null before one). */
  get lastResult(): AgyEnvelope | null {
    return this._lastResult;
  }

  /** Snapshot of the most recent completed turn (captured before reset). */
  get lastTurn(): { text: string; tools: AgyToolCallRecord[]; result: AgyEnvelope } | null {
    return this._lastTurn;
  }

  /** Wire-safe projections of every tracked background task (running AND
   *  completed — the strip filters, the store keeps the latest list). */
  getBackgroundChildren(): ChildCardProjection[] {
    return [...this.backgroundTasks.values()].map((r) => ({ ...r.projection }));
  }

  /** Server-only completion-watch hints (taskId → messages directory). */
  getBackgroundTaskWatchDirs(): Map<string, string | undefined> {
    return new Map([...this.backgroundTasks.entries()].map(([id, r]) => [id, r.watchDir]));
  }

  /** Watch-dir for one task (undefined when unknown). */
  getBackgroundTaskWatchDir(taskId: string): string | undefined {
    return this.backgroundTasks.get(taskId)?.watchDir;
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

    // Background-task surfacing (plan Phase 1): probe every step's content
    // carriers before type-specific handling. Emits background_child_state on
    // transitions only; never user-facing message content.
    events.push(...this.detectBackgroundTaskTransitions(step, timestamp));

    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
        if (!this.state.assistantMessageOpen) {
          this.assistantMessageId = randomUUID();
          this.state.assistantMessageId = this.assistantMessageId;
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
      const isError = info?.error !== undefined;
      const errorMessage = info?.error?.message;
      // Live/replay parity (F3): the ACTIVE step carries no parameters, so the
      // start event goes out without args — re-surface them on the end event so
      // the live card shows what replay shows.
      const args = info?.parameters;
      const resultText = resolveToolResultText(step.tool_name ?? 'unknown', args, info?.output, isError, errorMessage);
      if (record) {
        record.args = args;
        record.output = resultText;
        record.isError = isError;
        record.errorMessage = errorMessage;
      } else {
        // DONE without a seen ACTIVE (stream tail loss) — record outright.
        const toolCallId = randomUUID();
        this.state.turnTools.push({
          toolCallId,
          toolName: step.tool_name ?? 'unknown',
          args,
          output: resultText,
          isError,
          errorMessage,
        });
        events.push(
          this.ev('tool_execution_start', timestamp, {
            toolCallId,
            toolName: step.tool_name ?? 'unknown',
            args,
          }),
        );
      }
      const emitId = record?.toolCallId ?? this.state.turnTools[this.state.turnTools.length - 1].toolCallId;
      events.push(
        this.ev('tool_execution_end', timestamp, {
          toolCallId: emitId,
          ...(args !== undefined ? { args } : {}),
          result: resultText,
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

  /** Detect background-task start/completion in a step's content and return
   *  the resulting `background_child_state` events (one per transition). */
  private detectBackgroundTaskTransitions(step: AgyStepUpdate, timestamp: number): NormalizedEvent[] {
    const content = stepContentProbe(step);
    if (!content) return [];

    const started = this.noteBackgroundTaskStart(content, timestamp);
    if (started) return [started];

    const completed = this.noteBackgroundTaskCompletion(content, timestamp);
    if (completed) return [completed];

    return [];
  }

  /** Record a newly announced background task; returns the event when NEW. */
  private noteBackgroundTaskStart(content: string, timestamp: number): NormalizedEvent | null {
    const match = BG_START_PATTERN.exec(content);
    if (!match) return null;
    const taskId = match[1];
    if (this.backgroundTasks.has(taskId)) return null; // re-delivery dedupe

    const description = BG_DESCRIPTION_PATTERN.exec(content)?.[1]?.trim();
    const label = (description && description.length > 0 ? description : taskId).slice(0, BG_LABEL_MAX);
    const watchDir = taskLogUrlToMessagesDir(BG_LOGS_PATTERN.exec(content)?.[1] ?? '');

    const projection: ChildCardProjection = {
      id: taskId,
      kind: 'antigravity_task',
      status: 'running',
      label,
      model: 'antigravity-task',
      task: description ?? taskId,
      startedAt: timestamp,
      parentSessionId: this.sessionId,
    };
    this.backgroundTasks.set(taskId, { projection, ...(watchDir ? { watchDir } : {}) });
    return this.ev('background_child_state', timestamp, {
      sessionId: this.sessionId,
      children: this.getBackgroundChildren(),
    });
  }

  /** Mark a task completed from its in-stream receipt; returns the event on
   *  transition. Unknown task ids are ignored (stale receipts). */
  private noteBackgroundTaskCompletion(content: string, timestamp: number): NormalizedEvent | null {
    const match = BG_COMPLETE_PATTERN.exec(content);
    if (!match) return null;
    if (!this.completeBackgroundTask(match[1], BG_EXIT_CODE_PATTERN.exec(content)?.[1], timestamp)) return null;
    return this.ev('background_child_state', timestamp, {
      sessionId: this.sessionId,
      children: this.getBackgroundChildren(),
    });
  }

  /** Transition one task to completed (idempotent). True when it changed.
   *  Used by the in-stream receipt path AND the service's file watcher. */
  completeBackgroundTask(taskId: string, exitCode: string | number | undefined, endedAt: number): boolean {
    const record = this.backgroundTasks.get(taskId);
    if (!record || record.projection.status !== 'running') return false;
    const code = exitCode === undefined ? undefined : Number(exitCode);
    record.projection = {
      ...record.projection,
      status: 'completed',
      ...(code !== undefined && Number.isFinite(code) ? { exitCode: code } : {}),
      endedAt,
    };
    return true;
  }

  private onResult(parsed: Extract<ParsedAgyLine, { kind: 'result' }>, timestamp: number): NormalizedEvent[] {
    this.noteConversationId(parsed.conversationId, 'result');
    const result = parsed.result;
    this._lastResult = result;

    const events: NormalizedEvent[] = [];
    if (this.suppressTerminalEvents) {
      // Caller owns terminal emission ordering AND the streamed-message close:
      // clearing assistantMessageOpen here made finalizeStreamSuccess/Error
      // believe nothing had streamed, so it re-emitted the full response under
      // a fresh id (live: final text delivered twice) and the streamed message
      // never closed. Leave the open-message bookkeeping untouched — the
      // service emits message_end for the streamed id and resets the flag.
      this._lastResult = result;
      this.noteConversationId(parsed.conversationId, 'result');
      this._lastTurn = { text: this.state.turnText, tools: [...this.state.turnTools], result };
      this.state.turnText = '';
      this.state.turnTools = [];
      return events;
    }
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

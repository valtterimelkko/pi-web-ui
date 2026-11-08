import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * Devin event adapter — ACP `session/update` payloads → NormalizedEvent
 * (brief design point 4). Shapes are live-validated from the probe
 * transcripts (/root/devin-trial/acp-*.jsonl); content in tests is synthetic.
 *
 * Mapping:
 * - `agent_message_chunk` → text_delta message_update (message_start opens the
 *   assistant message on the first chunk)
 * - `agent_thought_chunk` → thinking_delta message_update
 * - `tool_call` / `tool_call_update` → tool_execution_start / _end with the
 *   title as toolName, rawInput as args, output content text as result
 * - `usage_update` (inputTokens/outputTokens in _meta) → usage event
 * - `user_message_chunk` → replayed user bubble (session/load history)
 * - Unknown `sessionUpdate` kinds and `_cognition.ai/*` notifications are
 *   ignored safely (logged at debug by the client, never user-facing).
 *
 * closeTurn ALWAYS emits `agent_end` (also on cancel and error) — the
 * run-receipt terminal detection and the goal sweeper depend on it.
 */

export interface AcpContentBlock {
  type: string;
  text?: string;
  resource?: { text?: string; mimeType?: string };
}

export interface AcpSessionUpdate {
  params: {
    sessionId: string;
    update: {
      sessionUpdate: string;
      content?: AcpContentBlock;
      toolCallId?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      status?: string;
      contentList?: AcpContentBlock[];
      /** tool_call_update carries `content` (array) on the wire. */
      contentArr?: never;
      [key: string]: unknown;
    };
  };
}

export interface AcpUsage {
  input?: number;
  output?: number;
  cachedRead?: number;
  total?: number;
}

export interface CloseTurnInput {
  usage?: AcpUsage;
  stopReason?: string;
  cancelled?: boolean;
  error?: string;
}

export interface AdapterToolRecord {
  toolCallId: string;
  toolName: string;
  kind?: string;
  args?: unknown;
  output?: string;
  isError: boolean;
  status: string;
}

interface AdapterState {
  assistantMessageId: string | null;
  assistantMessageOpen: boolean;
  turnText: string;
  turnTools: Map<string, AdapterToolRecord>;
  /** Token usage from the latest usage_update during the turn. */
  streamedUsage: AcpUsage | undefined;
}

function contentBlocksToText(blocks: AcpContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block?.text === 'string') { parts.push(block.text); continue; }
    const resourceText = block?.resource?.text;
    if (typeof resourceText === 'string') { parts.push(resourceText); continue; }
    // The wire wraps tool content as { type: 'content', content: { type: 'text', … } }
    // (live-validated: exec output arrives wrapped; resource previews too).
    const inner = (block as { content?: AcpContentBlock } | undefined)?.content;
    if (typeof inner?.text === 'string') parts.push(inner.text);
    else if (typeof inner?.resource?.text === 'string') parts.push(inner.resource.text);
  }
  return parts.join('\n');
}

export interface AcpEventAdapterOptions {
  /** session/load replay mode: user_message_chunk chunks render as user
   *  bubbles; assistant chunks still stream into an assistant message. */
  replay?: boolean;
}

export class AcpEventAdapter {
  readonly sessionId: string;
  private readonly replay: boolean;
  readonly state: AdapterState;

  constructor(sessionId: string, options: AcpEventAdapterOptions = {}) {
    this.sessionId = sessionId;
    this.replay = options.replay ?? false;
    this.state = {
      assistantMessageId: null,
      assistantMessageOpen: false,
      turnText: '',
      turnTools: new Map(),
      streamedUsage: undefined,
    };
  }

  private ev(type: string, timestamp: number, data: Record<string, unknown>): NormalizedEvent {
    return { type, sessionId: this.sessionId, timestamp, data };
  }

  /** Feed one `session/update` notification; returns the normalized events. */
  onSessionUpdate(notification: AcpSessionUpdate, timestamp: number): NormalizedEvent[] {
    const update = notification.params?.update;
    if (!update || typeof update.sessionUpdate !== 'string') return [];
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.onChunk('text_delta', update.content, timestamp);
      case 'agent_thought_chunk':
        return this.onChunk('thinking_delta', update.content, timestamp);
      case 'user_message_chunk':
        return this.onUserChunk(update.content, timestamp);
      case 'tool_call':
        return this.onToolCall(update, timestamp);
      case 'tool_call_update':
        return this.onToolCallUpdate(update, timestamp);
      case 'usage_update': {
        const meta = (update._meta ?? {}) as Record<string, unknown>;
        const input = typeof meta['cognition.ai/inputTokens'] === 'number' ? meta['cognition.ai/inputTokens'] as number : undefined;
        const output = typeof meta['cognition.ai/outputTokens'] === 'number' ? meta['cognition.ai/outputTokens'] as number : undefined;
        if (input === undefined && output === undefined) return [];
        const usage: AcpUsage = { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
        this.state.streamedUsage = usage;
        return [this.ev('usage', timestamp, { usage })];
      }
      case 'session_info_update':
        return [this.ev('stream_activity', timestamp, { sessionUpdate: 'session_info_update', title: typeof update.title === 'string' ? update.title : undefined })];
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      default:
        // Unknown/uninteresting kinds: liveness only, never user-facing.
        return [this.ev('stream_activity', timestamp, { sessionUpdate: update.sessionUpdate })];
    }
  }

  /** Feed an agent→client notification that is not session/update
   *  (`_cognition.ai/output`, `_cognition.ai/turn_stats`, …). Never
   *  user-facing; returns [] so the caller can log at debug. */
  onNotification(_method: string, _params: unknown): NormalizedEvent[] {
    return [];
  }

  private onChunk(kind: 'text_delta' | 'thinking_delta', content: AcpContentBlock | undefined, timestamp: number): NormalizedEvent[] {
    const text = typeof content?.text === 'string' ? content.text : '';
    if (!text) return [];
    const events: NormalizedEvent[] = [];
    if (!this.state.assistantMessageOpen) {
      this.state.assistantMessageId = randomUUID();
      this.state.assistantMessageOpen = true;
      events.push(this.ev('message_start', timestamp, { id: this.state.assistantMessageId, role: 'assistant' }));
    }
    if (kind === 'text_delta') this.state.turnText += text;
    events.push(this.ev('message_update', timestamp, {
      id: this.state.assistantMessageId,
      assistantMessageEvent: { type: kind, delta: text },
    }));
    return events;
  }

  private onUserChunk(content: AcpContentBlock | undefined, timestamp: number): NormalizedEvent[] {
    const text = typeof content?.text === 'string' ? content.text : '';
    if (!text) return [];
    if (!this.replay) {
      // Live turns echo the user prompt through the service; a stray live
      // user chunk still surfaces (harmless, keeps replay/live parity).
    }
    const id = randomUUID();
    return [
      this.ev('message_start', timestamp, { id, role: 'user' }),
      this.ev('message_update', timestamp, { id, assistantMessageEvent: { type: 'text_delta', delta: text } }),
      this.ev('message_end', timestamp, { id }),
    ];
  }

  private onToolCall(update: AcpSessionUpdate['params']['update'], timestamp: number): NormalizedEvent[] {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : randomUUID();
    const toolName = typeof update.title === 'string' && update.title.length > 0 ? update.title : 'tool';
    const existing = this.state.turnTools.get(toolCallId);
    const record: AdapterToolRecord = {
      toolCallId,
      toolName,
      ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
      ...(update.rawInput !== undefined ? { args: update.rawInput } : (existing?.args !== undefined ? { args: existing.args } : {})),
      isError: false,
      status: typeof update.status === 'string' ? update.status : 'pending',
    };
    // tool_call may already carry output content (fast tools complete at once).
    const contentArr = (update.content ?? update.contentList) as AcpContentBlock[] | undefined;
    const outputText = contentBlocksToText(contentArr);
    if (outputText) record.output = outputText;
    this.state.turnTools.set(toolCallId, record);
    const events: NormalizedEvent[] = [
      this.ev('tool_execution_start', timestamp, {
        toolCallId,
        toolName: record.toolName,
        ...(record.args !== undefined ? { args: record.args } : {}),
      }),
    ];
    if (record.output !== undefined && record.status === 'completed') {
      events.push(this.ev('tool_execution_end', timestamp, {
        toolCallId,
        ...(record.args !== undefined ? { args: record.args } : {}),
        result: record.output,
        isError: false,
      }));
    }
    return events;
  }

  private onToolCallUpdate(update: AcpSessionUpdate['params']['update'], timestamp: number): NormalizedEvent[] {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
    if (!toolCallId) return [];
    const events: NormalizedEvent[] = [];
    let record = this.state.turnTools.get(toolCallId);
    if (!record) {
      // tool_call_update without a seen tool_call (stream tail loss) — record outright.
      record = {
        toolCallId,
        toolName: typeof update.title === 'string' && update.title.length > 0 ? update.title : 'tool',
        isError: false,
        status: typeof update.status === 'string' ? update.status : 'in_progress',
      };
      this.state.turnTools.set(toolCallId, record);
      events.push(this.ev('tool_execution_start', timestamp, { toolCallId, toolName: record.toolName }));
    }
    if (typeof update.title === 'string' && update.title.length > 0) record.toolName = update.title;
    if (typeof update.status === 'string') record.status = update.status;
    const contentArr = (update.content ?? update.contentList) as AcpContentBlock[] | undefined;
    const outputText = contentBlocksToText(contentArr);
    if (outputText) record.output = outputText;
    if (record.status === 'completed' || record.status === 'failed') {
      const isError = record.status === 'failed';
      record.isError = isError;
      events.push(this.ev('tool_execution_end', timestamp, {
        toolCallId,
        ...(record.args !== undefined ? { args: record.args } : {}),
        result: record.output ?? '',
        isError,
      }));
    } else {
      // in_progress with partial content: keep the card alive (tool_execution_update).
      events.push(this.ev('tool_execution_update', timestamp, {
        toolCallId,
        ...(outputText ? { partialResult: outputText } : {}),
      }));
    }
    return events;
  }

  /** Streamed usage observed during the turn (usage_update). */
  get streamedUsage(): AcpUsage | undefined {
    return this.state.streamedUsage;
  }

  get turnText(): string {
    return this.state.turnText;
  }

  get tools(): AdapterToolRecord[] {
    return [...this.state.turnTools.values()];
  }

  /**
   * Close the turn: always message_end for an open assistant message (or an
   * error-body message when nothing streamed), then ALWAYS `agent_end` with
   * the mapped usage — including on cancel and error (brief design point 4).
   */
  closeTurn(input: CloseTurnInput, timestamp: number): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const usage: AcpUsage = {
      input: input.usage?.input ?? this.state.streamedUsage?.input ?? 0,
      output: input.usage?.output ?? this.state.streamedUsage?.output ?? 0,
      ...(input.usage?.cachedRead !== undefined ? { cachedRead: input.usage.cachedRead } : {}),
      ...(input.usage?.total !== undefined ? { total: input.usage.total } : {}),
    };

    if (this.state.assistantMessageOpen && this.state.assistantMessageId) {
      events.push(this.ev('message_end', timestamp, { id: this.state.assistantMessageId }));
      this.state.assistantMessageOpen = false;
    } else if (input.error || input.cancelled) {
      // Failures are never blank (RC2 parity): an error-body assistant bubble.
      const body = input.error
        ? `The Devin turn failed (${input.error}).`
        : 'The Devin turn was cancelled.';
      const id = randomUUID();
      events.push(
        this.ev('message_start', timestamp, { id, role: 'assistant' }),
        this.ev('message_update', timestamp, { id, assistantMessageEvent: { type: 'text_delta', delta: body } }),
        this.ev('message_end', timestamp, { id }),
      );
    }

    const data: Record<string, unknown> = { result: input.cancelled ? null : (this.state.turnText || null), usage };
    if (input.cancelled) data.cancelled = true;
    if (input.stopReason) data.stopReason = input.stopReason;
    if (input.error) data.error = input.error;
    events.push(this.ev('agent_end', timestamp, data));
    return events;
  }
}

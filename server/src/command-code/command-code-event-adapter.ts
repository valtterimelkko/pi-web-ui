import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { CommandCodeEffort } from './command-code-model-catalog.js';
import type { CommandCodeResultFrame, ParsedCommandCodeEvent } from './command-code-ndjson-parser.js';

export const COMMAND_CODE_AGENT_END = 'agent_end' as const;
export const COMMAND_CODE_TOKEN_USAGE_SOURCE = 'commandcode-terminal-result-v1' as const;

export interface CommandCodeTerminalTokenUsage {
  scope: 'run';
  source: typeof COMMAND_CODE_TOKEN_USAGE_SOURCE;
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CommandCodeAdaptInput {
  sessionId: string;
  nativeSessionId?: string;
  events: ParsedCommandCodeEvent[];
  terminal: CommandCodeResultFrame;
  unknownEventTypes: string[];
  suppressedDuplicateCount: number;
  bytes: number;
  lineCount: number;
  observedAt?: number;
}

export interface CommandCodeAdaptedOutput {
  events: NormalizedEvent[];
  finalText: string;
  nativeSessionId?: string;
  terminal: CommandCodeResultFrame;
  tokenUsage?: CommandCodeTerminalTokenUsage;
  unknownEventTypes: string[];
  suppressedDuplicateCount: number;
  bytes: number;
  lineCount: number;
}

/** Mutable state used to normalize one accepted native event at a time. */
export interface CommandCodeIncrementalAdapterState {
  activeMessageId?: string;
  syntheticMessageNumber: number;
  sawAgentEnd: boolean;
  finalText: string;
}

export function createCommandCodeIncrementalAdapterState(): CommandCodeIncrementalAdapterState {
  return { syntheticMessageNumber: 0, sawAgentEnd: false, finalText: '' };
}

/** Normalize one event frame without waiting for the terminal result. */
export function adaptCommandCodeEvent(input: {
  sessionId: string;
  parsed: ParsedCommandCodeEvent;
  state: CommandCodeIncrementalAdapterState;
  observedAt?: number;
}): NormalizedEvent | undefined {
  const event = input.parsed.event;
  const type = typeof event.type === 'string' ? event.type : '';
  const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? event.timestamp
    : input.observedAt ?? Date.now();
  const nativeMessageId = eventMessageId(event);
  if (type === 'message_start') input.state.activeMessageId = nativeMessageId ?? `commandcode-message-${++input.state.syntheticMessageNumber}`;
  const normalized = normalizeEvent(input.sessionId, event, timestamp, input.state.activeMessageId);
  if (type === 'message_end') input.state.activeMessageId = undefined;
  if (!normalized) return undefined;
  if (normalized.type === 'message_update') {
    const data = asRecord(normalized.data);
    const assistant = asRecord(data?.assistantMessageEvent);
    if (assistant?.type === 'text_delta' && typeof assistant.delta === 'string') input.state.finalText += assistant.delta;
  }
  if (normalized.type === 'agent_end') input.state.sawAgentEnd = true;
  return normalized;
}

/** Convert public Command Code event names into Pi Web UI's normalized event model. */
export function adaptCommandCodeOutput(input: CommandCodeAdaptInput): CommandCodeAdaptedOutput {
  const timestampFallback = input.observedAt ?? Date.now();
  const events: NormalizedEvent[] = [];
  let finalText = '';
  let sawAgentEnd = false;
  let activeMessageId: string | undefined;
  let syntheticMessageNumber = 0;
  const tokenUsage = normalizeCommandCodeTerminalTokenUsage(input.terminal.usage);

  for (const parsed of input.events) {
    const event = parsed.event;
    const type = typeof event.type === 'string' ? event.type : '';
    const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? event.timestamp
      : timestampFallback;
    const nativeMessageId = eventMessageId(event);
    if (type === 'message_start') {
      activeMessageId = nativeMessageId ?? `commandcode-message-${++syntheticMessageNumber}`;
    }
    let normalized = normalizeEvent(input.sessionId, event, timestamp, activeMessageId);
    if (type === 'message_end') activeMessageId = undefined;
    if (!normalized) continue;
    if (normalized.type === 'agent_end') {
      const terminalEffort = nativeEffort(input.terminal.effort ?? input.terminal.effectiveEffort ?? input.terminal.reasoningEffort ?? input.terminal.usage?.reasoningEffort);
      const data = asRecord(normalized.data) ?? {};
      // The terminal result is the only authoritative Command Code usage
      // source. Remove any runtime-supplied usage-shaped field before adding
      // the validated terminal projection, so cumulative session snapshots or
      // native event payloads cannot become run-budget evidence.
      delete data.tokenUsage;
      if (terminalEffort && data.effort === undefined) {
        data.effort = terminalEffort;
      }
      if (tokenUsage) data.tokenUsage = tokenUsage;
      normalized = { ...normalized, data };
    }
    if (normalized.type === 'agent_end') {
      if (sawAgentEnd) continue;
      sawAgentEnd = true;
    }
    if (normalized.type === 'message_update') {
      const data = normalized.data as Record<string, unknown>;
      const assistant = data.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistant?.type === 'text_delta' && typeof assistant.delta === 'string') finalText += assistant.delta;
    }
    events.push(normalized);
  }

  const terminalText = typeof input.terminal.finalText === 'string' ? input.terminal.finalText : '';
  if (terminalText && !finalText) {
    events.push({
      type: 'message_update',
      sessionId: input.sessionId,
      timestamp: timestampFallback,
      data: {
        id: 'commandcode-final',
        assistantMessageEvent: { type: 'text_delta', delta: terminalText },
      },
    });
    finalText = terminalText;
  } else if (terminalText && finalText !== terminalText) {
    // The event stream may expose only a partial response. Preserve the
    // terminal final text as a suffix when it is an unambiguous continuation.
    if (terminalText.startsWith(finalText)) {
      const suffix = terminalText.slice(finalText.length);
      if (suffix) {
        events.push({
          type: 'message_update',
          sessionId: input.sessionId,
          timestamp: timestampFallback,
          data: { id: 'commandcode-final', assistantMessageEvent: { type: 'text_delta', delta: suffix } },
        });
        finalText += suffix;
      }
    }
  }

  if (!sawAgentEnd) {
    events.push({
      type: COMMAND_CODE_AGENT_END,
      sessionId: input.sessionId,
      timestamp: timestampFallback,
      data: terminalData(input.terminal, input.nativeSessionId),
    });
  }

  return {
    events,
    finalText: terminalText || finalText,
    nativeSessionId: input.terminal.sessionId ?? input.nativeSessionId,
    terminal: input.terminal,
    ...(tokenUsage ? { tokenUsage } : {}),
    unknownEventTypes: [...input.unknownEventTypes],
    suppressedDuplicateCount: input.suppressedDuplicateCount,
    bytes: input.bytes,
    lineCount: input.lineCount,
  };
}

/** Flatten the normalized journal shape into the replay shape consumed by the shared screen projection. */
export function commandCodeEventsToScreenEvents(events: NormalizedEvent[]): Array<Record<string, unknown>> {
  return events.map((event, index) => {
    const data = asRecord(event.data) ?? {};
    const id = stringValue(data.id) ?? `commandcode-message-${index}`;
    const base = { type: event.type, sessionId: event.sessionId, timestamp: event.timestamp };
    if (event.type === 'message_start') {
      return {
        ...base,
        message: {
          id,
          role: typeof data.role === 'string' ? data.role : 'assistant',
          ...(typeof data.content === 'string' ? { content: data.content } : {}),
        },
      };
    }
    if (event.type === 'message_update') {
      return {
        ...base,
        message: { id, role: 'assistant' },
        assistantMessageEvent: data.assistantMessageEvent,
      };
    }
    if (event.type === 'message_end') {
      return { ...base, message: { id } };
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      return { ...base, ...data };
    }
    return { ...base, ...data };
  });
}

function eventMessageId(event: Record<string, unknown>): string | undefined {
  const message = asRecord(event.message);
  return stringValue(event.messageId) ?? stringValue(message?.id) ?? stringValue(event.id);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeEvent(
  sessionId: string,
  event: Record<string, unknown>,
  timestamp: number,
  activeMessageId?: string,
): NormalizedEvent | undefined {
  const type = typeof event.type === 'string' ? event.type : '';
  const base = { sessionId, timestamp };
  const messageId = activeMessageId ?? eventMessageId(event) ?? 'commandcode-message';
  const message = asRecord(event.message);
  const text = typeof event.text === 'string'
    ? event.text
    : typeof event.delta === 'string'
      ? event.delta
      : typeof event.content === 'string'
        ? event.content
        : undefined;

  if (type === 'message_start') {
    return { ...base, type: 'message_start', data: { id: messageId, role: event.role ?? message?.role ?? 'assistant' } };
  }
  if (type === 'message_update' || type === 'text_delta' || type === 'assistant_text') {
    if (!text) return undefined;
    return {
      ...base,
      type: 'message_update',
      data: { id: messageId, assistantMessageEvent: { type: 'text_delta', delta: boundedText(text) } },
    };
  }
  if (type === 'thinking' || type === 'reasoning' || type === 'thinking_delta') {
    if (!text) return undefined;
    return {
      ...base,
      type: 'message_update',
      data: { id: messageId, assistantMessageEvent: { type: 'thinking_delta', delta: boundedText(text) } },
    };
  }
  if (type === 'message_end') return { ...base, type: 'message_end', data: { id: messageId } };
  if (type === 'tool_start' || type === 'tool_execution_start') {
    return {
      ...base,
      type: 'tool_execution_start',
      data: {
        toolCallId: stringValue(event.toolCallId) ?? stringValue(event.id) ?? 'commandcode-tool',
        toolName: stringValue(event.toolName) ?? stringValue(event.name) ?? 'unknown',
        args: boundedValue(event.args ?? event.input ?? event.arguments),
      },
    };
  }
  if (type === 'tool_result' || type === 'tool_execution_end' || type === 'tool_end') {
    return {
      ...base,
      type: 'tool_execution_end',
      data: {
        toolCallId: stringValue(event.toolCallId) ?? stringValue(event.id) ?? 'commandcode-tool',
        result: boundedValue(event.result ?? event.output ?? event.content),
        isError: event.isError === true || event.error !== undefined,
      },
    };
  }
  if (type === 'usage') return { ...base, type: 'usage', data: boundedValue(event.usage ?? event) };
  if (type === 'model_request_start' || type === 'model_request_end') {
    const effort = nativeEffort(event.effort ?? event.effectiveEffort ?? event.reasoningEffort);
    return {
      ...base,
      type,
      data: {
        ...(stringValue(event.requestId) ? { requestId: event.requestId } : {}),
        ...(effort ? { effort } : {}),
      },
    };
  }
  if (type === 'error') return { ...base, type: 'error', data: { message: boundedText(stringValue(event.message) ?? 'Command Code runtime error') } };
  if (type === 'agent_end' || type === 'turn_end' || type === 'session_end' || type === 'run_end') {
    return { ...base, type: COMMAND_CODE_AGENT_END, data: boundedValue(event) };
  }
  // Unknown native events remain in parser diagnostics; don't invent a visible
  // UI event for an unrecognised payload.
  return undefined;
}

function terminalData(terminal: CommandCodeResultFrame, nativeSessionId?: string): Record<string, unknown> {
  const effort = nativeEffort(terminal.effort ?? terminal.effectiveEffort ?? terminal.reasoningEffort ?? terminal.usage?.reasoningEffort);
  const tokenUsage = normalizeCommandCodeTerminalTokenUsage(terminal.usage);
  return {
    result: terminal.finalText ?? null,
    subtype: terminal.subtype,
    stopReason: terminal.stopReason,
    usage: boundedValue(terminal.usage),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(effort ? { effort } : {}),
    nativeSessionId: terminal.sessionId ?? nativeSessionId,
  };
}

/**
 * Normalize the usage object on one Command Code terminal result. This helper
 * intentionally does not inspect `usage` events or session/context totals.
 */
export function normalizeCommandCodeTerminalTokenUsage(value: unknown): CommandCodeTerminalTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = readConsistentCount(usage, ['input', 'input_tokens', 'inputTokens', 'prompt_tokens']);
  const output = readConsistentCount(usage, ['output', 'output_tokens', 'outputTokens', 'completion_tokens']);
  if (input === undefined || output === undefined) return undefined;
  const total = input + output;
  if (!Number.isSafeInteger(total)) return undefined;
  const reportedTotal = readConsistentCount(usage, ['total', 'total_tokens', 'totalTokens']);
  if (reportedTotal !== undefined && reportedTotal !== total) return undefined;
  const cacheRead = readConsistentCount(usage, ['cacheRead', 'cacheReadTokens', 'cache_read_tokens']);
  const cacheWrite = readConsistentCount(usage, ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens']);
  return {
    scope: 'run',
    source: COMMAND_CODE_TOKEN_USAGE_SOURCE,
    input,
    output,
    total,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function readConsistentCount(record: Record<string, unknown>, keys: string[]): number | undefined {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (present.length === 0) return undefined;
  const values = present.map((key) => coerceCount(record[key]));
  if (values.some((value) => value === undefined)) return undefined;
  const first = values[0] as number;
  return values.every((value) => value === first) ? first : undefined;
}

/** Accept real CLI usage counts emitted as JSON numbers or decimal strings. */
function coerceCount(value: unknown): number | undefined {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nativeEffort(value: unknown): CommandCodeEffort | undefined {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
    ? value as CommandCodeEffort
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedText(value: string): string {
  return value.length > 20_000 ? `${value.slice(0, 20_000)}…` : value;
}

function boundedValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return boundedText(value);
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 50_000) return value;
    return `[truncated ${serialized.length} bytes]`;
  } catch {
    return '[unserializable]';
  }
}

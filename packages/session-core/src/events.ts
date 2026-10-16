/**
 * Runtime-neutral session events and their conversion to the "Pi-format"
 * events the session renderers fold into messages. Pure: no I/O, no Node or
 * DOM APIs. Moved from `shared/src/protocol-types.ts` (the two interfaces) and
 * `server/src/websocket/connection.ts` (`normEventToPiFormat`), which re-export
 * them unchanged.
 */

/**
 * Common event shape produced by all runtime adapters (Pi SDK, Claude Direct, OpenCode Direct)
 * before being converted to the frontend-compatible format in connection.ts.
 *
 * This is the normalization contract: every runtime must emit events in this shape.
 */
export interface NormalizedEvent {
  type: string;
  sessionId?: string;
  timestamp: number;
  data: unknown;
}

/** Wrapper sent over WebSocket to route a NormalizedEvent to the correct client session. */
export interface SessionEventEnvelope {
  type: 'session_event';
  sessionId: string;
  event: NormalizedEvent;
}

// ============================================================================
// NormalizedEvent → Pi-compatible format converter
// ============================================================================

/**
 * Convert a NormalizedEvent (from ClaudeEventNormalizer) to the Pi-compatible
 * event format expected by the frontend sessionStore.
 */
export function normEventToPiFormat(event: NormalizedEvent): Record<string, unknown> {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'message_start':
      // Pass user content through: without it, replayed Command Code user
      // bubbles rendered empty (live sessions only showed them thanks to the
      // composer's local echo).
      return {
        type: 'message_start',
        message: {
          id: data.id,
          role: data.role,
          ...(typeof data.content === 'string' ? { content: data.content } : {}),
        },
      };
    case 'message_update':
      return { type: 'message_update', message: { id: data.id }, assistantMessageEvent: data.assistantMessageEvent };
    case 'message_end':
      return { type: 'message_end', message: { id: data.id } };
    case 'tool_execution_start':
      return {
        type: 'tool_execution_start',
        toolCallId: data.toolCallId ?? data.id,
        toolName: data.toolName ?? data.name,
        args: data.args ?? data.input,
      };
    case 'tool_execution_end':
      // args: antigravity live parity — agy carries parameters only on the DONE
      // step, so the normalizer re-surfaces them here (additive, may be absent).
      return {
        type: 'tool_execution_end',
        toolCallId: data.toolCallId ?? data.id,
        result: data.result,
        isError: data.isError,
        ...((data.args ?? data.input) !== undefined ? { args: data.args ?? data.input } : {}),
      };
    case 'tool_execution_update':
      return { type: 'tool_execution_update', toolCallId: data.toolCallId ?? data.id, partialResult: data.partialResult };
    case 'agent_start':
      return { type: 'agent_start' };
    case 'agent_end':
      return { type: 'agent_end', result: (data as Record<string, unknown>).result, usage: (data as Record<string, unknown>).usage };
    case 'session_init':
      return { type: 'session_init', ...data };
    case 'rate_limit':
      return { type: 'rate_limit', ...data };
    default:
      return { type: event.type, ...data };
  }
}

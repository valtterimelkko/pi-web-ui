/**
 * Claude SDK Event Adapter
 *
 * Converts Claude Agent SDK `SDKMessage` events into Pi Web UI's
 * `NormalizedEvent` format, matching the same event types produced by
 * the legacy `ClaudeEventNormalizer` so the rest of the pipeline
 * (session store, WebSocket, Internal API) works unchanged.
 */

import type { NormalizedEvent } from '@pi-web-ui/shared';

// ─── Minimal SDK message type aliases (structural) ──────────────────────────
// We use structural types instead of importing SDK types directly to avoid
// coupling the adapter to exact SDK version internals.  If the SDK adds new
// fields, the adapter still works because it only reads what it needs.

interface SDKContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface SDKAssistantMessage {
  type: 'assistant';
  message: {
    id?: string;
    model?: string;
    content?: SDKContentBlock[];
    usage?: Record<string, number>;
  };
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
  error?: string;
}

interface SDKUserMessage {
  type: 'user';
  message: {
    role?: string;
    content?: string | SDKContentBlock[];
  };
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
  tool_use_result?: unknown;
}

interface SDKSystemMessage {
  type: 'system';
  subtype?: string;
  model?: string;
  session_id?: string;
  tools?: string[];
  cwd?: string;
  permissionMode?: string;
  apiKeySource?: string;
  uuid?: string;
}

interface SDKPartialAssistantMessage {
  type: 'stream_event';
  message?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
}

interface SDKResultMessage {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  usage?: Record<string, number>;
  model_usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  total_cost_usd?: number;
  session_id?: string;
  uuid?: string;
  duration_ms?: number;
  num_turns?: number;
  api_error_status?: number | null;
}

type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKResultMessage | { type: string; [k: string]: unknown };

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class ClaudeSdkEventAdapter {
  /**
   * Convert a single SDK message into 0 or more NormalizedEvents.
   *
   * The mapping mirrors ClaudeEventNormalizer so downstream consumers
   * (sessionStore, WebSocket, Internal API) see the same event types.
   */
  adapt(message: SDKMessage, sessionId: string): NormalizedEvent[] {
    const timestamp = Date.now();
    const type = message.type as string;

    switch (type) {
      case 'system':
        return this.adaptSystem(message as SDKSystemMessage, sessionId, timestamp);

      case 'assistant':
        return this.adaptAssistant(message as SDKAssistantMessage, sessionId, timestamp);

      case 'user':
        return this.adaptUser(message as SDKUserMessage, sessionId, timestamp);

      case 'stream_event':
        return this.adaptStreamEvent(message as SDKPartialAssistantMessage, sessionId, timestamp);

      case 'result':
        return this.adaptResult(message as SDKResultMessage, sessionId, timestamp);

      default:
        // Unknown message type — pass through as raw
        return [
          {
            type: 'claude_sdk_raw',
            sessionId,
            timestamp,
            data: message as Record<string, unknown>,
          },
        ];
    }
  }

  // ─── Private adaptors ──────────────────────────────────────────────────────

  private adaptSystem(
    msg: SDKSystemMessage,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    if (msg.subtype !== 'init') {
      return [
        {
          type: 'claude_sdk_raw',
          sessionId,
          timestamp,
          data: msg as unknown as Record<string, unknown>,
        },
      ];
    }

    return [
      {
        type: 'session_init',
        sessionId,
        timestamp,
        data: {
          tools: msg.tools,
          model: msg.model,
          sessionId: msg.session_id,
          cwd: msg.cwd,
          permissionMode: msg.permissionMode,
          apiKeySource: msg.apiKeySource,
        },
      },
    ];
  }

  private adaptAssistant(
    msg: SDKAssistantMessage,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    // Surface auth/billing errors immediately
    if (msg.error) {
      return [
        {
          type: 'error',
          sessionId,
          timestamp,
          data: {
            error: msg.error,
            message: `Claude SDK error: ${msg.error}`,
          },
        },
      ];
    }

    const content = msg.message?.content;
    if (!Array.isArray(content) || content.length === 0) return [];

    const events: NormalizedEvent[] = [];
    const messageId = msg.message?.id;

    for (const block of content) {
      const blockType = block.type;

      if (blockType === 'tool_use') {
        events.push({
          type: 'tool_execution_start',
          sessionId,
          timestamp,
          data: {
            toolCallId: block.id,
            toolName: block.name,
            args: block.input,
          },
        });
      } else if (blockType === 'text') {
        const text = block.text;
        if (text !== undefined && text !== '') {
          events.push(
            {
              type: 'message_start',
              sessionId,
              timestamp,
              data: { id: messageId, role: 'assistant' },
            },
            {
              type: 'message_update',
              sessionId,
              timestamp,
              data: {
                id: messageId,
                assistantMessageEvent: {
                  type: 'text_delta',
                  delta: text,
                },
              },
            },
            {
              type: 'message_end',
              sessionId,
              timestamp,
              data: { id: messageId },
            },
          );
        }
      }
    }

    return events;
  }

  private adaptUser(
    msg: SDKUserMessage,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];

    const events: NormalizedEvent[] = [];

    for (const block of content) {
      if (block.type === 'tool_result') {
        const rawContent = block.content;
        const textContent =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? (rawContent as Array<{ type?: string; text?: string }>)
                  .map((c) => c.text ?? '')
                  .join('')
              : String(rawContent ?? '');

        events.push({
          type: 'tool_execution_end',
          sessionId,
          timestamp,
          data: {
            toolCallId: block.tool_use_id,
            result: {
              content: [{ type: 'text', text: textContent }],
            },
            isError: block.is_error,
          },
        });
      }
    }

    return events;
  }

  /**
   * Handle streaming partial messages (when includePartialMessages: true).
   * These carry incremental text deltas.
   */
  private adaptStreamEvent(
    msg: SDKPartialAssistantMessage,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    // The SDK emits partial messages as raw stream events.
    // We only forward text deltas as message_update events.
    const text = msg.message;
    if (typeof text === 'string' && text) {
      return [
        {
          type: 'message_update',
          sessionId,
          timestamp,
          data: {
            assistantMessageEvent: {
              type: 'text_delta',
              delta: text,
            },
          },
        },
      ];
    }
    return [];
  }

  private adaptResult(
    msg: SDKResultMessage,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    // IMPORTANT: do not emit agent_end here.
    // The SDK query() generator finishing is the true completion signal.
    // Emitting agent_end too early lets the UI send another prompt while
    // the SDK is still cleaning up.
    return [
      {
        type: 'claude_result',
        sessionId,
        timestamp,
        data: {
          result: msg.result,
          isError: msg.is_error,
          usage: msg.usage,
          sessionId: msg.session_id,
          totalCostUsd: msg.total_cost_usd,
          modelUsage: msg.modelUsage ?? msg.model_usage,
          numTurns: msg.num_turns,
          durationMs: msg.duration_ms,
        },
      },
    ];
  }
}

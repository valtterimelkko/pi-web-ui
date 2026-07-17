/**
 * Claude Event Normalizer
 * Converts `claude -p --output-format stream-json --verbose` NDJSON output
 * to the internal NormalizedEvent format.
 */

import type { NormalizedEvent } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';

const logger = createLogger('ClaudeEventNormalizer');


export class ClaudeEventNormalizer {
  private readonly metrics: OperationalMetrics;

  constructor(options: { metrics?: OperationalMetrics } = {}) {
    this.metrics = options.metrics ?? getOperationalMetrics();
  }

  /**
   * Normalize a single raw NDJSON line from Claude CLI output.
   * Returns an array of NormalizedEvents (one line can produce multiple events).
   */
  normalize(rawLine: string, sessionId: string): NormalizedEvent[] {
    const line = rawLine.trim();
    if (!line) return [];

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.metrics.recordAdapterDrop('claude', 'invalid_json');
      return [];
    }

    const timestamp = Date.now();
    const type = parsed.type as string | undefined;

    switch (type) {
      case 'system':
        return this.normalizeSystem(parsed, sessionId, timestamp);

      case 'assistant':
        return this.normalizeAssistant(parsed, sessionId, timestamp);

      case 'user':
        return this.normalizeUser(parsed, sessionId, timestamp);

      case 'rate_limit_event':
        return this.normalizeRateLimit(parsed, sessionId, timestamp);

      case 'result':
        return this.normalizeResult(parsed, sessionId, timestamp);

      default:
        this.metrics.recordAdapterDrop('claude', `unknown:${type ?? 'missing'}`);
        // Preserve the existing raw compatibility event without logging payload data.
        return [
          {
            type: 'claude_raw',
            sessionId,
            timestamp,
            data: parsed,
          },
        ];
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private normalizeSystem(
    event: Record<string, unknown>,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    const subtype = event.subtype as string | undefined;
    if (subtype !== 'init') {
      // Other system subtypes → raw
      return [{ type: 'claude_raw', sessionId, timestamp, data: event }];
    }

    return [
      {
        type: 'session_init',
        sessionId,
        timestamp,
        data: {
          tools: event.tools,
          model: event.model,
          sessionId: event.session_id,
          cwd: event.cwd,
          permissionMode: event.permissionMode,
          apiKeySource: event.apiKeySource,
        },
      },
    ];
  }

  private normalizeAssistant(
    event: Record<string, unknown>,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) {
      this.metrics.recordAdapterDrop('claude', 'assistant_message_missing');
      return [];
    }

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content) || content.length === 0) {
      this.metrics.recordAdapterDrop('claude', 'assistant_content_missing');
      return [];
    }

    const events: NormalizedEvent[] = [];
    const messageId = message.id as string | undefined;

    for (const block of content) {
      const blockType = block.type as string | undefined;

      if (blockType === 'tool_use') {
        events.push({
          type: 'tool_execution_start',
          sessionId,
          timestamp,
          data: {
            toolCallId: block.id as string,
            toolName: block.name as string,
            args: block.input,
          },
        });
      } else if (blockType === 'text') {
        const text = block.text as string | undefined;
        if (text !== undefined) {
          events.push(
            {
              type: 'message_start',
              sessionId,
              timestamp,
              data: {
                id: messageId,
                role: 'assistant',
              },
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
              data: {
                id: messageId,
              },
            },
          );
        }
      }
    }

    return events;
  }

  private normalizeUser(
    event: Record<string, unknown>,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return [];

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content) || content.length === 0) return [];

    const events: NormalizedEvent[] = [];

    for (const block of content) {
      if (block.type === 'tool_result') {
        const rawContent = block.content;
        // content can be a string or an array of content blocks
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
            toolCallId: block.tool_use_id as string,
            result: {
              content: [{ type: 'text', text: textContent }],
            },
            isError: block.is_error as boolean,
          },
        });
      }
    }

    return events;
  }

  private normalizeRateLimit(
    event: Record<string, unknown>,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    const info = event.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) return [];

    if (info.isUsingOverage === true) {
      logger.warn(
        '[ClaudeEventNormalizer] WARNING: Claude subscription overage in use! ' +
          `rateLimitType=${info.rateLimitType}, resetsAt=${info.resetsAt}`,
      );
    }

    return [
      {
        type: 'rate_limit',
        sessionId,
        timestamp,
        data: {
          status: info.status,
          rateLimitType: info.rateLimitType,
          isUsingOverage: info.isUsingOverage,
          resetsAt: info.resetsAt,
          overageResetsAt: info.overageResetsAt,
        },
      },
    ];
  }

  private normalizeResult(
    event: Record<string, unknown>,
    sessionId: string,
    timestamp: number,
  ): NormalizedEvent[] {
    // IMPORTANT: do not emit agent_end here.
    // Claude can emit a final result before the subprocess has fully exited,
    // and sending agent_end too early allows the UI to send another prompt
    // while Claude still holds the session lock.
    return [
      {
        type: 'claude_result',
        sessionId,
        timestamp,
        data: {
          result: event.result,
          isError: event.is_error,
          usage: event.usage,
          sessionId: event.session_id,
          totalCostUsd: event.total_cost_usd,
        },
      },
    ];
  }
}

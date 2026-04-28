/**
 * Event Filter for Internal API
 *
 * Transforms normalized agent events into verbosity-dependent output.
 *
 * Verbosity levels:
 * - `answers`: Collect only final assistant text, return single result.
 * - `tasks`: Stream tool status headlines + final answer.
 * - `full`: Pass through all events unchanged.
 */

import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { Verbosity, SSETaskStatusEvent } from './types.js';

// ─── Tool name → human-readable summary mapping ──────────────────────────────

/** Map tool names to human-readable present-continuous actions. */
function toolSummary(toolName: string, args: unknown): string {
  const a = args as Record<string, unknown> | undefined;
  switch (toolName) {
    case 'read':
    case 'Read': {
      const path = typeof a?.path === 'string' ? a.path : (typeof a?.file_path === 'string' ? a.file_path : 'file');
      const filename = path.split('/').pop() || path;
      return `Reading ${filename}…`;
    }
    case 'write':
    case 'Write': {
      const path = typeof a?.path === 'string' ? a.path : (typeof a?.file_path === 'string' ? a.file_path : 'file');
      const filename = path.split('/').pop() || path;
      return `Writing ${filename}…`;
    }
    case 'edit':
    case 'Edit': {
      const path = typeof a?.path === 'string' ? a.path : (typeof a?.file_path === 'string' ? a.file_path : 'file');
      const filename = path.split('/').pop() || path;
      return `Editing ${filename}…`;
    }
    case 'bash':
    case 'Bash': {
      const command = typeof a?.command === 'string' ? a.command : '';
      const preview = command.length > 40 ? command.slice(0, 40) + '…' : command;
      return preview ? `Running \`${preview}\`…` : 'Running command…';
    }
    case 'grep':
    case 'Grep':
    case 'glob':
    case 'Glob': {
      const pattern = typeof a?.pattern === 'string' ? a.pattern : '';
      return pattern ? `Searching for \`${pattern}\`…` : 'Searching files…';
    }
    case 'web_search':
    case 'WebSearch':
    case 'web_fetch':
    case 'WebFetch':
    case 'read_url':
    case 'ReadUrl':
      return 'Searching the web…';
    case 'subagent':
    case 'SubAgent':
    case 'task':
    case 'Task':
    case 'evaluated_subagent':
    case 'EvaluatedSubAgent': {
      const sub = typeof a?.agent === 'string' ? a.agent : (typeof a?.subagent_type === 'string' ? a.subagent_type : 'subagent');
      return `Delegating to ${sub}…`;
    }
    case 'memory':
    case 'Memory':
      return 'Saving to memory…';
    case 'todo':
    case 'Todo':
      return 'Updating tasks…';
    default:
      return `Running ${toolName}…`;
  }
}

// ─── Event Collector (for verbosity=answers) ─────────────────────────────────

export interface EventCollector {
  /** All text content collected from assistant messages (in order). */
  textParts: string[];
  /** Token usage from the final agent_end event. */
  usage?: {
    input: number;
    output: number;
    total: number;
  };
  /** Most recent message ID seen. */
  lastMessageId?: string;
  /** Whether the turn has completed. */
  complete: boolean;
  /** Any error that occurred. */
  error?: Error;
}

export function createEventCollector(): EventCollector {
  return { textParts: [], complete: false };
}

/**
 * Process a normalized event for verbosity=answers mode.
 * Collects assistant text content and token usage.
 */
export function collectAnswerEvent(collector: EventCollector, event: NormalizedEvent): void {
  const data = event.data as Record<string, unknown> | undefined;

  switch (event.type) {
    case 'message_update': {
      const msg = data?.assistantMessageEvent as Record<string, unknown> | undefined;
      const content = msg?.content as Array<{ type: string; text?: string; thinking?: string }> | undefined;
      if (content) {
        for (const block of content) {
          // Skip thinking blocks and tool blocks
          if (block.type === 'text' && block.text) {
            collector.textParts.push(block.text);
          }
        }
      }
      break;
    }
    case 'message_end': {
      if (data?.id) {
        collector.lastMessageId = data.id as string;
      }
      break;
    }
    case 'agent_end': {
      collector.complete = true;
      const usage = data?.usage as Record<string, number> | undefined;
      if (usage) {
        collector.usage = {
          input: usage.input_tokens ?? usage.input ?? 0,
          output: usage.output_tokens ?? usage.output ?? 0,
          total: (usage.input_tokens ?? usage.input ?? 0) + (usage.output_tokens ?? usage.output ?? 0),
        };
      }
      break;
    }
  }
}

// ─── SSE Stream Helpers ──────────────────────────────────────────────────────

/**
 * Callback type for streaming events to an SSE connection.
 */
export type SSEWriter = (eventType: string, data: unknown) => void;

/**
 * Process a normalized event for verbosity=tasks mode.
 * Emits task_status events for tool calls and forwards message/text content.
 */
export function writeTaskEvent(write: SSEWriter, event: NormalizedEvent): void {
  const data = event.data as Record<string, unknown> | undefined;

  switch (event.type) {
    case 'tool_execution_start': {
      const toolName = (data?.toolName as string) || 'tool';
      const args = data?.args;
      const summary = toolSummary(toolName, args);
      const taskEvent: SSETaskStatusEvent = {
        type: 'task_status',
        toolName,
        summary,
      };
      write('task_status', taskEvent);
      break;
    }
    case 'message_update': {
      const msg = data?.assistantMessageEvent as Record<string, unknown> | undefined;
      const content = msg?.content as Array<{ type: string; text?: string; thinking?: string }> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            write('message_update', {
              type: 'message_update',
              message: { id: data?.id },
              text: block.text,
            });
          }
          // Skip thinking blocks even in tasks mode
        }
      }
      break;
    }
    case 'message_start': {
      write('message_start', {
        type: 'message_start',
        message: { id: data?.id, role: data?.role },
      });
      break;
    }
    case 'message_end': {
      write('message_end', {
        type: 'message_end',
        message: { id: data?.id },
      });
      break;
    }
    case 'agent_start': {
      write('agent_start', { type: 'agent_start' });
      break;
    }
    case 'agent_end': {
      write('agent_end', {
        type: 'agent_end',
        usage: data?.usage ?? {},
      });
      break;
    }
    case 'error':
    case 'api_error': {
      write('error', {
        type: 'error',
        message: data?.message ?? data?.error ?? 'Unknown error',
      });
      break;
    }
    // All other events are silently dropped in tasks mode
  }
}

/**
 * Process a normalized event for verbosity=full mode.
 * Forwards everything unchanged.
 */
export function writeFullEvent(write: SSEWriter, event: NormalizedEvent): void {
  write(event.type, event);
}

/**
 * Claude History Replay
 * Converts stored JSONL entries to Pi-compatible session_event messages for replay.
 */

import type { ClaudeMessageEntry } from './claude-session-store.js';

/**
 * Convert a stored Claude message entry to Pi-compatible event objects
 * that can be sent as session_event messages to the frontend.
 */
export function claudeEntryToEvent(entry: ClaudeMessageEntry): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];

  switch (entry.type) {
    case 'meta':
      // Session init event
      events.push({
        type: 'session_init',
        model: entry.model,
        cwd: entry.cwd,
        claudeSessionId: entry.claudeSessionId,
        timestamp: entry.timestamp,
      });
      break;

    case 'user':
      // User message
      events.push({
        type: 'message_start',
        message: {
          id: `user_${entry.timestamp}`,
          role: 'user',
          content: entry.content || '',
        },
        timestamp: entry.timestamp,
      });
      events.push({ type: 'message_end', message: { id: `user_${entry.timestamp}` } });
      break;

    case 'assistant': {
      // Assistant message
      const msgId = `asst_${entry.timestamp}`;
      events.push({
        type: 'message_start',
        message: { id: msgId, role: 'assistant' },
        timestamp: entry.timestamp,
      });
      if (entry.content) {
        events.push({
          type: 'message_update',
          message: { id: msgId },
          assistantMessageEvent: { type: 'text_delta', delta: entry.content },
        });
      }
      events.push({ type: 'message_end', message: { id: msgId } });
      break;
    }

    case 'tool': {
      // Tool call + result
      const toolId = `tool_${entry.timestamp}`;
      events.push({
        type: 'tool_execution_start',
        toolCallId: toolId,
        toolName: entry.toolName || 'unknown',
        args: entry.toolInput || {},
        timestamp: entry.timestamp,
      });
      if (entry.toolOutput !== undefined) {
        events.push({
          type: 'tool_execution_end',
          toolCallId: toolId,
          result: { content: [{ type: 'text', text: entry.toolOutput }] },
          isError: false,
        });
      }
      break;
    }
  }

  return events;
}

/**
 * Convert full JSONL history to replay events.
 * Returns array of Pi-compatible event objects ready to be sent as session_event messages.
 */
export function historyToReplayEvents(entries: ClaudeMessageEntry[]): Array<Record<string, unknown>> {
  const allEvents: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    allEvents.push(...claudeEntryToEvent(entry));
  }
  return allEvents;
}

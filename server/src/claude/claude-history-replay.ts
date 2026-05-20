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

    case 'assistant':
      // Assistant message — handled by coalescing in historyToReplayEvents.
      // Individual assistant entries should not be emitted here because each
      // text delta would get its own message_start/message_end, fragmenting
      // the response into dozens of tiny bubbles.  Instead, historyToReplayEvents
      // merges consecutive assistant entries into a single message.
      break;

    case 'tool': {
      // Tool call start — use stored toolCallId if available
      const toolCallId = entry.toolCallId || `tool_${entry.timestamp}`;
      events.push({
        type: 'tool_execution_start',
        toolCallId,
        toolName: entry.toolName || 'unknown',
        args: entry.toolInput || {},
        timestamp: entry.timestamp,
      });
      // If the tool entry already has toolOutput (legacy entries), emit end immediately
      if (entry.toolOutput !== undefined) {
        events.push({
          type: 'tool_execution_end',
          toolCallId,
          result: { content: [{ type: 'text', text: entry.toolOutput }] },
          isError: entry.isError ?? false,
        });
      }
      break;
    }

    case 'tool_result': {
      // Tool result — emit tool_execution_end
      const resultToolCallId = entry.toolCallId || `tool_${entry.timestamp}`;
      events.push({
        type: 'tool_execution_end',
        toolCallId: resultToolCallId,
        result: { content: [{ type: 'text', text: entry.toolOutput || '' }] },
        isError: entry.isError ?? false,
      });
      break;
    }

    case 'error': {
      events.push({
        type: 'error',
        message: entry.content || 'Claude Direct error',
        code: entry.code,
        reauthRequired: entry.reauthRequired,
        timestamp: entry.timestamp,
      });
      break;
    }
  }

  return events;
}

/**
 * Convert full JSONL history to replay events.
 * Coalesces consecutive `assistant` entries (text deltas) into single messages
 * so the UI renders one coherent assistant response instead of many fragments.
 */
export function historyToReplayEvents(entries: ClaudeMessageEntry[]): Array<Record<string, unknown>> {
  const allEvents: Array<Record<string, unknown>> = [];
  let pendingTools: Array<{ toolCallId: string }> = [];

  const toolResultEvent = (
    toolCallId: string,
    text: string,
    isError: boolean,
    timestamp?: number,
  ): Record<string, unknown> => ({
    type: 'tool_execution_end',
    toolCallId,
    result: { content: [{ type: 'text', text }] },
    isError,
    ...(timestamp !== undefined ? { timestamp } : {}),
  });

  const closePendingTools = (text: string, isError = false, timestamp?: number) => {
    if (pendingTools.length === 0) return;
    for (const pending of pendingTools) {
      allEvents.push(toolResultEvent(pending.toolCallId, text, isError, timestamp));
    }
    pendingTools = [];
  };

  const isGeneratedFallbackToolCallId = (toolCallId: string | undefined): boolean => (
    !!toolCallId && /^tc_[^_]+_\d+$/.test(toolCallId)
  );

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];

    // Coalesce consecutive assistant entries into a single message. If a tool
    // is still open here, the turn has clearly moved past it, so close it with
    // an explicit replay-only placeholder instead of leaving a stale Running
    // card forever.
    if (entry.type === 'assistant') {
      closePendingTools('No result captured for this tool call. It may have been interrupted or the result was not persisted.', false, entry.timestamp);

      const coalescedText: string[] = [];
      const firstTimestamp = entry.timestamp;

      while (i < entries.length && entries[i].type === 'assistant') {
        if (entries[i].content) {
          coalescedText.push(entries[i].content!);
        }
        i++;
      }

      // Emit a single message with all accumulated text
      const msgId = `asst_${firstTimestamp}`;
      allEvents.push({
        type: 'message_start',
        message: { id: msgId, role: 'assistant' },
        timestamp: firstTimestamp,
      });
      if (coalescedText.length > 0) {
        allEvents.push({
          type: 'message_update',
          message: { id: msgId },
          assistantMessageEvent: { type: 'text_delta', delta: coalescedText.join('') },
        });
      }
      allEvents.push({ type: 'message_end', message: { id: msgId } });
      continue;
    }

    if (entry.type === 'tool') {
      const toolEvents = claudeEntryToEvent(entry);
      allEvents.push(...toolEvents);
      const toolCallId = entry.toolCallId || `tool_${entry.timestamp}`;
      if (entry.toolOutput === undefined) {
        pendingTools.push({ toolCallId });
      }
      i++;
      continue;
    }

    if (entry.type === 'tool_result') {
      const explicitToolCallId = entry.toolCallId;
      const matchingPendingIndex = explicitToolCallId
        ? pendingTools.findIndex((pending) => pending.toolCallId === explicitToolCallId)
        : -1;

      if (matchingPendingIndex >= 0 && explicitToolCallId) {
        allEvents.push(toolResultEvent(explicitToolCallId, entry.toolOutput || '', entry.isError ?? false, entry.timestamp));
        pendingTools.splice(matchingPendingIndex, 1);
      } else if (pendingTools.length > 0 && (!explicitToolCallId || isGeneratedFallbackToolCallId(explicitToolCallId))) {
        closePendingTools(entry.toolOutput || '', entry.isError ?? false, entry.timestamp);
      } else {
        allEvents.push(...claudeEntryToEvent(entry));
      }
      i++;
      continue;
    }

    if (entry.type === 'meta' && !entry.createdAt) {
      closePendingTools('No result captured for this tool call. It may have been interrupted or the result was not persisted.', false, entry.timestamp);
    }

    // Other non-assistant entries are handled individually
    allEvents.push(...claudeEntryToEvent(entry));
    i++;
  }

  return allEvents;
}

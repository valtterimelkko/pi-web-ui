/**
 * Message Type Adapter
 *
 * Dual-SDK note: Both the Pi SDK and the Claude Agent SDK emit session_event
 * messages in the same Pi-compatible format.  The only visible difference is
 * that Claude tool names are PascalCase ("Read", "Bash", "Agent") while Pi tool
 * names are lowercase/underscore ("read", "bash", "subagent").  Use
 * normalizeToolName() whenever you need to dispatch on a tool name.
 */

import type { LiveMessage } from '../hooks/useSessionStream.js';

/**
 * Normalize a tool name from Claude (PascalCase) to Pi format (lowercase/underscore).
 * Returns the original name unchanged if it is already in Pi format or unknown.
 *
 * Examples:
 *   normalizeToolName('Read')       // 'read'
 *   normalizeToolName('Bash')       // 'bash'
 *   normalizeToolName('Agent')      // 'subagent'
 *   normalizeToolName('subagent')   // 'subagent'  (pass-through)
 */
export function normalizeToolName(name: string): string {
  const map: Record<string, string> = {
    'Read': 'read',
    'Edit': 'edit',
    'Write': 'write',
    'Bash': 'bash',
    'Glob': 'find',
    'Grep': 'grep',
    'WebSearch': 'web_search',
    'WebFetch': 'web_fetch',
    'Agent': 'subagent',
    'Task': 'subagent',
    'TodoWrite': 'todo',
    'TodoRead': 'todo',
    'EnterPlanMode': 'enter_plan_mode',
    'ExitPlanMode': 'exit_plan_mode',
    'Skill': 'skill',
    'AskUserQuestion': 'ask_user',
  };
  return map[name] ?? name;
}

/**
 * Convert a session_event from the WebSocket into LiveMessage updates.
 * Returns:
 *  - An array of LiveMessage[] for complete messages (user messages)
 *  - An object { id, updates } for partial updates (streaming deltas)
 *  - null for non-message events (agent_start, agent_end, etc.)
 */
export function sessionEventToMessages(
  event: { type: string; [key: string]: unknown }
): LiveMessage[] | { id: string; updates: Partial<LiveMessage> } | null {
  switch (event.type) {
    case 'message_start': {
      const message = event.message as { id?: string; role?: string; content?: string } | undefined;
      if (!message) return null;
      const id = message.id || `msg-${Date.now()}`;
      if (message.role === 'user') {
        return [{
          id,
          role: 'user',
          content: typeof message.content === 'string' && message.content
            ? [{ type: 'text' as const, text: message.content }]
            : [],
          timestamp: Date.now(),
          isComplete: true,
        }];
      }
      // Assistant message start - return partial to track ID
      return { id, updates: { role: 'assistant', isComplete: false } };
    }
    case 'message_update': {
      const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (!assistantEvent) return null;
      // Return delta info - the caller (useSessionStream) will accumulate in refs
      const id = (event.message as { id?: string } | undefined)?.id || event.messageId as string | undefined;
      if (!id) return null;

      if (assistantEvent.type === 'text_delta') {
        return { id, updates: { content: [{ type: 'text', text: assistantEvent.delta || '' }] } };
      }
      if (assistantEvent.type === 'thinking_delta') {
        return { id, updates: { content: [{ type: 'thinking', thinking: assistantEvent.delta || '' }] } };
      }
      return null;
    }
    case 'message_end': {
      const id = (event.message as { id?: string } | undefined)?.id || event.messageId as string | undefined;
      if (!id) return null;
      return { id, updates: { isComplete: true } };
    }
    case 'tool_execution_start': {
      const toolCallId = event.toolCallId as string | undefined || event.id as string | undefined;
      const toolName = event.toolName as string | undefined || event.name as string | undefined;
      if (!toolCallId) return null;
      return [{
        id: `tool-${toolCallId}`,
        role: 'tool',
        content: [],
        timestamp: Date.now(),
        isComplete: false,
        toolCall: {
          id: toolCallId,
          name: normalizeToolName(toolName || 'unknown'),
          args: event.args,
        },
      }];
    }
    case 'tool_execution_end': {
      const toolCallId = event.toolCallId as string | undefined || event.id as string | undefined;
      if (!toolCallId) return null;
      return {
        id: `tool-${toolCallId}`,
        updates: {
          toolResult: {
            output: (event.result as string) || '',
            isError: event.isError === true,
          },
          isComplete: true,
        },
      };
    }
    default:
      return null;
  }
}

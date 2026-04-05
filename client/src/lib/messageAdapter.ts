/**
 * Message Type Adapter
 *
 * Converts between Message (sessionStore) and LiveMessage (useSessionStream) types.
 * This adapter handles the differences:
 * - Message.content can be string | ContentPart[]
 * - LiveMessage.content is always ContentPart[]
 * - Message.isComplete is optional
 * - LiveMessage.isComplete is required
 *
 * Dual-SDK note: Both the Pi SDK and the Claude Agent SDK emit session_event
 * messages in the same Pi-compatible format.  The only visible difference is
 * that Claude tool names are PascalCase ("Read", "Bash", "Agent") while Pi tool
 * names are lowercase/underscore ("read", "bash", "subagent").  Use
 * normalizeToolName() whenever you need to dispatch on a tool name.
 */

import type { Message } from '../store';
import type { LiveMessage, ContentPart } from '../hooks/useSessionStream.js';

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
 * Convert a Message from the store to a LiveMessage for display components
 */
export function messageToLiveMessage(msg: Message): LiveMessage {
  // Convert content to ContentPart[] if it's a string
  let content: ContentPart[];
  if (typeof msg.content === 'string') {
    content = msg.content ? [{ type: 'text', text: msg.content }] : [];
  } else {
    content = msg.content;
  }

  return {
    id: msg.id,
    role: msg.role,
    content,
    timestamp: msg.timestamp,
    isComplete: msg.isComplete ?? true, // Default to true for existing messages
    toolCall: msg.toolCall,
    toolResult: msg.toolResult,
  };
}

/**
 * Convert an array of Messages to LiveMessages
 */
export function messagesToLiveMessages(messages: Message[]): LiveMessage[] {
  return messages.map(messageToLiveMessage);
}

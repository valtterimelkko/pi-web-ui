/**
 * Message Type Adapter
 *
 * Converts between Message (sessionStore) and LiveMessage (useSessionStream) types.
 * This adapter handles the differences:
 * - Message.content can be string | ContentPart[]
 * - LiveMessage.content is always ContentPart[]
 * - Message.isComplete is optional
 * - LiveMessage.isComplete is required
 */

import type { Message } from '../store';
import type { LiveMessage, ContentPart } from '../hooks/useSessionStream.js';

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

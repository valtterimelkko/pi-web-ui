import type { ClientMessage, ServerMessage } from './protocol.js';

/**
 * Message handler function type for a specific message type.
 */
export type MessageHandler<T extends ClientMessage['type']> = (
  clientId: string,
  message: Extract<ClientMessage, { type: T }>
) => Promise<void>;

/**
 * Creates a message router with handlers for different message types.
 * 
 * @example
 * ```typescript
 * const router = createMessageRouter({
 *   prompt: async (clientId, message) => {
 *     // Handle prompt message
 *   },
 *   abort: async (clientId, message) => {
 *     // Handle abort message
 *   },
 * });
 * 
 * await router(clientId, incomingMessage);
 * ```
 */
export function createMessageRouter(
  handlers: Partial<{
    [K in ClientMessage['type']]: MessageHandler<K>;
  }>
) {
  return async (clientId: string, message: ClientMessage): Promise<void> => {
    const handler = handlers[message.type as ClientMessage['type']];
    if (handler) {
      await handler(clientId, message as never);
    }
  };
}

/**
 * Parse raw buffer data into a ClientMessage.
 * Returns null if parsing fails.
 */
export function parseMessage(data: Buffer): ClientMessage | null {
  try {
    const parsed = JSON.parse(data.toString());
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

/**
 * Serialize a ServerMessage to a JSON string for WebSocket transmission.
 */
export function serializeMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Validate that a message has the required fields for its type.
 * Returns an error message if invalid, or null if valid.
 */
export function validateMessage(message: ClientMessage): string | null {
  switch (message.type) {
    case 'auth':
      if (!message.csrfToken) return 'Missing csrfToken';
      break;

    case 'prompt':
      if (!message.message) return 'Missing message';
      if (typeof message.message !== 'string') return 'Message must be a string';
      break;

    case 'steer':
    case 'follow_up':
      if (!message.message) return 'Missing message';
      if (typeof message.message !== 'string') return 'Message must be a string';
      break;

    case 'new_session':
      if (message.cwd !== undefined && typeof message.cwd !== 'string') {
        return 'cwd must be a string';
      }
      break;

    case 'switch_session':
      if (!message.sessionPath) return 'Missing sessionPath';
      break;

    case 'get_session_tree':
      if (!message.sessionId) return 'Missing sessionId';
      break;

    case 'fork':
      if (!message.entryId) return 'Missing entryId';
      break;

    case 'navigate_tree':
      if (!message.entryId) return 'Missing entryId';
      break;

    case 'set_model':
      if (!message.modelId) return 'Missing modelId';
      break;

    case 'set_thinking_level': {
      const validLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
      if (!validLevels.includes(message.level)) {
        return `Invalid thinking level. Must be one of: ${validLevels.join(', ')}`;
      }
      break;
    }

    case 'extension_ui_response':
      if (!message.response?.id) return 'Missing response.id';
      break;
  }

  return null;
}

/**
 * Create an error response message.
 */
export function createErrorResponse(message: string, code?: string): ServerMessage {
  return {
    type: 'error',
    message,
    code,
  };
}

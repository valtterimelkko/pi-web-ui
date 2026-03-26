/**
 * Legacy Connection Adapter
 * Provides backward compatibility during transition to process-per-session architecture.
 */

import type { WebSocket } from 'ws';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';

/**
 * Type for WebSocket sender function
 */
export type WSSender = (message: unknown) => void;

export interface LegacyConnectionOptions {
  ws: WebSocket;
  clientId: string;
  sessionManager: MultiSessionManager;
  send: WSSender;
}

/**
 * Creates a legacy connection handler that wraps the existing MultiSessionManager.
 * This allows gradual migration to the new worker-based architecture.
 */
export function createLegacyConnection(options: LegacyConnectionOptions): {
  handleMessage: (data: unknown) => Promise<void>;
  close: () => void;
} {
  const { clientId, sessionManager } = options;
  const activeSessions: Set<string> = new Set();

  async function handleMessage(data: unknown): Promise<void> {
    if (typeof data !== 'object' || data === null) return;

    const message = data as Record<string, unknown>;
    
    // Handle legacy message format
    if (message.type === 'subscribe' && typeof message.sessionId === 'string') {
      activeSessions.add(message.sessionId);
      // Subscribe via session manager (async operation)
      try {
        await sessionManager.subscribeClient(clientId, message.sessionId);
      } catch (error) {
        console.error(`[LegacyConnection] Failed to subscribe to ${message.sessionId}:`, error);
      }
    }
    
    if (message.type === 'unsubscribe' && typeof message.sessionId === 'string') {
      activeSessions.delete(message.sessionId);
      sessionManager.unsubscribeClient(clientId, message.sessionId);
    }
    
    // Forward other messages to session manager
    if (message.type === 'prompt' || message.type === 'steer' || message.type === 'abort') {
      const sessionId = message.sessionId as string;
      if (sessionId) {
        await handleLegacyAction(clientId, sessionId, message, sessionManager);
      }
    }
  }

  function close(): void {
    // Unsubscribe from all active sessions
    for (const sessionId of activeSessions) {
      sessionManager.unsubscribeClient(clientId, sessionId);
    }
    activeSessions.clear();
  }

  return {
    handleMessage,
    close,
  };
}

/**
 * Handle legacy action messages (prompt, steer, abort)
 */
async function handleLegacyAction(
  clientId: string,
  sessionId: string,
  message: Record<string, unknown>,
  sessionManager: MultiSessionManager
): Promise<void> {
  try {
    switch (message.type) {
      case 'prompt': {
        const agentSession = sessionManager.getAgentSession(sessionId);
        if (!agentSession) {
          console.warn(`[LegacyConnection] Session not found for prompt: ${sessionId}`);
          return;
        }
        const promptMessage = message.message as string;
        const images = message.images as Array<{ type: 'image'; data: string; mimeType: string }> | undefined;
        if (promptMessage) {
          await agentSession.prompt(promptMessage, { images });
        }
        break;
      }
      case 'steer': {
        const steerMessage = message.message as string;
        if (steerMessage) {
          await sessionManager.steer(sessionId, steerMessage);
        }
        break;
      }
      case 'abort': {
        await sessionManager.abort(sessionId);
        break;
      }
    }
  } catch (error) {
    console.error(`[LegacyConnection] Error handling ${message.type}:`, error);
  }
}

/**
 * Check if a message should be handled by legacy handler.
 */
export function isLegacyMessage(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  
  // Legacy messages have sessionId at top level
  return typeof msg.sessionId === 'string';
}

import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { SessionPool } from './session-pool.js';

export type WebSocketSender = (clientId: string, message: unknown) => void;

export interface ForwardedEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export class EventForwarder {
  private wsSender: WebSocketSender;
  private sessionPool: SessionPool | null = null;
  private currentMessageId: string | null = null;

  constructor(wsSender: WebSocketSender) {
    this.wsSender = wsSender;
  }

  /**
   * Set the session pool reference for streaming state tracking
   */
  setSessionPool(pool: SessionPool): void {
    this.sessionPool = pool;
  }

  forwardEvent(clientId: string, event: AgentSessionEvent): void {
    // Track streaming state
    if (event.type === 'agent_start') {
      this.sessionPool?.setStreaming(clientId, true);
    } else if (event.type === 'agent_end') {
      this.sessionPool?.setStreaming(clientId, false);
    }

    // Map Pi SDK event to WebSocket message format
    const message = this.mapEventToMessage(event);
    this.wsSender(clientId, message);
  }

  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private mapEventToMessage(event: AgentSessionEvent): ForwardedEvent {
    // Base message structure
    const base = {
      timestamp: Date.now(),
    };

    switch (event.type) {
      case 'agent_start':
        return { ...base, type: 'agent_start' };

      case 'agent_end':
        return {
          ...base,
          type: 'agent_end',
          messages: event.messages,
        };

      case 'turn_start':
        return { ...base, type: 'turn_start' };

      case 'turn_end':
        return {
          ...base,
          type: 'turn_end',
          message: event.message,
          toolResults: event.toolResults,
        };

      case 'message_start': {
        // Generate a unique ID for this message stream
        this.currentMessageId = this.generateId();
        // Add ID to the message object
        const messageWithId = {
          ...event.message,
          id: this.currentMessageId,
        };
        return {
          ...base,
          type: 'message_start',
          message: messageWithId,
        };
      }

      case 'message_update':
        // Include the current message ID so client can correlate updates
        return {
          ...base,
          type: 'message_update',
          message: { id: this.currentMessageId },
          assistantMessageEvent: event.assistantMessageEvent,
        };

      case 'message_end': {
        // Include the current message ID and clear it
        const endMessageId = this.currentMessageId;
        this.currentMessageId = null;
        return {
          ...base,
          type: 'message_end',
          message: { id: endMessageId },
        };
      }

      case 'tool_execution_start':
        return {
          ...base,
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        };

      case 'tool_execution_update':
        return {
          ...base,
          type: 'tool_execution_update',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          partialResult: event.partialResult,
        };

      case 'tool_execution_end':
        return {
          ...base,
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        };

      case 'auto_compaction_start':
        return {
          ...base,
          type: 'auto_compaction_start',
          reason: event.reason,
        };

      case 'auto_compaction_end':
        return {
          ...base,
          type: 'auto_compaction_end',
          result: event.result,
          aborted: event.aborted,
          willRetry: event.willRetry,
          errorMessage: event.errorMessage,
        };

      case 'auto_retry_start':
        return {
          ...base,
          type: 'auto_retry_start',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        };

      case 'auto_retry_end':
        return {
          ...base,
          type: 'auto_retry_end',
          success: event.success,
          attempt: event.attempt,
          finalError: event.finalError,
        };

      default:
        // Forward unknown events as-is with timestamp
        return { ...base, type: 'unknown', ...event as Record<string, unknown> };
    }
  }

  createHandler(clientId: string): (event: AgentSessionEvent) => void {
    return (event: AgentSessionEvent) => {
      this.forwardEvent(clientId, event);
    };
  }
}

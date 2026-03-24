import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { SessionPool } from './session-pool.js';

export type WebSocketSender = (clientId: string, message: unknown) => void;

export interface ForwardedEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * Envelope for session-scoped event routing.
 * Wraps agent events with sessionId so the client can route them to the correct session.
 */
export interface SessionEvent {
  type: 'session_event';
  sessionId: string;
  event: ForwardedEvent;
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

  /**
   * Forward an agent event to the WebSocket client.
   * If sessionId is provided, the event is wrapped in a SessionEvent envelope
   * for multi-session routing on the client side.
   */
  forwardEvent(clientId: string, event: AgentSessionEvent, sessionId?: string): void {
    // Track streaming state
    if (event.type === 'agent_start') {
      this.sessionPool?.setStreaming(clientId, true);
    } else if (event.type === 'agent_end') {
      this.sessionPool?.setStreaming(clientId, false);
    }

    // Debug: Log all message_start events
    if (event.type === 'message_start') {
      const content = (event.message as {content?: Array<{type?: string; text?: string}>})?.content;
      const contentText = content?.map(c => c.text || '').join('') || '';
      console.log(`[EventForwarder] message_start event, content length: ${contentText.length}, preview: ${contentText.substring(0, 50)}...`);
      if (contentText.includes('skill') || contentText.includes('SKILL')) {
        console.log(`[EventForwarder] SKILL content detected in message_start, content preview: ${contentText.substring(0, 200)}`);
      }
    }

    // Map Pi SDK event to WebSocket message format
    const message = this.mapEventToMessage(event);

    // Skip filtered messages (e.g., skill content)
    if (message === null) {
      console.log(`[EventForwarder] Message filtered (null), event type: ${event.type}`);
      return;
    }

    // Wrap in session envelope if sessionId is provided (multi-session routing)
    const payload = sessionId
      ? { type: 'session_event' as const, sessionId, event: message }
      : message;

    this.wsSender(clientId, payload);
  }

  private generateId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Check if message content is raw skill content and extract info
  private getSkillContentInfo(message: unknown): { isSkillContent: boolean; skillName?: string } {
    if (typeof message !== 'object' || message === null) return { isSkillContent: false };
    
    const msg = message as { role?: string; content?: unknown };
    
    // Extract text content
    let contentText = '';
    if (Array.isArray(msg.content)) {
      contentText = msg.content
        .filter((c: { type?: string; text?: string }) => c.type === 'text')
        .map((c: { text?: string }) => c.text || '')
        .join('');
    }
    
    // Check for skill content injection markers - require BOTH opening AND closing tags
    const hasSkillOpenTag = contentText.includes('<skill name="');
    const hasSkillCloseTag = contentText.includes('</skill>');
    const hasFullSkillStructure = hasSkillOpenTag && hasSkillCloseTag;
    
    // Also check for lecture website builder header (actual skill content)
    const hasLectureHeader = contentText.includes('# Lecture Website Builder');
    
    if (hasFullSkillStructure || hasLectureHeader) {
      // Extract skill name
      const skillNameMatch = contentText.match(/<skill name="([^"]+)"/);
      const skillName = skillNameMatch ? skillNameMatch[1] : undefined;
      console.log(`[EventForwarder] Detected skill content: ${skillName || 'unknown'}`);
      return { isSkillContent: true, skillName };
    }
    
    return { isSkillContent: false };
  }

  // Transform skill content message to brief placeholder
  private transformSkillContent(message: unknown, skillName?: string): unknown {
    const placeholder = skillName 
      ? `📚 **Skill loaded: ${skillName}**`
      : '📚 **Skill loaded**';
    
    if (typeof message !== 'object' || message === null) return message;
    
    const msg = message as { content?: unknown; [key: string]: unknown };
    return {
      ...msg,
      content: [{ type: 'text', text: placeholder }]
    };
  }

  private mapEventToMessage(event: AgentSessionEvent): ForwardedEvent | null {
    // Base message structure
    const base = {
      timestamp: Date.now(),
    };

    // Transform skill content messages at the event level
    if (event.type === 'message_start') {
      const skillInfo = this.getSkillContentInfo(event.message);
      if (skillInfo.isSkillContent) {
        console.log(`[EventForwarder] Transforming skill content message: ${skillInfo.skillName || 'unknown'}`);
        const transformedMessage = this.transformSkillContent(event.message, skillInfo.skillName);
        return {
          ...base,
          type: 'message_start',
          message: transformedMessage,
        };
      }
    }

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

  /**
   * Create an event handler bound to a specific client.
   * Optionally accepts a sessionId for multi-session routing.
   */
  createHandler(clientId: string, sessionId?: string): (event: AgentSessionEvent) => void {
    return (event: AgentSessionEvent) => {
      this.forwardEvent(clientId, event, sessionId);
    };
  }
}

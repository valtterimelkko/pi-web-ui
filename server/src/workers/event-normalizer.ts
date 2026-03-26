/**
 * Event Normalizer
 * Converts RPC events to internal format for WebSocket clients.
 */

import type { RPCEvent } from './types.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

export class EventNormalizer {
  /**
   * Normalize an RPC event to internal format.
   */
  normalize(event: RPCEvent, sessionId?: string): NormalizedEvent {
    const base: NormalizedEvent = {
      type: event.type,
      sessionId,
      timestamp: Date.now(),
      data: event,
    };

    // Add type-specific normalization
    switch (event.type) {
      case 'message_start':
        return {
          ...base,
          data: {
            id: (event as any).id,
            role: (event as any).role,
          },
        };

      case 'message_update':
        return {
          ...base,
          data: {
            id: (event as any).id,
            delta: (event as any).delta,
          },
        };

      case 'message_end':
        return {
          ...base,
          data: {
            id: (event as any).id,
          },
        };

      case 'tool_execution_start':
        return {
          ...base,
          data: {
            id: (event as any).id,
            name: (event as any).name,
            input: (event as any).input,
          },
        };

      case 'tool_execution_update':
        return {
          ...base,
          data: {
            id: (event as any).id,
            delta: (event as any).delta,
          },
        };

      case 'tool_execution_end':
        return {
          ...base,
          data: {
            id: (event as any).id,
            result: (event as any).result,
            isError: (event as any).isError,
          },
        };

      case 'extension_ui_request':
        return {
          ...base,
          data: {
            id: (event as any).id,
            method: (event as any).method,
            ...(event as any),
          },
        };

      case 'session_compaction':
        return {
          ...base,
          data: {
            messageCount: (event as any).messageCount,
            removedCount: (event as any).removedCount,
          },
        };

      case 'error':
        return {
          ...base,
          data: {
            message: (event as any).message,
          },
        };

      default:
        return base;
    }
  }

  /**
   * Check if event should be filtered (skill content, etc).
   */
  shouldFilter(event: RPCEvent): boolean {
    // Filter out skill content injections
    if (event.type === 'message_start' || event.type === 'message_update') {
      const data = event as any;
      if (data.content && typeof data.content === 'string') {
        // Check for skill injection patterns
        if (data.content.includes('<skill name=') || 
            data.content.includes('SKILL.md') ||
            data.role === 'system') {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if event is an extension UI request.
   */
  isExtensionUIRequest(event: RPCEvent): boolean {
    return event.type === 'extension_ui_request';
  }

  /**
   * Check if event indicates streaming state.
   */
  isStreamingEvent(event: RPCEvent): boolean {
    return event.type === 'streaming_started' || event.type === 'streaming_ended';
  }

  /**
   * Check if event is an error.
   */
  isErrorEvent(event: RPCEvent): boolean {
    return event.type === 'error';
  }
}

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
    const pilotCorrelation = event.pilotCorrelation ? { pilotCorrelation: event.pilotCorrelation } : {};
    const base: NormalizedEvent = {
      type: event.type,
      sessionId,
      timestamp: Date.now(),
      data: event,
    };

    // Add type-specific normalization without dropping pilot epoch identity.
    switch (event.type) {
      case 'message_start':
        return { ...base, data: { id: event.id, role: event.role, ...pilotCorrelation } };
      case 'message_update':
        return { ...base, data: { id: event.id, delta: event.delta, ...pilotCorrelation } };
      case 'message_end':
        return { ...base, data: { id: event.id, ...pilotCorrelation } };
      case 'tool_execution_start':
        return { ...base, data: { id: event.id, name: event.name, input: event.input, ...pilotCorrelation } };
      case 'tool_execution_update':
        return { ...base, data: { id: event.id, delta: event.delta, ...pilotCorrelation } };
      case 'tool_execution_end':
        return { ...base, data: { id: event.id, result: event.result, isError: event.isError, ...pilotCorrelation } };
      case 'extension_ui_request':
        return { ...base, data: { ...event, ...pilotCorrelation } };
      case 'session_compaction':
        return { ...base, data: { messageCount: event.messageCount, removedCount: event.removedCount, ...pilotCorrelation } };
      case 'error':
        return { ...base, data: { message: event.message, ...pilotCorrelation } };
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

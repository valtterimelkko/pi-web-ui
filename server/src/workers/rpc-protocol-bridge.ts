/**
 * RPC Protocol Bridge
 * Translates between Pi SDK RPC protocol and internal formats.
 */

import type { RPCEvent, EventHandler } from './types.js';
import type { InternalCommand, NormalizedEvent } from '@pi-web-ui/shared';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('RPCProtocolBridge');


export class RPCProtocolBridge {
  private eventHandlers: Set<EventHandler> = new Set();

  /**
   * Parse a JSONL line from worker stdout.
   * Returns null for empty lines or parse errors.
   */
  parseRPCLine(line: string): RPCEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    
    try {
      return JSON.parse(trimmed) as RPCEvent;
    } catch {
      logger.error('[RPCProtocolBridge] Failed to parse line:', trimmed);
      return null;
    }
  }

  /**
   * Format an internal command as a JSONL line for worker stdin.
   */
  formatRPCCommand(command: InternalCommand, requestId = this.generateId()): string {
    // Map internal command to RPC command format. Callers that correlate
    // responses provide the request id; standalone callers still get one.
    const rpcCommand = {
      ...command,
      id: requestId,
    };
    return JSON.stringify(rpcCommand) + '\n';
  }

  /**
   * Normalize an RPC event to internal format.
   */
  normalizeEvent(rpcEvent: RPCEvent, sessionId?: string): NormalizedEvent {
    return {
      type: rpcEvent.type,
      sessionId,
      timestamp: Date.now(),
      data: rpcEvent,
    };
  }

  /**
   * Check if event is an extension UI request.
   */
  isExtensionUIRequest(event: RPCEvent): boolean {
    return event.type === 'extension_ui_request';
  }

  /**
   * Format extension UI response for worker stdin.
   */
  formatExtensionUIResponse(id: string, response: unknown): string {
    const rpcResponse = {
      type: 'extension_ui_response',
      id,
      ...(typeof response === 'string' 
        ? { value: response } 
        : response as object),
    };
    return JSON.stringify(rpcResponse) + '\n';
  }

  /**
   * Subscribe to parsed events.
   */
  subscribe(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Emit event to all subscribers.
   */
  private emit(event: RPCEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error('[RPCProtocolBridge] Handler error:', err);
      }
    }
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

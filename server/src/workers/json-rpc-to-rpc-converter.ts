/**
 * JSON-RPC to RPC Converter
 * Converts WebSocket JSON-RPC messages to RPC commands for Pi SDK workers.
 */

import type { InternalCommand } from '@pi-web-ui/shared';
import type { RpcCommand } from './types.js';

export interface JSONRPCMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export class JSONRPCToRPCConverter {
  /**
   * Convert a JSON-RPC message to an internal command.
   */
  convert(message: JSONRPCMessage): InternalCommand | null {
    const method = message.method;
    const params = message.params || {};

    switch (method) {
      case 'prompt':
        return {
          type: 'prompt',
          message: params.message as string,
          images: params.images as any[],
        };

      case 'steer':
        return {
          type: 'steer',
          message: params.message as string,
          images: params.images as any[],
        };

      case 'abort':
        return { type: 'abort' };

      case 'compact':
        return {
          type: 'compact',
          customInstructions: params.customInstructions as string,
        };

      case 'setModel':
        return {
          type: 'set_model',
          provider: params.provider as string,
          modelId: params.modelId as string,
        };

      case 'setThinkingLevel':
        return {
          type: 'set_thinking_level',
          level: params.level as any,
        };

      default:
        console.warn(`[JSONRPCToRPCConverter] Unknown method: ${method}`);
        return null;
    }
  }

  /**
   * Convert an internal command to an RPC command.
   */
  toRPCCommand(command: InternalCommand): RpcCommand {
    const id = this.generateId();
    
    switch (command.type) {
      case 'prompt':
        return { type: 'prompt', id, message: command.message, images: command.images };
      case 'steer':
        return { type: 'steer', id, message: command.message, images: command.images };
      case 'abort':
        return { type: 'abort', id };
      case 'compact':
        return { type: 'compact', id, customInstructions: command.customInstructions };
      case 'set_model':
        return { type: 'set_model', id, provider: command.provider, modelId: command.modelId };
      case 'set_thinking_level':
        return { type: 'set_thinking_level', id, level: command.level };
      default:
        throw new Error(`Unknown command type: ${(command as any).type}`);
    }
  }

  /**
   * Check if a message is a JSON-RPC request.
   */
  isJSONRPCRequest(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false;
    const msg = message as Record<string, unknown>;
    return typeof msg.method === 'string';
  }

  /**
   * Create a JSON-RPC response.
   */
  createResponse(id: string | number | undefined, result: unknown): JSONRPCMessage {
    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }

  /**
   * Create a JSON-RPC error response.
   */
  createError(id: string | number | undefined, code: number, message: string): JSONRPCMessage {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

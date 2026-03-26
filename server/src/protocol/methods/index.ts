/**
 * JSON-RPC Method Handlers
 * Exports all method handlers and the method registry
 */

// Export types
export type {
  MethodContext,
  MethodHandler,
  ServerCapabilities,
  ClientCapabilities,
  InitializeParams,
  InitializeResult,
  PromptParams,
  PromptResult,
  CancelParams,
  CancelResult,
  SteerParams,
  SteerResult,
  ReplayParams,
  ReplayResult,
  SetPlanModeParams,
  SetPlanModeResult,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from './types.js';

export {
  JsonRpcErrorCodes,
  createJsonRpcError,
  createJsonRpcResult,
} from './types.js';

// Export method handlers
export { initialize, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, DEFAULT_CAPABILITIES } from './initialize.js';
export { prompt } from './prompt.js';
export { cancel } from './cancel.js';
export { steer } from './steer.js';
export { replay } from './replay.js';
export { setPlanMode } from './setPlanMode.js';

// Import for registry
import type { MethodHandler, MethodContext, JsonRpcRequest, JsonRpcResponse } from './types.js';
import { JsonRpcErrorCodes, createJsonRpcError, createJsonRpcResult } from './types.js';
import { initialize } from './initialize.js';
import { prompt } from './prompt.js';
import { cancel } from './cancel.js';
import { steer } from './steer.js';
import { replay } from './replay.js';
import { setPlanMode } from './setPlanMode.js';

/**
 * Method handler map type
 * Uses any to allow heterogeneous handlers with different param/result types
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MethodHandlerMap = Map<string, MethodHandler<any, any>>;

/**
 * Registry of all JSON-RPC method handlers
 */
export const methodRegistry: MethodHandlerMap = new Map<string, MethodHandler<any, any>>([
  ['initialize', initialize],
  ['prompt', prompt],
  ['cancel', cancel],
  ['steer', steer],
  ['replay', replay],
  ['setPlanMode', setPlanMode],
]);

/**
 * Check if a method is registered
 */
export function hasMethod(method: string): boolean {
  return methodRegistry.has(method);
}

/**
 * Get a method handler by name
 */
export function getMethod(method: string): MethodHandler | undefined {
  return methodRegistry.get(method);
}

/**
 * Get all registered method names
 */
export function getMethodNames(): string[] {
  return Array.from(methodRegistry.keys());
}

/**
 * Dispatch a JSON-RPC request to the appropriate handler
 * 
 * @param request - The JSON-RPC request
 * @param context - The method execution context
 * @returns JSON-RPC response
 */
export async function dispatchMethod(
  request: JsonRpcRequest,
  context: MethodContext
): Promise<JsonRpcResponse> {
  const { method, params, id } = request;

  // Check if method exists
  const handler = methodRegistry.get(method);
  if (!handler) {
    return createJsonRpcError(
      id,
      JsonRpcErrorCodes.METHOD_NOT_FOUND,
      `Method not found: ${method}`
    );
  }

  try {
    // Execute the handler
    const result = await handler(params, context);
    return createJsonRpcResult(id, result);
  } catch (error) {
    // Handle errors
    const message = error instanceof Error ? error.message : 'Unknown error';
    
    // Determine error code based on error type
    let code: number = JsonRpcErrorCodes.INTERNAL_ERROR;
    
    if (message.includes('not found')) {
      code = JsonRpcErrorCodes.SESSION_NOT_FOUND;
    } else if (message.includes('Invalid') || message.includes('must be')) {
      code = JsonRpcErrorCodes.INVALID_PARAMS;
    }

    console.error(`[dispatchMethod] Error executing method ${method}:`, error);
    
    return createJsonRpcError(id, code, message);
  }
}

/**
 * Register a custom method handler
 * This allows extensions to add their own JSON-RPC methods
 */
export function registerMethod(method: string, handler: MethodHandler): void {
  if (methodRegistry.has(method)) {
    console.warn(`[registerMethod] Overwriting existing method: ${method}`);
  }
  methodRegistry.set(method, handler);
  console.log(`[registerMethod] Registered method: ${method}`);
}

/**
 * Unregister a method handler
 */
export function unregisterMethod(method: string): boolean {
  return methodRegistry.delete(method);
}

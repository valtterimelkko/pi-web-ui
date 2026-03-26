/**
 * JSON-RPC 2.0 Message Handler for Pi Web UI Server
 *
 * Provides message parsing, response creation, and request tracking
 * for JSON-RPC 2.0 protocol implementation.
 *
 * @see https://www.jsonrpc.org/specification
 */

import {
  type JSONRPCRequest,
  type JSONRPCResponse,
  type JSONRPCNotification,
  type JSONRPCError,
  JSONRPCErrorCode,
  createJSONRPCError,
  createSuccessResponse as sharedCreateSuccessResponse,
  createErrorResponse as sharedCreateErrorResponse,
  createNotification as sharedCreateNotification,
} from '@pi-web-ui/shared';

// ============================================================================
// JSON-RPC Error Constants
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error objects with code and message
 */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: { code: JSONRPCErrorCode.PARSE_ERROR, message: 'Parse error' },
  INVALID_REQUEST: { code: JSONRPCErrorCode.INVALID_REQUEST, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: JSONRPCErrorCode.METHOD_NOT_FOUND, message: 'Method not found' },
  INVALID_PARAMS: { code: JSONRPCErrorCode.INVALID_PARAMS, message: 'Invalid params' },
  INTERNAL_ERROR: { code: JSONRPCErrorCode.INTERNAL_ERROR, message: 'Internal error' },
} as const;

// ============================================================================
// Message Parsing
// ============================================================================

/**
 * Parse raw string data into a JSON-RPC request or notification
 *
 * @param data - Raw string data (typically from WebSocket message)
 * @returns Parsed JSON-RPC message or null if invalid
 */
export function parseMessage(data: string): JSONRPCRequest | JSONRPCNotification | null {
  // Try to parse JSON first
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  // Check if parsed is an object
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Check jsonrpc version first
  if (obj.jsonrpc !== '2.0') {
    return null;
  }

  // Check method is present and valid
  if (typeof obj.method !== 'string' || obj.method.length === 0) {
    return null;
  }

  // Check if id is present
  if ('id' in obj) {
    // Has id - should be a request
    if (obj.id === null || (typeof obj.id !== 'string' && typeof obj.id !== 'number')) {
      // Invalid id value
      return null;
    }
    // Valid request
    return {
      jsonrpc: '2.0',
      id: obj.id,
      method: obj.method,
      ...(obj.params !== undefined && { params: obj.params }),
    } as JSONRPCRequest;
  }

  // No id - should be a notification
  return {
    jsonrpc: '2.0',
    method: obj.method,
    ...(obj.params !== undefined && { params: obj.params }),
  } as JSONRPCNotification;
}

/**
 * Parse raw string data into a JSON-RPC response
 *
 * @param data - Raw string data (typically from WebSocket message)
 * @returns Parsed JSON-RPC response or null if invalid
 */
export function parseResponse(data: string): JSONRPCResponse | null {
  // Try to parse JSON first
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  // Check if parsed is an object
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Check jsonrpc version
  if (obj.jsonrpc !== '2.0') {
    return null;
  }

  // Check id is valid
  if (obj.id === null || (typeof obj.id !== 'string' && typeof obj.id !== 'number')) {
    return null;
  }

  // Response must have either result or error, not both
  const hasResult = 'result' in obj;
  const hasError = 'error' in obj;

  if (!hasResult && !hasError) {
    return null;
  }

  if (hasResult && hasError) {
    return null;
  }

  // Validate error object if present
  if (hasError) {
    const error = obj.error;
    if (typeof error !== 'object' || error === null) {
      return null;
    }
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.code !== 'number' || typeof errObj.message !== 'string') {
      return null;
    }
  }

  return {
    jsonrpc: '2.0',
    id: obj.id,
    ...(hasResult && { result: obj.result }),
    ...(hasError && { error: obj.error }),
  } as JSONRPCResponse;
}

// ============================================================================
// Request ID Generation
// ============================================================================

let requestCounter = 0;

/**
 * Generate a unique request ID
 *
 * Uses a combination of timestamp and counter to ensure uniqueness
 * across process restarts and concurrent requests.
 *
 * @returns A unique string ID
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const counter = (requestCounter++).toString(36);
  return `${timestamp}-${counter}`;
}

/**
 * Reset the request counter (useful for testing)
 */
export function resetRequestCounter(): void {
  requestCounter = 0;
}

// ============================================================================
// Response Creation
// ============================================================================

/**
 * Create a JSON-RPC success response
 *
 * @param id - The request ID this response corresponds to
 * @param result - The result data
 * @returns A valid JSON-RPC response object
 */
export function createResponse<T>(id: string | number, result: T): JSONRPCResponse<T> {
  return sharedCreateSuccessResponse(id, result);
}

/**
 * Create a JSON-RPC error response
 *
 * @param id - The request ID this response corresponds to
 * @param error - The error object (code, message, optional data)
 * @returns A valid JSON-RPC error response object
 */
export function createErrorResponse(
  id: string | number,
  error: JSONRPCError
): JSONRPCResponse {
  return {
    jsonrpc: '2.0',
    id,
    error,
  };
}

/**
 * Create a JSON-RPC notification (no response expected)
 *
 * @param method - The method name for the notification
 * @param params - Optional parameters
 * @returns A valid JSON-RPC notification object
 */
export function createNotification<T>(method: string, params: T): JSONRPCNotification<T> {
  return sharedCreateNotification(method, params);
}

// ============================================================================
// Request Tracker
// ============================================================================

/**
 * Pending request entry in the tracker
 */
interface PendingRequest {
  /** Resolve function called when response arrives */
  resolve: (result: unknown) => void;
  /** Reject function called on error or timeout */
  reject: (error: Error) => void;
  /** Timeout handle for cleanup */
  timeout: NodeJS.Timeout;
  /** Timestamp when request was added */
  addedAt: number;
}

/**
 * Options for creating a RequestTracker
 */
export interface RequestTrackerOptions {
  /** Default timeout in milliseconds (default: 30000) */
  defaultTimeoutMs?: number;
  /** Callback when a request times out */
  onTimeout?: (id: string) => void;
}

/**
 * Tracks pending JSON-RPC requests and their callbacks
 *
 * Used to correlate outgoing requests with incoming responses,
 * handling timeouts and cleanup.
 */
export class RequestTracker {
  /** Map of pending requests by ID */
  pending: Map<string, PendingRequest>;

  /** Default timeout for requests */
  private defaultTimeoutMs: number;

  /** Optional timeout callback */
  private onTimeout?: (id: string) => void;

  constructor(options: RequestTrackerOptions = {}) {
    this.pending = new Map();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    this.onTimeout = options.onTimeout;
  }

  /**
   * Add a new pending request
   *
   * @param id - Unique request ID
   * @param resolve - Promise resolve function
   * @param reject - Promise reject function
   * @param timeoutMs - Timeout in milliseconds (uses default if not specified)
   */
  add(
    id: string,
    resolve: (result: unknown) => void,
    reject: (error: Error) => void,
    timeoutMs?: number
  ): void {
    const actualTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;

    // Create timeout handler
    const timeout = setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        const error = new Error(`Request ${id} timed out after ${actualTimeoutMs}ms`);
        error.name = 'TimeoutError';
        reject(error);
        this.onTimeout?.(id);
      }
    }, actualTimeoutMs);

    // Store pending request
    this.pending.set(id, {
      resolve,
      reject,
      timeout,
      addedAt: Date.now(),
    });
  }

  /**
   * Resolve a pending request with a result
   *
   * @param id - Request ID to resolve
   * @param result - Result data
   * @returns true if request was found and resolved, false otherwise
   */
  resolve(id: string, result: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      return false;
    }

    // Clear timeout and remove from map
    clearTimeout(pending.timeout);
    this.pending.delete(id);

    // Resolve the promise
    pending.resolve(result);
    return true;
  }

  /**
   * Reject a pending request with an error
   *
   * @param id - Request ID to reject
   * @param error - Error to reject with
   * @returns true if request was found and rejected, false otherwise
   */
  reject(id: string, error: Error | JSONRPCError): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      return false;
    }

    // Clear timeout and remove from map
    clearTimeout(pending.timeout);
    this.pending.delete(id);

    // Convert JSONRPCError to Error if needed
    const err = error instanceof Error
      ? error
      : new Error(error.message);

    // Reject the promise
    pending.reject(err);
    return true;
  }

  /**
   * Check if a request is pending
   *
   * @param id - Request ID to check
   * @returns true if request is pending, false otherwise
   */
  has(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Get the number of pending requests
   */
  size(): number {
    return this.pending.size;
  }

  /**
   * Cleanup all pending requests
   *
   * Rejects all pending requests with an error.
   * Useful when closing a connection.
   */
  cleanup(): void {
    this.pending.forEach((pending, id) => {
      clearTimeout(pending.timeout);
      const error = new Error('Request cancelled: connection closed');
      error.name = 'CancelError';
      pending.reject(error);
    });
    this.pending.clear();
  }

  /**
   * Cleanup requests older than a specified age
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of requests cleaned up
   */
  cleanupStale(maxAgeMs: number): number {
    const now = Date.now();
    let cleaned = 0;

    this.pending.forEach((pending, id) => {
      if (now - pending.addedAt > maxAgeMs) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        const error = new Error(`Request ${id} expired (stale)`);
        error.name = 'StaleError';
        pending.reject(error);
        cleaned++;
      }
    });

    return cleaned;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an error code indicates a recoverable error
 *
 * @param code - JSON-RPC error code
 * @returns true if the error is potentially recoverable
 */
export function isRecoverableError(code: number): boolean {
  // Parse error and invalid request are not recoverable
  // Method not found, invalid params might be recoverable with different input
  // Internal errors might be temporary
  return (
    code === JSONRPCErrorCode.METHOD_NOT_FOUND ||
    code === JSONRPCErrorCode.INVALID_PARAMS ||
    code === JSONRPCErrorCode.INTERNAL_ERROR
  );
}

/**
 * Create a standardized JSON-RPC error from an unknown error
 *
 * @param error - Unknown error to convert
 * @returns A valid JSON-RPC error object
 */
export function normalizeError(error: unknown): JSONRPCError {
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    if (typeof err.code === 'number' && typeof err.message === 'string') {
      return {
        code: err.code,
        message: err.message,
        data: err.data,
      };
    }
    if (typeof err.message === 'string') {
      return createJSONRPCError(
        JSONRPCErrorCode.INTERNAL_ERROR,
        err.message,
        err.stack
      );
    }
  }

  return JSONRPC_ERRORS.INTERNAL_ERROR;
}

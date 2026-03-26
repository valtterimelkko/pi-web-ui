/**
 * JSON-RPC Method Types
 * Defines types for JSON-RPC method handlers
 */

import type WebSocket from 'ws';
import type { MultiSessionManager } from '../../pi/multi-session-manager.js';

/**
 * Context passed to all method handlers
 */
export interface MethodContext {
  /** The session ID for this request */
  sessionId: string;
  /** The session file path */
  sessionPath: string;
  /** The WebSocket connection */
  ws: WebSocket;
  /** Multi-session manager for accessing sessions */
  multiSessionManager: MultiSessionManager;
  /** Unique request ID for correlation */
  requestId: string;
  /** Client ID making the request */
  clientId: string;
}

/**
 * Method handler function type
 */
export type MethodHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: MethodContext
) => Promise<TResult>;

/**
 * Server capabilities returned during initialization
 */
export interface ServerCapabilities {
  /** Supported protocol version */
  protocolVersion: string;
  /** Server name */
  name: string;
  /** Server version */
  version: string;
  /** Supported features */
  features: {
    /** Supports streaming responses */
    streaming: boolean;
    /** Supports mid-turn steering */
    steering: boolean;
    /** Supports plan mode */
    planMode: boolean;
    /** Supports session replay */
    replay: boolean;
    /** Supports multi-session */
    multiSession: boolean;
    /** Supported thinking levels */
    thinkingLevels: ('off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh')[];
  };
}

/**
 * Client capabilities sent during initialization
 */
export interface ClientCapabilities {
  /** Client name */
  name?: string;
  /** Client version */
  version?: string;
  /** Supported features */
  features?: {
    streaming?: boolean;
    steering?: boolean;
    replay?: boolean;
  };
}

// ============================================================================
// Initialize Method Types
// ============================================================================

export interface InitializeParams {
  /** Protocol version requested by client */
  protocolVersion?: string;
  /** Client capabilities */
  capabilities?: ClientCapabilities;
}

export interface InitializeResult {
  /** Session ID for this connection */
  sessionId: string;
  /** Server capabilities */
  capabilities: ServerCapabilities;
  /** Protocol version negotiated */
  protocolVersion: string;
}

// ============================================================================
// Prompt Method Types
// ============================================================================

export interface PromptParams {
  /** The prompt message content */
  content: string;
  /** Optional images attached to the prompt */
  images?: Array<{
    type: 'image';
    data: string;
    mimeType: string;
  }>;
  /** Optional request ID for correlation (generated if not provided) */
  requestId?: string;
}

export interface PromptResult {
  /** Request ID for correlation with events */
  requestId: string;
  /** Whether the prompt was accepted */
  accepted: boolean;
}

// ============================================================================
// Cancel Method Types
// ============================================================================

export interface CancelParams {
  /** Optional request ID to cancel specific operation */
  requestId?: string;
  /** Reason for cancellation */
  reason?: string;
}

export interface CancelResult {
  /** Whether the cancellation was successful */
  cancelled: boolean;
  /** Message describing the result */
  message?: string;
}

// ============================================================================
// Steer Method Types
// ============================================================================

export interface SteerParams {
  /** The steering message content */
  message: string;
  /** Optional request ID for correlation */
  requestId?: string;
}

export interface SteerResult {
  /** Whether the steering message was accepted */
  accepted: boolean;
  /** Request ID for correlation */
  requestId: string;
  /** Message describing the result */
  message?: string;
}

// ============================================================================
// Replay Method Types
// ============================================================================

export interface ReplayParams {
  /** Index to start replaying from (0-based) */
  fromIndex?: number;
  /** Maximum number of events to return */
  limit?: number;
  /** Include tool results in replay */
  includeToolResults?: boolean;
}

export interface ReplayResult {
  /** Array of session events */
  events: Array<{
    id: string;
    type: string;
    timestamp: number;
    data: unknown;
  }>;
  /** Total events available */
  totalEvents: number;
  /** Index of first event returned */
  startIndex: number;
}

// ============================================================================
// SetPlanMode Method Types
// ============================================================================

export interface SetPlanModeParams {
  /** Whether to enable plan mode */
  enabled: boolean;
}

export interface SetPlanModeResult {
  /** Whether plan mode is now enabled */
  enabled: boolean;
  /** Message describing the result */
  message?: string;
}

// ============================================================================
// JSON-RPC Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number;
}

export interface JsonRpcResponse<TResult = unknown> {
  jsonrpc: '2.0';
  result?: TResult;
  error?: JsonRpcError;
  id?: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Standard JSON-RPC error codes
 */
export const JsonRpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Server errors (reserved for implementation-defined server-errors)
  SERVER_ERROR_START: -32000,
  SERVER_ERROR_END: -32099,
  // Custom application errors
  SESSION_NOT_FOUND: -33001,
  NOT_STREAMING: -33002,
  OPERATION_FAILED: -33003,
  UNAUTHORIZED: -33004,
} as const;

/**
 * Create a JSON-RPC error response
 */
export function createJsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    error: { code, message, data },
    id: id ?? null,
  };
}

/**
 * Create a JSON-RPC success response
 */
export function createJsonRpcResult<TResult>(
  id: string | number | null | undefined,
  result: TResult
): JsonRpcResponse<TResult> {
  return {
    jsonrpc: '2.0',
    result,
    id: id ?? null,
  };
}

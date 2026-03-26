/**
 * JSON-RPC 2.0 Protocol Types for Pi Web UI
 * 
 * This module provides type-safe JSON-RPC 2.0 implementation with Zod schemas
 * for runtime validation.
 * 
 * @see https://www.jsonrpc.org/specification
 */

import { z } from 'zod';

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

/**
 * JSON-RPC 2.0 Request message
 */
export interface JSONRPCRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: T;
}

/**
 * JSON-RPC 2.0 Response message (success or error)
 */
export interface JSONRPCResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: JSONRPCError;
}

/**
 * JSON-RPC 2.0 Notification message (no response expected)
 */
export interface JSONRPCNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// Standard JSON-RPC Error Codes
// ============================================================================

/**
 * Standard JSON-RPC 2.0 error codes
 * @see https://www.jsonrpc.org/specification#error_object
 */
export const JSONRPCErrorCode = {
  /** Invalid JSON was received by the server */
  PARSE_ERROR: -32700,
  /** The JSON sent is not a valid Request object */
  INVALID_REQUEST: -32600,
  /** The method does not exist / is not available */
  METHOD_NOT_FOUND: -32601,
  /** Invalid method parameter(s) */
  INVALID_PARAMS: -32602,
  /** Internal JSON-RPC error */
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Server error codes range (reserved for implementation-defined server errors)
 */
export const JSONRPCServerErrorCode = {
  /** Start of server error code range */
  SERVER_ERROR_START: -32000,
  /** End of server error code range */
  SERVER_ERROR_END: -32099,
} as const;

/**
 * Type guard to check if a code is a standard JSON-RPC error code
 */
export function isStandardErrorCode(code: number): boolean {
  return (
    code === JSONRPCErrorCode.PARSE_ERROR ||
    code === JSONRPCErrorCode.INVALID_REQUEST ||
    code === JSONRPCErrorCode.METHOD_NOT_FOUND ||
    code === JSONRPCErrorCode.INVALID_PARAMS ||
    code === JSONRPCErrorCode.INTERNAL_ERROR
  );
}

/**
 * Type guard to check if a code is in the server error range
 */
export function isServerErrorCode(code: number): boolean {
  return code <= JSONRPCServerErrorCode.SERVER_ERROR_START && 
         code >= JSONRPCServerErrorCode.SERVER_ERROR_END;
}

/**
 * Get a human-readable name for an error code
 */
export function getErrorName(code: number): string {
  switch (code) {
    case JSONRPCErrorCode.PARSE_ERROR:
      return 'Parse Error';
    case JSONRPCErrorCode.INVALID_REQUEST:
      return 'Invalid Request';
    case JSONRPCErrorCode.METHOD_NOT_FOUND:
      return 'Method Not Found';
    case JSONRPCErrorCode.INVALID_PARAMS:
      return 'Invalid Params';
    case JSONRPCErrorCode.INTERNAL_ERROR:
      return 'Internal Error';
    default:
      if (isServerErrorCode(code)) {
        return 'Server Error';
      }
      return 'Unknown Error';
  }
}

/**
 * Create a JSON-RPC error object
 */
export function createJSONRPCError(
  code: number,
  message?: string,
  data?: unknown
): JSONRPCError {
  return {
    code,
    message: message ?? getErrorName(code),
    ...(data !== undefined && { data }),
  };
}

// ============================================================================
// Zod Schemas for JSON-RPC 2.0
// ============================================================================

/** Schema for JSON-RPC version string */
export const JSONRPCVersionSchema = z.literal('2.0');

/** Schema for JSON-RPC request ID */
export const JSONRPCIdSchema = z.union([z.string(), z.number()]);

/** Schema for JSON-RPC error object */
export const JSONRPCErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** Base schema for JSON-RPC messages */
export const JSONRPCBaseSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
});

/** Schema for JSON-RPC request */
export const JSONRPCRequestSchema = JSONRPCBaseSchema.extend({
  id: JSONRPCIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

/** Schema for JSON-RPC response */
export const JSONRPCResponseSchema = JSONRPCBaseSchema.extend({
  id: JSONRPCIdSchema,
  result: z.unknown().optional(),
  error: JSONRPCErrorSchema.optional(),
}).refine(
  (data) => !(data.result !== undefined && data.error !== undefined),
  { message: 'Response must have either result or error, not both' }
);

/** Schema for JSON-RPC notification */
export const JSONRPCNotificationSchema = JSONRPCBaseSchema.extend({
  method: z.string().min(1),
  params: z.unknown().optional(),
});

// ============================================================================
// Pi Web UI Method Types
// ============================================================================

// --- Client Capabilities ---

/**
 * Client capabilities announced during initialization
 */
export interface ClientCapabilities {
  /** Supported protocol versions */
  protocolVersion?: string;
  /** Client supports streaming responses */
  streaming?: boolean;
  /** Client supports attachments */
  attachments?: boolean;
  /** Client supports steering (mid-stream intervention) */
  steering?: boolean;
  /** Additional client-specific capabilities */
  [key: string]: unknown;
}

/**
 * Server capabilities announced during initialization
 */
export interface ServerCapabilities {
  /** Supported protocol version */
  protocolVersion: string;
  /** Server supports streaming responses */
  streaming: boolean;
  /** Server supports file attachments */
  attachments: boolean;
  /** Server supports steering (mid-stream intervention) */
  steering: boolean;
  /** Available tools/methods */
  methods?: string[];
  /** Additional server-specific capabilities */
  [key: string]: unknown;
}

// --- File Attachment ---

/**
 * File attachment for messages
 */
export interface Attachment {
  /** File name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** File content as base64 string */
  data: string;
}

// --- Method Parameters and Results ---

/**
 * Parameters for initialize method
 */
export interface InitializeParams {
  capabilities: ClientCapabilities;
}

/**
 * Result of initialize method
 */
export interface InitializeResult {
  capabilities: ServerCapabilities;
  sessionId: string;
}

/**
 * Parameters for prompt method
 */
export interface PromptParams {
  content: string;
  attachments?: Attachment[];
}

/**
 * Result of prompt method
 */
export interface PromptResult {
  requestId: string;
}

/**
 * Parameters for cancel method
 */
export interface CancelParams {
  requestId: string;
}

/**
 * Parameters for steer method (mid-stream intervention)
 */
export interface SteerParams {
  content: string;
}

/**
 * Parameters for replay method
 */
export interface ReplayParams {
  fromIndex?: number;
}

/**
 * A single event from replay
 */
export interface ReplayEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

/**
 * Result of replay method
 */
export interface ReplayResult {
  events: ReplayEvent[];
  complete: boolean;
}

// ============================================================================
// Pi Web UI Event Types (Server → Client Notifications)
// ============================================================================

/**
 * Content part streaming event
 */
export interface ContentPartEvent {
  type: 'text' | 'thinking';
  content: string;
  isDelta: boolean;
}

/**
 * Tool call event
 */
export interface ToolCallEvent {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Tool result event
 */
export interface ToolResultEvent {
  id: string;
  result: unknown;
  isError: boolean;
}

/**
 * Agent status change event
 */
export interface StatusEvent {
  status: 'idle' | 'busy' | 'streaming' | 'error';
  message?: string;
}

/**
 * Turn begin event
 */
export interface TurnBeginEvent {
  turnId: string;
}

/**
 * Turn end event
 */
export interface TurnEndEvent {
  turnId: string;
}

// ============================================================================
// Method Names
// ============================================================================

/**
 * JSON-RPC method names for Pi Web UI
 */
export const MethodName = {
  // Client → Server methods
  INITIALIZE: 'initialize',
  PROMPT: 'prompt',
  CANCEL: 'cancel',
  STEER: 'steer',
  REPLAY: 'replay',
  
  // Server → Client notifications
  CONTENT_PART: 'contentPart',
  TOOL_CALL: 'toolCall',
  TOOL_RESULT: 'toolResult',
  STATUS: 'status',
  TURN_BEGIN: 'turnBegin',
  TURN_END: 'turnEnd',
} as const;

export type MethodName = typeof MethodName[keyof typeof MethodName];

// ============================================================================
// Zod Schemas for Pi Web UI Types
// ============================================================================

/** Schema for client capabilities */
export const ClientCapabilitiesSchema = z.object({
  protocolVersion: z.string().optional(),
  streaming: z.boolean().optional(),
  attachments: z.boolean().optional(),
  steering: z.boolean().optional(),
}).passthrough();

/** Schema for server capabilities */
export const ServerCapabilitiesSchema = z.object({
  protocolVersion: z.string(),
  streaming: z.boolean(),
  attachments: z.boolean(),
  steering: z.boolean(),
  methods: z.array(z.string()).optional(),
}).passthrough();

/** Schema for attachment */
export const AttachmentSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  data: z.string(), // base64
});

/** Schema for initialize params */
export const InitializeParamsSchema = z.object({
  capabilities: ClientCapabilitiesSchema,
});

/** Schema for initialize result */
export const InitializeResultSchema = z.object({
  capabilities: ServerCapabilitiesSchema,
  sessionId: z.string(),
});

/** Schema for prompt params */
export const PromptParamsSchema = z.object({
  content: z.string().min(1),
  attachments: z.array(AttachmentSchema).optional(),
});

/** Schema for prompt result */
export const PromptResultSchema = z.object({
  requestId: z.string(),
});

/** Schema for cancel params */
export const CancelParamsSchema = z.object({
  requestId: z.string(),
});

/** Schema for steer params */
export const SteerParamsSchema = z.object({
  content: z.string().min(1),
});

/** Schema for replay params */
export const ReplayParamsSchema = z.object({
  fromIndex: z.number().int().nonnegative().optional(),
});

/** Schema for replay event */
export const ReplayEventSchema = z.object({
  type: z.string(),
  data: z.unknown(),
  timestamp: z.number(),
});

/** Schema for replay result */
export const ReplayResultSchema = z.object({
  events: z.array(ReplayEventSchema),
  complete: z.boolean(),
});

/** Schema for content part event */
export const ContentPartEventSchema = z.object({
  type: z.enum(['text', 'thinking']),
  content: z.string(),
  isDelta: z.boolean(),
});

/** Schema for tool call event */
export const ToolCallEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
});

/** Schema for tool result event */
export const ToolResultEventSchema = z.object({
  id: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
});

/** Schema for status event */
export const StatusEventSchema = z.object({
  status: z.enum(['idle', 'busy', 'streaming', 'error']),
  message: z.string().optional(),
});

/** Schema for turn begin event */
export const TurnBeginEventSchema = z.object({
  turnId: z.string(),
});

/** Schema for turn end event */
export const TurnEndEventSchema = z.object({
  turnId: z.string(),
});

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an unknown value is a valid JSON-RPC request
 */
export function isJSONRPCRequest(value: unknown): value is JSONRPCRequest {
  const result = JSONRPCRequestSchema.safeParse(value);
  return result.success;
}

/**
 * Check if an unknown value is a valid JSON-RPC response
 */
export function isJSONRPCResponse(value: unknown): value is JSONRPCResponse {
  const result = JSONRPCResponseSchema.safeParse(value);
  return result.success;
}

/**
 * Check if an unknown value is a valid JSON-RPC notification
 */
export function isJSONRPCNotification(value: unknown): value is JSONRPCNotification {
  const result = JSONRPCNotificationSchema.safeParse(value);
  return result.success;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a JSON-RPC request
 */
export function createRequest<T>(
  id: string | number,
  method: string,
  params?: T
): JSONRPCRequest<T> {
  return {
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined && { params }),
  };
}

/**
 * Create a JSON-RPC success response
 */
export function createSuccessResponse<T>(
  id: string | number,
  result: T
): JSONRPCResponse<T> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Create a JSON-RPC error response
 */
export function createErrorResponse(
  id: string | number,
  code: number,
  message?: string,
  data?: unknown
): JSONRPCResponse<never> {
  return {
    jsonrpc: '2.0',
    id,
    error: createJSONRPCError(code, message, data),
  };
}

/**
 * Create a JSON-RPC notification
 */
export function createNotification<T>(
  method: string,
  params?: T
): JSONRPCNotification<T> {
  return {
    jsonrpc: '2.0',
    method,
    ...(params !== undefined && { params }),
  };
}

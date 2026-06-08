// WebSocket Protocol Types
// Defines the message format for client-server communication

// ============================================================================
// Multi-Session Protocol Types
// ============================================================================

/**
 * Session status types for multi-session support
 */
export type SessionStatus = 'idle' | 'busy' | 'streaming' | 'error';

/**
 * Server → Client: Broadcast when any session's state changes
 */
export interface SessionStatusBroadcast {
  type: 'session_status';
  sessionId: string;
  sessionPath: string;
  status: SessionStatus;
  lastActivity: string;
  messageCount: number;
  currentStep?: number;
}

/**
 * Server → Client: Wrap all events with sessionId for routing
 */
export interface SessionEvent {
  type: 'session_event';
  sessionId: string;
  event: unknown; // AgentSessionEvent from Pi SDK
}

/**
 * Client → Server: Subscribe to a session's events
 */
export interface SubscribeSession {
  type: 'subscribe_session';
  sessionPath: string;
}

/**
 * Client → Server: Unsubscribe from a session's events
 */
export interface UnsubscribeSession {
  type: 'unsubscribe_session';
  sessionPath: string;
}

/**
 * Client → Server: Pin a session (protect from idle/stale cleanup)
 */
export interface PinSession {
  type: 'pin_session';
  sessionPath: string;
}

/**
 * Client → Server: Unpin a session (allow normal cleanup)
 */
export interface UnpinSession {
  type: 'unpin_session';
  sessionPath: string;
}

/**
 * Server → Client: Confirmation of subscription
 */
export interface SessionSubscribed {
  type: 'session_subscribed';
  sessionId: string;
  sessionPath: string;
  status: SessionStatus;
  messageCount?: number;
  currentStep?: number;
}

/**
 * Server → Client: Confirmation of unsubscription
 */
export interface SessionUnsubscribed {
  type: 'session_unsubscribed';
  sessionId: string;
  sessionPath?: string;
}

// ============================================================================
// Core Protocol Types
// ============================================================================

// Image content for multimodal messages
export interface ImageContent {
  type: 'image';
  data: string; // base64 encoded
  mimeType: string;
}

// Client → Server messages
export type ClientMessage =
  | { type: 'auth'; csrfToken: string }
  | { type: 'prompt'; sessionId: string; message: string; images?: ImageContent[]; agent?: string }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'new_session'; cwd?: string; sdkType?: 'pi' | 'claude' | 'opencode' }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'get_sessions'; cwd?: string }
  | { type: 'get_session_tree'; sessionId: string }
  | { type: 'get_session_info' }
  | { type: 'fork'; entryId: string }
  | { type: 'navigate_tree'; entryId: string; summarize?: boolean }
  | { type: 'set_model'; modelId: string }
  | { type: 'set_thinking_level'; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'extension_ui_response'; response: { id: string; approved?: boolean; value?: unknown; cancelled?: boolean } }
  | { type: 'set_session_name'; sessionId: string; name: string }
  // Multi-session subscription types
  | SubscribeSession
  | UnsubscribeSession
  | PinSession
  | UnpinSession
  // Session context transfer
  | TransferSessionContext;

// Session information for listing
export interface SessionInfo {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  name?: string;
  createdAt?: string;
  lastActivity?: string;
}

// Session message for loading chat history
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; thinking?: string }>;
  timestamp: number;
}

// Session statistics for get_session_info
export interface SessionStats {
  sessionFile?: string | undefined;
  sessionId?: string;
  cwd?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  messageCount?: number;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: number;
  model?: string;
  contextWindow?: number;
  contextUsed?: number;
  contextPercent?: number;
  lastActivityAt?: number;
}

// Tree node for session history navigation
export interface TreeNode {
  id: string;
  parentId: string | null;
  type: string;
  label?: string;
  children: TreeNode[];
}

// Server → Client messages
export type ServerMessage =
  | { type: 'authenticated'; sessionId: string }
  | { type: 'connection_status'; status: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'sessions_list'; sessions: SessionInfo[] }
  | { type: 'session_created'; sessionId: string; sessionPath: string; sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity' }
  | { type: 'session_switched'; sessionId: string; sessionPath: string; model?: string; thinkingLevel?: string; contextWindow?: number; contextUsed?: number; contextPercent?: number; messages?: SessionMessage[]; fileTimestamp?: number; isStreaming?: boolean }
  | { type: 'session_tree'; tree: TreeNode[] }
  | { type: 'session_info'; stats: SessionStats }
  | { type: 'model_changed'; modelId: string }
  | { type: 'thinking_level_changed'; level: string }
  | { type: 'compaction_result'; summary: string; tokensBefore: number; contextWindow?: number; contextUsed?: number; contextPercent?: number }
  | { type: 'context_update'; sessionId: string; contextWindow?: number; contextUsed?: number; contextPercent?: number }
  // Multi-session protocol types
  | SessionStatusBroadcast
  | SessionEvent
  | SessionSubscribed
  | SessionUnsubscribed
  | { type: 'session_pinned'; sessionPath: string; pinned: boolean }
  | { type: 'session_pin_error'; sessionPath: string; error: string }
  // Forwarded Pi SDK events
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number; message: unknown; toolResults: unknown[] }
  | { type: 'message_start'; message: unknown }
  | { type: 'message_update'; message: unknown; assistantMessageEvent: unknown }
  | { type: 'message_end'; message: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'auto_compaction_start'; reason: string }
  | { type: 'auto_compaction_end'; result: unknown; aborted: boolean; willRetry: boolean }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; extensionPath: string; event: string; error: string }
  | { type: 'extension_ui_request'; request: { id: string; type: 'confirm' | 'select' | 'input' | 'editor'; method: string; params: Record<string, unknown>; timeout: number } }
  // CLI Session Watcher events
  | { type: 'session_update'; changeType: 'add' | 'change' | 'unlink'; path: string; sessionId?: string; cwd?: string; info?: SessionInfo }
  | { type: 'session_name_updated'; sessionId: string; name: string }
  | { type: 'session_name_changed'; sessionId: string; name: string }
  | { type: 'claude_available'; available: boolean; error: string | null }
  | { type: 'opencode_available'; available: boolean; error: string | null }
  | { type: 'antigravity_available'; available: boolean; error: string | null }
  // Session context transfer responses
  | SessionTransferCompleted
  | SessionTransferFailed;

// Message type guards
export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return typeof msg.type === 'string';
}

export function isAuthMessage(message: ClientMessage): message is { type: 'auth'; csrfToken: string } {
  return message.type === 'auth' && typeof (message as { csrfToken?: unknown }).csrfToken === 'string';
}

export function isPromptMessage(message: ClientMessage): message is { type: 'prompt'; sessionId: string; message: string; images?: ImageContent[] } {
  return message.type === 'prompt';
}

// ============================================================================
// Multi-Session Type Guards
// ============================================================================

/**
 * Check if a value is a valid SessionStatus
 */
export function isValidSessionStatus(value: unknown): value is SessionStatus {
  return (
    typeof value === 'string' &&
    ['idle', 'busy', 'streaming', 'error'].includes(value)
  );
}

/**
 * Type guard for SessionStatusBroadcast
 */
export function isSessionStatusBroadcast(
  data: unknown
): data is SessionStatusBroadcast {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_status' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.sessionPath === 'string' &&
    isValidSessionStatus(msg.status) &&
    typeof msg.lastActivity === 'string' &&
    typeof msg.messageCount === 'number' &&
    (msg.currentStep === undefined || typeof msg.currentStep === 'number')
  );
}

/**
 * Type guard for SessionEvent
 */
export function isSessionEvent(data: unknown): data is SessionEvent {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_event' &&
    typeof msg.sessionId === 'string' &&
    msg.event !== undefined
  );
}

/**
 * Type guard for SubscribeSession
 */
export function isSubscribeSession(data: unknown): data is SubscribeSession {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'subscribe_session' && typeof msg.sessionPath === 'string';
}

/**
 * Type guard for UnsubscribeSession
 */
export function isUnsubscribeSession(
  data: unknown
): data is UnsubscribeSession {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'unsubscribe_session' && typeof msg.sessionPath === 'string'
  );
}

/**
 * Type guard for SessionSubscribed
 */
export function isSessionSubscribed(data: unknown): data is SessionSubscribed {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_subscribed' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.sessionPath === 'string' &&
    isValidSessionStatus(msg.status)
  );
}

/**
 * Type guard for SessionUnsubscribed
 */
export function isSessionUnsubscribed(
  data: unknown
): data is SessionUnsubscribed {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_unsubscribed' && typeof msg.sessionId === 'string'
  );
}

/**
 * Type guard for PinSession
 */
export function isPinSession(data: unknown): data is PinSession {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'pin_session' && typeof msg.sessionPath === 'string';
}

/**
 * Type guard for UnpinSession
 */
export function isUnpinSession(data: unknown): data is UnpinSession {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'unpin_session' && typeof msg.sessionPath === 'string';
}

// ============================================================================
// Session Context Transfer Protocol Types
// ============================================================================

export interface TransferSessionContext {
  type: 'transfer_session_context';
  sourceSessionId: string;
  targetSessionId?: string;
  createNew?: boolean;
  targetSdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity';
  targetCwd?: string;
  scope: 'visible_recent' | 'visible_full';
  sourceDisplayName?: string;
}

export interface SessionTransferCompleted {
  type: 'session_transfer_completed';
  sourceSessionId: string;
  targetSessionId: string;
  createdNewSession: boolean;
}

export interface SessionTransferFailed {
  type: 'session_transfer_failed';
  sourceSessionId: string;
  targetSessionId?: string;
  message: string;
  code: string;
}

export function isTransferSessionContext(data: unknown): data is TransferSessionContext {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'transfer_session_context' &&
    typeof msg.sourceSessionId === 'string' &&
    (msg.scope === 'visible_recent' || msg.scope === 'visible_full')
  );
}

// ============================================================================
// Multi-Session Factory Functions
// ============================================================================

/**
 * Create a valid SessionStatusBroadcast
 */
export function createSessionStatusBroadcast(
  overrides: Partial<SessionStatusBroadcast> = {}
): SessionStatusBroadcast {
  return {
    type: 'session_status',
    sessionId: 'session-123',
    sessionPath: '/path/to/session.jsonl',
    status: 'idle',
    lastActivity: new Date().toISOString(),
    messageCount: 5,
    ...overrides,
  };
}

/**
 * Create a valid SessionEvent
 */
export function createSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    type: 'session_event',
    sessionId: 'session-123',
    event: { type: 'test_event', data: 'test' },
    ...overrides,
  };
}

/**
 * Create a valid SubscribeSession
 */
export function createSubscribeSession(
  overrides: Partial<SubscribeSession> = {}
): SubscribeSession {
  return {
    type: 'subscribe_session',
    sessionPath: '/path/to/session.jsonl',
    ...overrides,
  };
}

/**
 * Create a valid UnsubscribeSession
 */
export function createUnsubscribeSession(
  overrides: Partial<UnsubscribeSession> = {}
): UnsubscribeSession {
  return {
    type: 'unsubscribe_session',
    sessionPath: '/path/to/session.jsonl',
    ...overrides,
  };
}

/**
 * Create a valid SessionSubscribed
 */
export function createSessionSubscribed(
  overrides: Partial<SessionSubscribed> = {}
): SessionSubscribed {
  return {
    type: 'session_subscribed',
    sessionId: 'session-123',
    sessionPath: '/path/to/session.jsonl',
    status: 'idle',
    ...overrides,
  };
}

/**
 * Create a valid SessionUnsubscribed
 */
export function createSessionUnsubscribed(
  overrides: Partial<SessionUnsubscribed> = {}
): SessionUnsubscribed {
  return {
    type: 'session_unsubscribed',
    sessionId: 'session-123',
    ...overrides,
  };
}

/**
 * Create a valid PinSession
 */
export function createPinSession(
  overrides: Partial<PinSession> = {}
): PinSession {
  return {
    type: 'pin_session',
    sessionPath: '/path/to/session.jsonl',
    ...overrides,
  };
}

/**
 * Create a valid UnpinSession
 */
export function createUnpinSession(
  overrides: Partial<UnpinSession> = {}
): UnpinSession {
  return {
    type: 'unpin_session',
    sessionPath: '/path/to/session.jsonl',
    ...overrides,
  };
}

// Error codes
export const ErrorCodes = {
  RATE_LIMIT: 'RATE_LIMIT',
  INVALID_JSON: 'INVALID_JSON',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  PROMPT_INJECTION: 'PROMPT_INJECTION',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

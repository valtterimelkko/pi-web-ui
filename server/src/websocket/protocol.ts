// WebSocket Protocol Types
// Defines the message format for client-server communication

// Image content for multimodal messages
export interface ImageContent {
  type: 'image';
  data: string; // base64 encoded
  mimeType: string;
}

// Client → Server messages
export type ClientMessage =
  | { type: 'auth'; csrfToken: string }
  | { type: 'prompt'; sessionId: string; message: string; images?: ImageContent[] }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'new_session'; cwd?: string }
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
  | { type: 'set_session_name'; sessionId: string; name: string };

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
  | { type: 'session_created'; sessionId: string; sessionPath: string }
  | { type: 'session_switched'; sessionId: string; sessionPath: string; model?: string; contextWindow?: number; contextUsed?: number; contextPercent?: number; messages?: SessionMessage[]; fileTimestamp?: number; isStreaming?: boolean }
  | { type: 'session_tree'; tree: TreeNode[] }
  | { type: 'session_info'; stats: SessionStats }
  | { type: 'model_changed'; modelId: string }
  | { type: 'thinking_level_changed'; level: string }
  | { type: 'compaction_result'; summary: string; tokensBefore: number }
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
  | { type: 'session_name_changed'; sessionId: string; name: string };

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

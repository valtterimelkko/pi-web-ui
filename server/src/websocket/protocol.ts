// WebSocket Protocol Types
// Defines the message format for client-server communication

import type { CommandCodeEffort, CommandCodeModelInfo, SdkType, SubagentToolSummary } from '@pi-web-ui/shared';

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
  | { type: 'ping' }
  | { type: 'prompt'; sessionId: string; message: string; images?: ImageContent[]; agent?: string }
  | { type: 'steer'; message: string }
  | { type: 'follow_up'; message: string }
  | { type: 'abort' }
  | { type: 'new_session'; cwd?: string; sdkType?: SdkType; model?: string; thinkingLevel?: string; effort?: CommandCodeEffort; requestId?: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'get_sessions'; cwd?: string }
  | { type: 'get_session_tree'; sessionId: string }
  | { type: 'get_session_info' }
  | { type: 'fork'; entryId: string }
  | { type: 'navigate_tree'; entryId: string; summarize?: boolean }
  | { type: 'set_model'; modelId: string }
  | { type: 'set_thinking_level'; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { type: 'set_effort'; effort?: CommandCodeEffort }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'goal_control'; sessionId: string; action: 'pause' | 'resume' | 'clear' }
  | { type: 'extension_ui_response'; response: { id: string; approved?: boolean; value?: unknown; cancelled?: boolean } }
  | { type: 'set_session_name'; sessionId: string; name: string }
  // Multi-session subscription types
  | SubscribeSession
  | UnsubscribeSession
  | PinSession
  | UnpinSession
  // Session context transfer
  | TransferSessionContext
  // Voice talker (Drive Mode Two-Lane plan, brief H7)
  | TalkerTurnMessage
  // Voice reading levels (P17): the talker digest — one direction only
  | TalkerDigestMessage;

// Session information for listing
export interface SessionInfo {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  name?: string;
  sdkType?: SdkType;
  model?: string;
  effort?: CommandCodeEffort;
  effortLevels?: CommandCodeEffort[];
  defaultEffort?: CommandCodeEffort;
  createdAt?: string;
  lastActivity?: string;
}

// Session message for loading chat history
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; thinking?: string }>;
  timestamp: number;
  toolCall?: { id: string; name: string; args: unknown };
  toolResult?: { output: string; isError: boolean; summary?: SubagentToolSummary };
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
  effort?: CommandCodeEffort;
  effortLevels?: CommandCodeEffort[];
  defaultEffort?: CommandCodeEffort;
  contextWindow?: number;
  contextUsed?: number;
  contextPercent?: number;
  lastActivityAt?: number;
  /** Native runtime session id (Command Code CLI id; Antigravity agy
   *  conversation id). Distinct from the pi-web-ui registry id. */
  nativeSessionId?: string;
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
  | { type: 'error'; message: string; code?: string; sessionPath?: string; requestId?: string }
  | { type: 'sessions_list'; sessions: SessionInfo[] }
  | { type: 'session_created'; sessionId: string; sessionPath: string; sdkType?: SdkType; model?: string; effort?: CommandCodeEffort; effortLevels?: CommandCodeEffort[]; defaultEffort?: CommandCodeEffort; requestId?: string }
  | { type: 'session_switched'; sessionId: string; sessionPath: string; sdkType?: SdkType; model?: string; thinkingLevel?: string; effort?: CommandCodeEffort; effortLevels?: CommandCodeEffort[]; defaultEffort?: CommandCodeEffort; contextWindow?: number; contextUsed?: number; contextPercent?: number; messages?: SessionMessage[]; fileTimestamp?: number; isStreaming?: boolean }
  | { type: 'session_tree'; tree: TreeNode[] }
  | { type: 'session_info'; stats: SessionStats }
  | { type: 'model_changed'; modelId: string }
  | { type: 'effort_changed'; effort?: CommandCodeEffort; effortLevels?: CommandCodeEffort[]; defaultEffort?: CommandCodeEffort }
  | { type: 'commandcode_available'; available: boolean; enabled: boolean; models: CommandCodeModelInfo[]; error: string | null }
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
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean; args?: unknown }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | { type: 'compaction_end'; reason: 'manual' | 'threshold' | 'overflow'; result?: { tokensBefore: number; estimatedTokensAfter?: number }; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; extensionPath: string; event: string; error: string }
  // Contract 1.34.0 child surfacing: structured background-subagent state.
  | { type: 'background_child_state'; sessionId: string; children: unknown[] }
  | { type: 'extension_ui_request'; request: { id: string; type: 'confirm' | 'select' | 'input' | 'editor' | 'ask_user_question'; method: string; params: Record<string, unknown>; timeout: number } }
  | { type: 'extension_ui_cancel'; request: { id: string; reason: 'timeout' | 'aborted' | 'turn_end' | 'disconnected' | 'answered' } }
  | { type: 'pong' }
  // CLI Session Watcher events
  | { type: 'session_update'; changeType: 'add' | 'change' | 'unlink'; path: string; sessionId?: string; cwd?: string; info?: SessionInfo }
  | { type: 'session_name_updated'; sessionId: string; name: string }
  | { type: 'session_name_changed'; sessionId: string; name: string }
  | { type: 'claude_available'; available: boolean; error: string | null }
  | { type: 'opencode_available'; available: boolean; error: string | null }
  | { type: 'antigravity_available'; available: boolean; error: string | null }
  // Session context transfer responses
  | SessionTransferCompleted
  | SessionTransferFailed
  // Voice talker (Drive Mode Two-Lane plan, brief H7)
  | TalkerTurnResultMessage
  // P17 reading levels: the digest answer for the operator's chosen level
  | TalkerDigestResultMessage;

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
// Voice Talker Protocol Types (Drive Mode Two-Lane plan, brief H7)
//
// Wire types live here (the client mirrors the result shape locally in
// lib/talkerBus.ts, matching the existing convention in client/src/lib/
// websocket.ts — the worktree's node_modules resolves @pi-web-ui/shared to
// the main checkout, so a worktree-local additive type there is invisible to
// this workspace's typecheck).
// ============================================================================

/** Which runtime adapter relays for a worker session (mirrors the talker registry). */
export type TalkerRuntime = 'pi' | 'claude' | 'antigravity';

/** Coarse, mechanically derived turn outcome so the client can act (speak)
 *  without re-deriving harness state:
 *   - 'refused'   the utterance never reached the talker (see `refused`);
 *   - 'released'  the operator's confirmation released a pending proposal;
 *   - 'proposed'  the harness holds an instruction a confirm would release;
 *   - 'answered'  plain conversational turn (including a cancel).
 */
export type TalkerTurnPhase = 'answered' | 'proposed' | 'released' | 'refused';

/**
 * The harness's mechanical classification of the operator's utterance, as the
 * server computed it (P18 package C). The client uses it for one decision
 * only: whether the reply to this turn is ELICITED (the answer to a question
 * the operator just asked — spoken at the answer tier, because it is the
 * conversation) or unprompted commentary (spoken at the chatter tier, where it
 * may be dropped rather than deferring anything that matters). Absent on
 * older/refused turns, which fall back to chatter — never to a guess.
 */
export type TalkerUtteranceClass = 'confirm' | 'cancel' | 'question' | 'statement';

/** Wire shape of the talker library's DeliveryOutcome (JSON-safe passthrough). */
export type TalkerDeliveryOutcome =
  | { outcome: 'delivered'; mechanism: 'steer' | 'prompt'; disclosure?: string }
  | { outcome: 'queued'; mechanism: 'follow_up'; disclosure: string }
  | { outcome: 'refused'; reason: string };

/**
 * Client → Server: one operator utterance for the worker session's talker.
 * The registry applies the prompt-injection gate BEFORE any model call and
 * holds the only confirm-gated release path; this message adds no capability
 * of its own.
 */
export interface TalkerTurnMessage {
  type: 'talker_turn';
  /**
   * The worker session this talker relays to. Either identifier works (P12):
   * the session path, or the session id the server issued in `session_created` —
   * resolved against the runtime adapter's own index at the delivery boundary.
   */
  workerSessionId: string;
  /** The operator's verbatim utterance. */
  utterance: string;
  /** Defaults to 'pi'. */
  runtime?: TalkerRuntime;
  requestId?: string;
  /**
   * The operator's focus/hold control, when it is on (P18 package C).
   * Projection input for the talker only: it lets the talker suggest leaving
   * focus. It cannot switch the control (the operator presses it on the
   * client) and it is never an input to the confirm gate.
   */
  operatorFocus?: boolean;
}

/** Server → Client: what happened on one operator talker turn. */
export interface TalkerTurnResultMessage {
  type: 'talker_turn_result';
  requestId?: string;
  workerSessionId: string;
  runtime: TalkerRuntime;
  /** What the operator hears (spoken by the client). */
  reply: string;
  phase: TalkerTurnPhase;
  /** Set only when phase === 'refused'. */
  refused?: 'prompt_injection' | 'model_unconfigured' | 'deliveries_unavailable';
  /** Non-null only on a released turn: verbatim relay text + delivery outcome. */
  released: { utteranceId: number; text: string; delivery: TalkerDeliveryOutcome } | null;
  /** True when this turn cancelled a pending proposal. */
  cancelled: boolean;
  /**
   * The harness's mechanical classification of the operator's utterance (P18
   * package C). Additive and optional: the client only uses it to choose the
   * speech tier for the reply (elicited answer vs unprompted commentary).
   */
  utteranceClass?: TalkerUtteranceClass;
  /**
   * Present when the harness emitted a receipt ack this turn (plan §4.1
   * rule 2): a fixed-vocabulary string from the server's ack vocabulary —
   * a receipt that operator speech is held, never an agreement, never a
   * send. Produced mechanically server-side; the model cannot compose,
   * suppress or extend it. The client speaks it at TIER_RECEIPT_ACK, ahead
   * of everything else. Additive, optional.
   */
  receiptAck?: string;
  /** Present when the talker's model call failed (honest, surfaced). */
  error?: string;
}

export function isTalkerTurnMessage(data: unknown): data is TalkerTurnMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'talker_turn' &&
    typeof msg.workerSessionId === 'string' &&
    typeof msg.utterance === 'string' &&
    (msg.runtime === undefined || msg.runtime === 'pi' || msg.runtime === 'claude' || msg.runtime === 'antigravity') &&
    (msg.requestId === undefined || typeof msg.requestId === 'string') &&
    (msg.operatorFocus === undefined || typeof msg.operatorFocus === 'boolean')
  );
}

// ============================================================================
// Voice reading levels (P17): the talker digest
// ============================================================================

/**
 * Client → Server: ask the talker to digest a turn for the OPERATOR to hear.
 *
 * This is not an operator utterance and must never be mistaken for one: the text
 * travels worker → talker → operator, and the relay gate exists for the opposite
 * direction only. The handler has no delivery path, creates no talker session
 * and records no draft — see session-registry.handleDigest.
 */
export interface TalkerDigestMessage {
  type: 'talker_digest';
  /** The worker session this digest belongs to. Either identifier works (P12). */
  workerSessionId: string;
  /** 'summary' digests the turn; 'headlines' reduces it to one status line. */
  kind: 'summary' | 'headlines';
  /** The worker's output to digest (the unplayed remainder after a flip). */
  text: string;
  /** What the operator has already heard — the digest never repeats it. */
  spokenPrefix?: string;
  runtime?: TalkerRuntime;
  requestId?: string;
}

/** Server → Client: the digest, or an honest statement that there is none. */
export interface TalkerDigestResultMessage {
  type: 'talker_digest_result';
  requestId?: string;
  workerSessionId: string;
  runtime: TalkerRuntime;
  kind: 'summary' | 'headlines';
  /** Null when the talker could not help; the client reads the turn in full. */
  digest: string | null;
  refused?: 'model_unconfigured' | 'unsafe_input' | 'empty_text';
  error?: string;
}

/** A hard sanity bound; the digest budget itself lives in the digest module
 *  (a turn longer than it is refused honestly rather than digested in part). */
export const TALKER_DIGEST_WIRE_MAX_TEXT_CHARS = 200_000;

export function isTalkerDigestMessage(data: unknown): data is TalkerDigestMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'talker_digest' &&
    typeof msg.workerSessionId === 'string' &&
    (msg.kind === 'summary' || msg.kind === 'headlines') &&
    typeof msg.text === 'string' &&
    msg.text.length > 0 &&
    msg.text.length <= TALKER_DIGEST_WIRE_MAX_TEXT_CHARS &&
    (msg.spokenPrefix === undefined || typeof msg.spokenPrefix === 'string') &&
    (msg.runtime === undefined || msg.runtime === 'pi' || msg.runtime === 'claude' || msg.runtime === 'antigravity') &&
    (msg.requestId === undefined || typeof msg.requestId === 'string')
  );
}

// ============================================================================
// Session Context Transfer Protocol Types
// ============================================================================

export interface TransferSessionContext {
  type: 'transfer_session_context';
  sourceSessionId: string;
  targetSessionId?: string;
  createNew?: boolean;
  targetSdkType?: SdkType;
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

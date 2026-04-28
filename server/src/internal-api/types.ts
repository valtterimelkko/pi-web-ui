/**
 * Internal API Type Definitions
 *
 * These types define the HTTP API contract for programmatic consumers
 * of the Pi Web UI backend. They are purpose-built for machine-to-machine
 * communication and are distinct from the WebSocket protocol types.
 */

import type { NormalizedEvent } from '@pi-web-ui/shared';

// ─── Verbosity levels ────────────────────────────────────────────────────────

/**
 * Verbosity controls how much detail the internal API returns.
 *
 * - `answers`: Return only the final assistant text when the turn completes.
 *   The consumer sees nothing while the agent is working. Best for voice/chat
 *   apps where intermediate tool chatter would be noise.
 *
 * - `tasks`: Stream lightweight status headlines while the agent works
 *   (e.g. "Running Bash...", "Reading file...") plus the final answer. The
 *   consumer sees what's happening but not raw tool input/output. Best for
 *   chat apps that want progress feedback without overwhelming detail.
 *
 * - `full`: Stream every normalized event — tool calls, results, thinking
 *   blocks, everything. Identical to what the web UI sees. Best for custom
 *   frontends that want full rendering control.
 */
export type Verbosity = 'answers' | 'tasks' | 'full';

// ─── Session runtime ─────────────────────────────────────────────────────────

export type SessionRuntime = 'pi' | 'claude' | 'opencode';

// ─── Request types ───────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  runtime: SessionRuntime;
  cwd?: string;
  model?: string;
}

export interface SendPromptRequest {
  message: string;
  verbosity?: Verbosity;
}

// ─── Response types ──────────────────────────────────────────────────────────

export interface CreateSessionResponse {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  model?: string;
  cwd: string;
  createdAt: string;
}

export interface SessionInfo {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  cwd: string;
  model?: string;
  status: 'idle' | 'running' | 'error';
  messageCount: number;
  firstMessage: string;
  createdAt: string;
  lastActivity: string;
  pinned?: boolean;
}

export interface SessionDetail extends SessionInfo {
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  cost?: number;
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
}

export interface PromptResponse {
  sessionId: string;
  messageId?: string;
  content: string;
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  cost?: number;
  turnComplete: boolean;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  provider?: string;
  contextWindow?: number;
  aliases?: string[];
}

export interface ModelsResponse {
  models: {
    pi: ModelInfo[];
    claude: ModelInfo[];
    opencode: ModelInfo[];
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  runtimes: {
    pi: 'available' | 'unavailable';
    claude: 'available' | 'unavailable';
    opencode: 'available' | 'unavailable';
  };
  uptime: number;
  version?: string;
}

export interface ApiError {
  error: string;
  code: string;
  details?: string;
}

// ─── SSE Event Types (for verbosity=full and verbosity=tasks) ────────────────

/**
 * SSE event names used in the event stream.
 */
export const SSE_EVENT_TYPES = {
  AGENT_START: 'agent_start',
  AGENT_END: 'agent_end',
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  MESSAGE_START: 'message_start',
  MESSAGE_UPDATE: 'message_update',
  MESSAGE_END: 'message_end',
  TOOL_START: 'tool_execution_start',
  TOOL_UPDATE: 'tool_execution_update',
  TOOL_END: 'tool_execution_end',
  TASK_STATUS: 'task_status',
  ERROR: 'error',
  COMPLETE: 'complete',
} as const;

export interface SSETaskStatusEvent {
  type: 'task_status';
  toolName: string;
  summary: string;
}

// ─── Internal event observation ──────────────────────────────────────────────

export type InternalApiEventObserver = (event: NormalizedEvent) => void;

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

export type PromptMode = 'prompt' | 'follow_up' | 'steer';

// ─── Session runtime ─────────────────────────────────────────────────────────

export type SessionRuntime = 'pi' | 'claude' | 'opencode' | 'antigravity';
export type RuntimeBackendMode = 'native' | 'direct' | 'channel' | 'server' | 'subprocess';

// ─── API contract metadata ───────────────────────────────────────────────────

export const INTERNAL_API_MAJOR_VERSION = 'v1' as const;
export const INTERNAL_API_CONTRACT_VERSION = '1.0.0' as const;
export const INTERNAL_API_CONTRACT_NAME = 'pi-web-ui-internal-api' as const;
export const INTERNAL_API_CONTRACT_DOC = 'docs/INTERNAL-API-CONTRACT.md' as const;

export interface InternalApiContractInfo {
  name: typeof INTERNAL_API_CONTRACT_NAME;
  routePrefix: `/${typeof INTERNAL_API_MAJOR_VERSION}` | `/api/${typeof INTERNAL_API_MAJOR_VERSION}`;
  majorVersion: typeof INTERNAL_API_MAJOR_VERSION;
  contractVersion: typeof INTERNAL_API_CONTRACT_VERSION;
  stability: 'beta' | 'stable';
  contractDoc: typeof INTERNAL_API_CONTRACT_DOC;
}

export function getInternalApiContractInfo(
  routePrefix: InternalApiContractInfo['routePrefix'] = '/api/v1',
): InternalApiContractInfo {
  return {
    name: INTERNAL_API_CONTRACT_NAME,
    routePrefix,
    majorVersion: INTERNAL_API_MAJOR_VERSION,
    contractVersion: INTERNAL_API_CONTRACT_VERSION,
    stability: 'beta',
    contractDoc: INTERNAL_API_CONTRACT_DOC,
  };
}

// ─── Request types ───────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  runtime: SessionRuntime;
  cwd?: string;
  model?: string;
  thinkingLevel?: string;
  source?: string;
  scenarioId?: string;
  ephemeral?: boolean;
}

export interface SendPromptRequest {
  message: string;
  verbosity?: Verbosity;
  mode?: PromptMode;
}

// ─── Async / orchestration request types ─────────────────────────────────────

/**
 * Request body for POST /sessions/:id/transfer.
 *
 * Mirrors the WebSocket transfer_session_context message so the same
 * TransferService implementation can be reused.
 */
export interface TransferSessionRequest {
  /** Existing target session to receive the transcript. Mutually exclusive with createNew. */
  targetSessionId?: string;
  /** Create a fresh target session and transfer into it. */
  createNew?: boolean;
  /** Runtime for the new target session. Required when createNew is true. */
  targetRuntime?: SessionRuntime;
  /** CWD for the new target session. Defaults to source CWD when createNew. */
  targetCwd?: string;
  /** Transcript scope: recent items only, or full visible transcript. */
  scope?: 'visible_recent' | 'visible_full';
  /** Optional human-readable label for the source session in the handoff. */
  sourceDisplayName?: string;
}

export interface TransferSessionResponse {
  success: boolean;
  sourceSessionId: string;
  targetSessionId?: string;
  createdNewSession: boolean;
  targetSessionPath?: string;
  targetRuntime?: SessionRuntime;
  error?: {
    code: string;
    message: string;
  };
}

export interface BatchCreateEntry {
  runtime: SessionRuntime;
  cwd?: string;
  model?: string;
  thinkingLevel?: string;
}

export interface BatchCreateRequest {
  sessions: BatchCreateEntry[];
}

export interface BatchCreateResultItem {
  index: number;
  success: boolean;
  sessionId?: string;
  sessionPath?: string;
  runtime: SessionRuntime;
  model?: string;
  cwd?: string;
  error?: { code: string; message: string };
}

export interface BatchCreateResponse {
  created: BatchCreateResultItem[];
  createdCount: number;
  failedCount: number;
}

export interface BatchPromptEntry {
  sessionId: string;
  message: string;
}

export interface BatchPromptRequest {
  prompts: BatchPromptEntry[];
  /** When true (default), dispatch all prompts in parallel. */
  parallel?: boolean;
}

export interface BatchPromptResultItem {
  index: number;
  sessionId: string;
  success: boolean;
  content?: string;
  tokens?: { input: number; output: number; total: number };
  error?: { code: string; message: string };
}

export interface BatchPromptResponse {
  results: BatchPromptResultItem[];
  successCount: number;
  failedCount: number;
}

export interface AggregateUsageRequest {
  sessionIds: string[];
}

export interface AggregateUsageResponse {
  sessionIds: string[];
  counted: string[];
  missing: string[];
  totals: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
  perSession: Array<{
    sessionId: string;
    runtime: SessionRuntime;
    input: number;
    output: number;
    total: number;
    cost: number;
  }>;
}

export interface PendingApprovalsResponse {
  sessionId: string;
  runtime: SessionRuntime;
  status: 'idle' | 'running';
  approvals: Array<{
    requestId: string;
    toolName?: string;
    description?: string;
    args?: unknown;
    receivedAt?: number;
  }>;
  note?: string;
}

export interface WaitResponse {
  sessionId: string;
  status: 'idle' | 'running' | 'error' | 'timeout';
  waitedMs: number;
}

export interface TranscriptResponse {
  sessionId: string;
  runtime: SessionRuntime;
  scope: 'visible_recent' | 'visible_full';
  itemCount: number;
  truncated: boolean;
  items: Array<{
    kind: 'user' | 'assistant' | 'tool';
    text: string;
    timestamp?: number;
    toolName?: string;
    toolPrimaryArg?: string;
  }>;
  source: {
    sessionId: string;
    displayName: string;
    sdkType: SessionRuntime;
    cwd: string;
    createdAt?: string;
    lastActivity?: string;
  };
}

export interface SessionControlRequest {
  action: 'set_model' | 'set_thinking_level' | 'pin' | 'unpin';
  modelId?: string;
  level?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface ApprovalResponseRequest {
  approved: boolean;
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
  backendMode?: RuntimeBackendMode;
  nativeSessionId?: string;
  sessionFile?: string;
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  cost?: number;
  context?: {
    contextWindow?: number;
    used?: number;
    percent?: number;
  };
  stats?: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
  };
  lastActivityAt?: number | null;
}

export interface SessionHistoryResponse {
  sessionId: string;
  runtime: SessionRuntime;
  events: Array<Record<string, unknown>>;
}

export interface SessionControlResponse {
  success: boolean;
  action: SessionControlRequest['action'];
  modelId?: string;
  level?: string;
  pinned?: boolean;
}

export interface ApprovalResponseResult {
  success: boolean;
  approved: boolean;
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

export interface RuntimeCapabilities {
  available: boolean;
  backendMode: RuntimeBackendMode;
  supportsFollowUp: boolean;
  supportsSteer: boolean;
  supportsModelSwitch: boolean;
  supportsThinkingLevel: boolean;
  supportsPinning: boolean;
  supportsReplayHistory: boolean;
  supportsApprovals: boolean;
  supportsHeartbeat: boolean;
}

export interface CapabilitiesResponse {
  status: 'ok' | 'degraded';
  contract: InternalApiContractInfo;
  runtimes: {
    pi: RuntimeCapabilities;
    claude: RuntimeCapabilities;
    opencode: RuntimeCapabilities;
    antigravity: RuntimeCapabilities;
  };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  contract: InternalApiContractInfo;
  runtimes: {
    pi: 'available' | 'unavailable';
    claude: 'available' | 'unavailable';
    opencode: 'available' | 'unavailable';
    antigravity: 'available' | 'unavailable';
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

/**
 * Internal API Type Definitions
 *
 * These types define the HTTP API contract for programmatic consumers
 * of the Pi Web UI backend. They are purpose-built for machine-to-machine
 * communication and are distinct from the WebSocket protocol types.
 */

import type { NormalizedEvent, ScreenView } from '@pi-web-ui/shared';
import type { CommandCodeEffort as NativeCommandCodeEffort } from '../command-code/command-code-model-catalog.js';

export type CommandCodeEffort = NativeCommandCodeEffort;
export type CommandCodeModelStatus = 'runnable' | 'evidence-only' | 'unavailable';
export type CommandCodeAvailabilityStatus =
  | 'disabled'
  | 'executable_missing'
  | 'discovery_error'
  /** Retained for compatibility with older clients; no longer emitted by live discovery. */
  | 'version_mismatch'
  | 'exact_model_unavailable'
  | 'effort_capability_unknown'
  | 'available';
export interface CommandCodeCatalogueMetadata {
  availabilityStatus: CommandCodeAvailabilityStatus;
  checkedAt: string;
  source: 'live-discovery';
}

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

/** Thinking levels accepted by the contracted Internal API. */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

// ─── Session runtime ─────────────────────────────────────────────────────────

export type SessionRuntime = 'pi' | 'claude' | 'opencode' | 'antigravity' | 'commandcode';
export type RuntimeBackendMode = 'native' | 'direct' | 'channel' | 'server' | 'subprocess' | 'sdk';

// ─── API contract metadata ───────────────────────────────────────────────────

export const INTERNAL_API_MAJOR_VERSION = 'v1' as const;
export const INTERNAL_API_CONTRACT_VERSION = '1.24.0' as const;
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

export type RetentionMode = 'durable' | 'resident';

export interface RetentionLeaseRequest {
  mode: RetentionMode;
  ttlSeconds?: number;
  ownerId: string;
  label?: string;
}

export interface RetentionLeaseResponse {
  leaseId: string;
  mode: RetentionMode;
  ownerId: string;
  expiresAt: string;
}

export interface CommandCodeRoleAttestationRequest {
  role: 'conductor-root' | 'implementation-child';
  model: 'qwen/qwen3.8-max' | 'meta/muse-spark-1.2-contributor';
  effort?: CommandCodeEffort;
  cwd: string;
  worktreeRoot: string;
  leaseId: string;
  parentSessionId?: string;
  issuedAt: string;
  signature: string;
}

export interface CreateSessionRequest {
  runtime: SessionRuntime;
  cwd?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Command Code-native effort; distinct from generic thinkingLevel. */
  effort?: CommandCodeEffort;
  source?: string;
  scenarioId?: string;
  ephemeral?: boolean;
  /**
   * Pin the session at creation time so idle/timeout eviction can't clean it
   * up. Unlike a long-horizon watch, this pins with no observation machinery —
   * a "set a longer task and walk away" guarantee. The pin is time-bounded
   * (see {@link pinTtlSeconds}); see the Internal API docs for the default/max TTL.
   */
  pin?: boolean;
  /** Pin lifetime in seconds. Defaults to 24h; clamped to a hard max (7d). */
  pinTtlSeconds?: number;
  /** Required source-owned retention; failure rolls back the unused session. */
  retention?: RetentionLeaseRequest;
  /** Claude-specific: select a provider profile by ID. */
  profileId?: string;
  // TODO(remove once Agent OS drops the fields): accepted and ignored legacy role field.
  invocationRole?: 'conductor-root' | 'implementation-child';
  // TODO(remove once Agent OS drops the fields): accepted and ignored legacy attestation field.
  commandCodeAttestation?: unknown;
}

export interface SendPromptRequest {
  message: string;
  verbosity?: Verbosity;
  mode?: PromptMode;
  /**
   * Optional session-scoped idempotency key. A matching key and request
   * fingerprint reuses the existing run receipt within the documented TTL.
   */
  idempotencyKey?: string;
  /**
   * When true, follow_up requires an active streaming turn; idle sessions return
   * 409 SESSION_NOT_STREAMING instead of being promoted to a new turn.
   */
  requireActiveTurn?: boolean;
  /**
   * Fire-and-forget dispatch: run the pre-flight checks, kick off the turn, and
   * return `202 Accepted` immediately without waiting for it to complete. The
   * turn keeps running server-side; read results later via `/info` + `/transcript`.
   * Only valid with `verbosity=answers`. See the Internal API docs.
   */
  detach?: boolean;
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
  thinkingLevel?: ThinkingLevel;
  /** Command Code-native effort; distinct from generic thinkingLevel. */
  effort?: CommandCodeEffort;
  /** Pin each created session at creation time (see CreateSessionRequest.pin). */
  pin?: boolean;
  pinTtlSeconds?: number;
  /** Command Code role binding; raw permission flags are never accepted. */
  invocationRole?: 'conductor-root' | 'implementation-child';
  commandCodeAttestation?: CommandCodeRoleAttestationRequest;
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
  modelSelector?: string;
  executionInstanceId?: string;
  effort?: CommandCodeEffort;
  defaultEffort?: CommandCodeEffort;
  cwd?: string;
  pinned?: boolean;
  /** ISO timestamp of the pin's absolute expiry, when pinned. */
  pinnedUntil?: string;
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
  /** Optional session-scoped idempotency key for this batch item. */
  idempotencyKey?: string;
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
  runId?: string;
  duplicate?: boolean;
  receipt?: RunReceipt;
  error?: { code: string; message: string; reason?: string; retryAfterSeconds?: number };
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
    toolCallId: string;
    kind: 'ask_user_question';
    questions: unknown[];
    openedAt: string;
    expiresAt: string;
  }>;
  note?: string;
}

export interface WaitResponse {
  sessionId: string;
  status: 'idle' | 'running' | 'error' | 'timeout';
  waitedMs: number;
}

/** Bounded request/response read of the session event replay buffer (contract 1.24.0).
 * Returned by `GET /sessions/:id/events?mode=snapshot` — unlike the default mode
 * this always terminates, so non-streaming clients can call it safely. */
export interface SessionEventsSnapshotResponse {
  sessionId: string;
  mode: 'snapshot';
  count: number;
  events: NormalizedEvent[];
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

/**
 * Response for `GET /sessions/:id/transcript?view=screen` — a faithful,
 * read-only projection of "what the user sees by default on screen" in the
 * session (visible messages, collapsed tool cards, summarized/collapsed
 * thinking, tool groups, skill placeholders). Additive to the existing
 * transcript behaviour; requested only when `view=screen` is passed.
 *
 * The structured `screenView` is the shared projection (single source of truth
 * shared with the client); `markdown` is the rendered "text screenshot" an
 * agent can read directly. Strictly read-only: never starts a session, sends a
 * prompt, or mutates state.
 */
export interface ScreenViewResponse {
  sessionId: string;
  runtime: SessionRuntime;
  view: 'screen';
  expanded: { tools: boolean; thinking: boolean };
  screenView: ScreenView;
  markdown: string;
  source: {
    sessionId: string;
    displayName: string;
    sdkType: SessionRuntime;
    cwd: string;
    createdAt?: string;
    lastActivity?: string;
  };
}

/**
 * Compact, read-only evidence bundle for agents starting a troubleshooting
 * session from any known session identifier. The default response deliberately
 * contains metadata, locators, one bounded process-local log slice, and a
 * durable receipt summary — not prompts, transcripts, tool payloads, or the
 * global operational snapshot.
 */
export interface SessionEvidenceResponse {
  sessionId: string;
  runtime: SessionRuntime;
  aliases: {
    internalId: string;
    path: string;
    claudeSessionId?: string;
    opencodeSessionId?: string;
    antigravityConversationId?: string;
    commandCodeNativeSessionId?: string;
  };
  status: SessionInfo['status'];
  backendMode?: RuntimeBackendMode;
  model?: string;
  cwd: string;
  messageCount: number;
  createdAt: string;
  lastActivity: string;
  executionInstanceId: string;
  effort?: CommandCodeEffort;
  defaultEffort?: CommandCodeEffort;
  /** Latest run-scoped usage observed from the matching terminal result, when available. */
  tokenUsage?: RunTokenUsage;
  activity: {
    status: SessionInfo['status'];
    lastActivity: string;
  };
  sources: {
    registryPath: string;
    runtime: Record<string, string>;
    commands: string[];
    /** Command Code only: bounded journal size/event-count evidence. */
    journal?: {
      exists: boolean;
      eventCount: number;
      byteSize: number;
      maxBytes: number;
      /** Most recent read-side projection stats for this server process. */
      lastProjection?: {
        at: string;
        inputCount: number;
        outputCount: number;
        collapsed: number;
      };
    };
  };
  diagnostics: {
    processLocal: true;
    expanded: boolean;
    records: Array<{
      ts: string;
      level: string;
      component: string;
      msg: string;
      requestId?: string;
      runId?: string;
      runtime?: string;
      executionInstanceId?: string;
      phase7PolicyVersion?: 'phase7-pi-shadow/v1';
      phase7Profile?: Phase7PiShadowProfile;
      phase7ReasonCodes?: Phase7PiShadowReasonCode[];
      phase7Affinity?: 'session';
      phase7AffinitySessionId?: string;
      phase7ResourceIdentity?: 'shared-service';
      phase7ResourceBoundary?: 'pi-control-process';
      phase7SessionScoped?: false;
      phase7ToolEventCount?: number;
      phase7DurationMs?: number;
      error?: { name: string; message: string };
    }>;
  };
  receiptSummary: {
    durable: true;
    count: number;
    latest?: RunReceipt;
  };
  /** Active source-owned leases only; owner ids and labels are never exposed here. */
  retention: {
    durableLeaseCount: number;
    residentLeaseCount: number;
    latestExpiryAt?: string;
  };
  /** Current adapter materialisation, not task progress or process quiescence. */
  residency: {
    state: 'materialized' | 'not_materialized' | 'unknown';
    observedAt: string;
  };
  /** Newest three compact durable run entries, bounded independently of expand=runs. */
  runChronology: SessionRunChronologyEntry[];
  warnings: string[];
  links: {
    info: string;
    diagnostics: string;
    transcript: string;
    screen: string;
    history: string;
  };
  /** Included only when explicitly requested with `expand=transcript`. */
  transcript?: TranscriptResponse;
  /** Included only when explicitly requested with `expand=screen`. */
  screen?: ScreenViewResponse;
  /** Included only when explicitly requested with `expand=runs`. */
  runReceipts?: RunReceipt[];
  /** Recent interactive-question control events observed for this session. */
  control?: {
    askUserQuestions: Array<{
      type: 'request' | 'closed';
      requestId: string;
      toolCallId: string;
      questions?: unknown[];
      reason?: 'answered' | 'cancelled' | 'timeout' | 'aborted' | 'disconnected' | 'turn_end';
      timestamp: number;
    }>;
  };
}

export interface SessionControlRequest {
  action: 'set_model' | 'set_thinking_level' | 'set_effort' | 'pin' | 'unpin' | 'acquire_retention' | 'renew_retention' | 'release_retention';
  modelId?: string;
  level?: ThinkingLevel;
  effort?: CommandCodeEffort;
  /**
   * Pin lifetime in seconds for the `pin` action. Defaults to 24h; clamped to a
   * hard max (7d). Re-pinning extends the deadline. The granted expiry is
   * returned as `pinnedUntil` on the response.
   */
  pinTtlSeconds?: number;
  retentionLeaseId?: string;
  ownerId?: string;
  retention?: RetentionLeaseRequest;
}

export interface ApprovalResponseRequest {
  approved: boolean;
  /**
   * Structured answers for a Claude SDK `AskUserQuestion` request, keyed by
   * exact question text (multi-select answers are comma-separated). Only
   * meaningful when the requestId is a pending AskUserQuestion.
   */
  answers?: Record<string, string>;
  /** Optional per-question annotations from the user. */
  annotations?: Record<string, { preview?: string; notes?: string }>;
  /** True when the user dismissed the AskUserQuestion without answering. */
  cancelled?: boolean;
  /** Reserved for future structured approval payloads. */
  value?: unknown;
}

// ─── Response types ──────────────────────────────────────────────────────────

export interface CreateSessionResponse {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  /** Legacy create echo; profile-backed creation retains `profile:<id>` here. */
  model?: string;
  /** Canonical creation selector when it differs from the runtime model (for example profile:<id>). */
  modelSelector?: string;
  effort?: CommandCodeEffort;
  defaultEffort?: CommandCodeEffort;
  /** Configured runtime instance resolved for the created session. */
  executionInstanceId?: string;
  cwd: string;
  createdAt: string;
  /** True when the session was pinned at creation (pin:true requested). */
  pinned?: boolean;
  /** ISO timestamp of the pin's absolute expiry, when pinned. */
  pinnedUntil?: string;
  /** Why a requested pin was not granted, when pinned is false. */
  pinReason?: 'PIN_LIMIT_REACHED';
  /** Source-owned required retention lease, when requested. */
  retention?: RetentionLeaseResponse;
}

export interface SessionInfo {
  sessionId: string;
  sessionPath: string;
  runtime: SessionRuntime;
  /** Configured runtime instance that handled this session. */
  executionInstanceId: string;
  cwd: string;
  /** Effective runtime model; a profile-backed Claude session may report `sonnet`. */
  model?: string;
  /** Canonical creation selector, additive for exact profile-backed routes. */
  modelSelector?: string;
  effort?: CommandCodeEffort;
  defaultEffort?: CommandCodeEffort;
  status: 'idle' | 'running' | 'error';
  messageCount: number;
  firstMessage: string;
  createdAt: string;
  lastActivity: string;
  pinned?: boolean;
  /** ISO timestamp of an API pin's absolute expiry, when set. */
  pinnedUntil?: string;
}

export interface SessionDetail extends SessionInfo {
  backendMode?: RuntimeBackendMode;
  /** Latest run-scoped usage observed from a terminal result, when available. */
  tokenUsage?: RunTokenUsage;
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
  effort?: CommandCodeEffort;
  defaultEffort?: CommandCodeEffort;
  pinned?: boolean;
  /** ISO timestamp of the pin's absolute expiry, when pinned. */
  pinnedUntil?: string;
  /** Why a requested pin was not granted, when pinned is false. */
  pinReason?: 'PIN_LIMIT_REACHED';
  retention?: RetentionLeaseResponse;
}

export interface ApprovalResponseResult {
  success: boolean;
  approved: boolean;
  /** True when an AskUserQuestion was actually resolved by the SDK. */
  resolved?: boolean;
  kind?: 'ask_user_question';
  /** Session whose pending callback was resolved, when known. */
  sessionId?: string;
  /** Canonical requestId of the resolved question, when known. */
  requestId?: string;
  /** SDK toolUseId / toolCallId of the resolved question, when known. */
  toolCallId?: string;
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
}

export interface CapacityPressureAverage {
  avg10: number;
  avg60: number;
  avg300: number;
}

/** Response shape for GET /api/v1/capacity. Kept explicit so consumers can
 * distinguish execution admission from control, PID, host, and cgroup truth. */
export interface CapacityResponse {
  available: boolean;
  reason?: 'global_limit' | 'runtime_limit' | 'memory_pressure' | 'pid_pressure' | 'host_memory_pressure';
  activeTurns: number;
  maxActiveTurns: number;
  interactiveReserve: number;
  apiTurnLimit: number;
  controlReserve: number;
  executionCapacity: number;
  controlAvailable: boolean;
  emergencyMode: boolean;
  retryAfterSeconds: number;
  memory: {
    currentBytes: number;
    limitBytes: number;
    headroomBytes: number;
    minimumHeadroomBytes: number;
    highBytes?: number;
    source?: 'service' | 'root' | 'process-rss';
    reservedBytesPerTurn: number;
    projectedHeadroomBytes: number;
  };
  runtimes: Record<string, { activeTurns: number; maxActiveTurns: number; stalledRuns?: number }>;
  classes?: Record<string, { active: number }>;
  pids?: { current?: number; max?: number; source?: 'service' | 'root' | 'process-rss'; pressure?: boolean; reservedPidsPerTurn?: number };
  host?: {
    memAvailableBytes?: number;
    memTotalBytes?: number;
    psi?: { memory?: { some?: CapacityPressureAverage; full?: CapacityPressureAverage }; cpu?: { some?: CapacityPressureAverage; full?: CapacityPressureAverage }; io?: { some?: CapacityPressureAverage; full?: CapacityPressureAverage } };
    source?: 'host';
    hostPressure?: boolean;
    hostMinimumHeadroomBytes?: number;
    telemetryAvailable?: boolean;
  };
  memoryEvents?: { oom?: number; oomKill?: number; high?: number; source: 'service' | 'root' | 'process-rss' };
  admissionConfig?: { explicitKnobs: string[]; prodFallbackKnobs: string[] };
  stalledRuns?: number;
  quarantinedRuns?: number;
  oldestActiveRunStartedAt?: string;
  control?: { inFlight: number; queued: number };
  disposalOwners?: Record<string, number>;
}

export interface PromptResponse {
  sessionId: string;
  /** Run identity for this prompt dispatch. */
  runId: string;
  messageId?: string;
  content: string;
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  cost?: number;
  turnComplete: boolean;
  /** Requested prompt mode. */
  mode?: PromptMode;
  /** Actual dispatch mode after state-aware decisions. */
  dispatchMode?: PromptMode;
}

export type RunReceiptStatus =
  | 'accepted'
  | 'queued'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type RunStallReason = 'idle' | 'absolute';
export type RunCessationState = 'confirmed' | 'unconfirmed' | 'unknown';
export const RUN_TERMINAL_REASON_ALLOWLIST: ReadonlySet<string> = new Set(['api_error_grace']);

export type RunCessationBasis =
  | 'terminal_signal'
  | 'synthetic_terminal_signal'
  | 'documented_handler_return'
  | 'resource_quiescence'
  | 'watchdog'
  | 'server_restart'
  | 'no_terminal_signal';

/** Low-cardinality, payload-free evidence for the latest eligible run event. */
export interface RunActivityObservation {
  eventType: string;
  /** Runtime event time when valid; otherwise the server observation time. */
  occurredAt: string;
  /** Time Pi Web UI observed the event for this accepted run. */
  observedAt: string;
}

/** A terminal event observation. It annotates terminal state and never reopens it. */
export interface RunTerminalObservation {
  type: 'agent_end';
  occurredAt: string;
  observedAt: string;
  origin: 'runtime_or_adapter' | 'synthetic';
  reason?: string;
  /** True when the receipt was already terminal when this evidence arrived. */
  late: boolean;
}

export interface RunWatchdogEvidence {
  reason: RunStallReason;
  decidedAt: string;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export interface RunCessationEvidence {
  state: RunCessationState;
  basis: RunCessationBasis;
  observedAt: string;
}

/**
 * Durable, bounded liveness evidence for one accepted Internal API run.
 * It describes what Pi Web UI observed; it is not semantic task completion or
 * proof that arbitrary nested/external work has quiesced.
 */
export interface RunLivenessEvidence {
  activityPolicyVersion: 'run-activity-v1';
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  lastEligibleActivity?: RunActivityObservation;
  watchdog?: RunWatchdogEvidence;
  terminalObservations?: RunTerminalObservation[];
  cessation: RunCessationEvidence;
}

/**
 * Bounded, run-scoped provider usage. Session/context totals are deliberately
 * not interchangeable with this evidence: Command Code usage is accepted only
 * from its matching terminal result frame.
 */
export interface RunTokenUsage {
  scope: 'run';
  source: 'commandcode-terminal-result-v1';
  input: number;
  output: number;
  total: number;
}

/**
 * Payload-free evidence of normalized assistant/tool output observed for one
 * run. It distinguishes a completed run with no text from a run whose output
 * could not be classified, without judging answer quality.
 */
export interface RunOutputEvidence {
  policyVersion: 'run-output-v1';
  source: 'normalized-events-v1';
  assistantMessages: number;
  assistantTextBlocks: number;
  assistantTextChars: number;
  toolCalls: number;
  disposition: 'text' | 'no-text' | 'unknown';
}

/** Compact default session-evidence projection; full counts remain on receipts and expand=runs. */
export type SessionRunChronologyEntry = Pick<RunReceipt,
  'runId' | 'status' | 'acceptedAt' | 'startedAt' | 'agentEndAt' | 'terminalAt' | 'errorCode' | 'liveness' | 'tokenUsage'
> & { outputEvidence?: Pick<RunOutputEvidence, 'disposition'> };

/** Server-owned Phase 7 shadow profile for Pi Internal API prompts. */
export type Phase7PiShadowProfile = 'standard' | 'heavy' | 'long-horizon';

/** Bounded explanations for the shadow profile; never contains prompt text. */
export type Phase7PiShadowReasonCode =
  | 'default_standard'
  | 'message_tool_signal'
  | 'message_fork_or_memory_signal'
  | 'prompt_size_threshold'
  | 'tool_event_threshold'
  | 'turn_duration_threshold';

export interface Phase7PiShadowAffinity {
  kind: 'session';
  sessionId: string;
  ownership: 'server-owned';
}

/**
 * Honest identity for the pre-containment Pi path. It explicitly says that the
 * session is still inside the shared control process; it is not a per-session
 * cgroup or worker identity.
 */
export interface Phase7PiShadowResourceIdentity {
  kind: 'shared-service';
  boundary: 'pi-control-process';
  ownership: 'server-owned';
  sessionScoped: false;
}

export interface Phase7PiShadowEvidence {
  promptBytes: number;
  toolEventCount: number;
  durationMs?: number;
}

export interface Phase7PiShadowClassification {
  policyVersion: 'phase7-pi-shadow/v1';
  mode: 'shadow';
  profile: Phase7PiShadowProfile;
  reasonCodes: Phase7PiShadowReasonCode[];
  affinity: Phase7PiShadowAffinity;
  resourceIdentity: Phase7PiShadowResourceIdentity;
  evidence: Phase7PiShadowEvidence;
}

export interface RunReceipt {
  runId: string;
  sessionId: string;
  runtime: SessionRuntime;
  executionInstanceId: string;
  /** Effective runtime model used by the run. */
  model?: string;
  /** Canonical creation selector bound to the run, when distinct from model. */
  modelSelector?: string;
  /** Native Command Code effort binding; never mapped to thinkingLevel. */
  effort?: CommandCodeEffort;
  defaultEffort?: CommandCodeEffort;
  /** Run-scoped provider usage from the matching terminal result, when measured. */
  tokenUsage?: RunTokenUsage;
  /** Payload-free normalized-event output evidence; additive since 1.19.0. */
  outputEvidence?: RunOutputEvidence;
  /** Requested prompt mode (prompt / follow_up / steer). */
  mode?: PromptMode;
  /** Actual dispatch mode after state-aware promotion/rejection decisions. */
  dispatchMode?: PromptMode;
  status: RunReceiptStatus;
  acceptedAt: string;
  startedAt?: string;
  agentEndAt?: string;
  terminalAt?: string;
  /** Stable wire error code for failed or restart-interrupted runs. */
  errorCode?: string;
  interruptionReason?: 'server_restart';
  /** Durable, payload-free liveness and recovery evidence (contract >= 1.14.0). */
  liveness?: RunLivenessEvidence;
  /** Additive Phase 7 Pi-only shadow classification evidence. */
  phase7Shadow?: Phase7PiShadowClassification;
  /** End of the idempotency replay window, when a key was supplied. */
  idempotencyExpiresAt?: string;
}

export interface DetachedPromptResponse {
  sessionId: string;
  runId: string;
  detached: true;
  status: 'accepted';
  /** Requested prompt mode. */
  mode?: PromptMode;
  /** Actual dispatch mode after state-aware decisions. */
  dispatchMode?: PromptMode;
}

/** Response returned when a prompt retry reuses an existing idempotent run. */
export interface DuplicatePromptResponse {
  sessionId: string;
  runId: string;
  duplicate: true;
  receipt: RunReceipt;
  detached?: true;
}

export type PromptDispatchResponse = PromptResponse | DuplicatePromptResponse | DetachedPromptResponse;

export interface ModelInfo {
  id: string;
  displayName?: string;
  provider?: string;
  contextWindow?: number;
  aliases?: string[];
  /** Whether the model exposes a reasoning/thinking capability. */
  reasoning?: boolean;
  /** Whether the server permits new sessions for this discovered model. */
  runnable?: boolean;
  /** Explicit catalogue status; visibility is independent from execution authority. */
  status?: CommandCodeModelStatus;
  /** Whether the separately gated browser surface permits this model. */
  browserRunnable?: boolean;
  /** Runtime-resolved model-specific levels. Pi populates this from its SDK catalogue. */
  thinkingLevels?: string[];
  /** Command Code-native model-specific effort support. */
  supportsEffort?: boolean;
  effortLevels?: string[];
  defaultEffort?: string;
  /** Runtime catalogue freshness/source, shared by all Command Code projections. */
  catalogue?: CommandCodeCatalogueMetadata;
  /** For Claude profile entries: the backend that drives this profile. */
  backend?: 'sdk-subscription' | 'cli-direct' | 'channel';
  /** For Claude profile entries: the underlying model alias (sonnet/opus/haiku). */
  claudeModel?: string;
}

export interface ModelsResponse {
  models: {
    pi: ModelInfo[];
    claude: ModelInfo[];
    opencode: ModelInfo[];
    /** Optional Internal-API-only runtime; absent from older servers/clients. */
    commandcode?: ModelInfo[];
  };
  /** Additive runtime catalogue freshness metadata. */
  catalogueMetadata?: Partial<Record<SessionRuntime, CommandCodeCatalogueMetadata>>;
}

/** Result of POST /api/v1/models/refresh. Ids only — never any credentials. */
export interface RefreshModelsResponse {
  available: boolean;
  cacheWarmed: boolean;
  recycled: boolean;
  recycleDeferred: boolean;
  /** Pi runtime: whether the catalogue was registered into the live registry. */
  registered?: boolean;
  runningSessions: number;
  providerCount: number;
  modelCount: number;
  diff: {
    addedModels: string[];
    removedModels: string[];
    addedProviders: string[];
    removedProviders: string[];
    changed: boolean;
  };
  snapshotPath: string;
  generatedAt: string;
  /** Which runtime catalogue was refreshed. */
  runtime?: 'opencode' | 'pi';
}

export interface RuntimeCapabilities {
  available: boolean;
  /**
   * Whether the operator has enabled this runtime (e.g. OpenCode via
   * `OPENCODE_ENABLED`). Distinct from `available`: a runtime can be installed
   * and healthy yet intentionally disabled. When `enabled` is `false` the
   * runtime is advertised as unavailable and new work is refused rather than
   * silently substituted. Optional only for backward-compatible decoding;
   * responses always include it. Added in contract 1.15.0.
   */
  enabled?: boolean;
  backendMode: RuntimeBackendMode;
  supportsFollowUp: boolean;
  /** Semantics of `mode: "follow_up"` for this runtime. */
  followUpSemantics?: 'queue_while_busy' | 'new_turn';
  /** Whether the runtime can steer/interrupt an in-flight turn. */
  supportsSteerWhileBusy?: boolean;
  supportsSteer: boolean;
  supportsModelSwitch: boolean;
  supportsThinkingLevel: boolean;
  /** Native Command Code effort support; generic runtimes omit this. */
  supportsEffort?: boolean;
  /** Full discovered Command Code model projection; execution status is per model. */
  modelCatalogue?: Array<{
    id: string;
  }>;
  effortCapabilities?: Record<string, {
    supportsEffort: boolean;
    effortLevels: string[];
    defaultEffort?: string;
  }>;
  supportsPinning: boolean;
  supportsReplayHistory: boolean;
  supportsApprovals: boolean;
  supportsHeartbeat: boolean;
  /** Whether the runtime can ask the operator interactive questions mid-turn. */
  supportsInteractiveQuestions?: boolean;
  /** Whether the runtime can accept structured answers/annotations to interactive questions. */
  supportsStructuredQuestionResponse?: boolean;
}

export interface CapabilitiesResponse {
  status: 'ok' | 'degraded';
  contract: InternalApiContractInfo;
  features: {
    retentionLeases: true;
    durableRetention: true;
    residentRetention: true;
    executionAdmission: true;
    runLivenessEvidence: true;
    sessionRecoveryEvidence: true;
    capacityEndpoint: '/api/v1/capacity';
    piProviderPolicy: {
      blockedProviders: string[];
    };
  };
  runtimes: {
    pi: RuntimeCapabilities;
    claude: RuntimeCapabilities;
    opencode: RuntimeCapabilities;
    antigravity: RuntimeCapabilities;
    /** Internal-API-only runtime; older clients may ignore the additive key. */
    commandcode: RuntimeCapabilities;
  };
}

export interface RuntimeHealthEntry {
  enabled: boolean;
  available: boolean;
  backend: RuntimeBackendMode;
  /** Runtime-specific readiness detail; additive and bounded. */
  detailStatus?: string;
  version?: string;
  missingModels?: string[];
  checkStatus: 'ok' | 'unavailable' | 'error' | 'disabled';
  checkedAt: string;
  checkDurationMs: number;
  lastFailure?: { at: string; message: string };
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  contract: InternalApiContractInfo;
  runtimes: {
    pi: 'available' | 'unavailable';
    claude: 'available' | 'unavailable';
    opencode: 'available' | 'unavailable';
    antigravity: 'available' | 'unavailable';
    commandcode?: 'available' | 'unavailable';
  };
  /** Additive detailed runtime health; legacy `runtimes` remains for 1.8 clients. */
  runtimeHealth: Record<Exclude<SessionRuntime, 'commandcode'>, RuntimeHealthEntry>
    & Partial<Record<'commandcode', RuntimeHealthEntry>>;
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

// ─── Watch (long-horizon validation) ─────────────────────────────────────────

/**
 * A watch is a durable, server-side standing observer on a session. It
 * evaluates declarative conditions against the normalized event stream and
 * records every match to a disk-backed ledger that survives the observer
 * disconnecting, the session going idle, and even a server restart.
 *
 * The point is to decouple *observation* from the *observer's liveness*: a
 * headless validator can register a watch, walk away for an hour, then poll
 * `GET /sessions/:id/watch` to learn what happened while it was gone — without
 * holding an SSE connection open the whole time.
 *
 * Conditions are intentionally generic / runtime-neutral. They match against
 * the common `NormalizedEvent` shape that every runtime already emits, so a
 * watch never needs per-runtime code.
 */
export type WatchConditionType = 'event_type' | 'tool' | 'text';

export interface WatchConditionSpec {
  /** Stable id for this condition. Auto-generated (`c0`, `c1`, …) if omitted. */
  id?: string;
  /** Which kind of predicate this is. */
  type: WatchConditionType;

  // type: 'event_type'
  /** The `NormalizedEvent.type` to match, e.g. `agent_end`, `session_compaction`. */
  eventType?: string;
  /** Optional shallow equality check on the event's `data` object. */
  dataMatch?: Record<string, string | number | boolean>;

  // type: 'tool'
  /** Tool name to match, e.g. `Bash`, `Read`. */
  toolName?: string;
  /** Which tool phase to match. Defaults to `start`. */
  phase?: 'start' | 'end';
  /** Optional substring that must appear in the stringified tool args/result. */
  argIncludes?: string;

  // type: 'text'
  /** Substring to find in the text. */
  contains?: string;
  /** JS regular-expression source tested against the text. */
  pattern?: string;
  /** Flags for `pattern`. Defaults to `i`. */
  patternFlags?: string;
  /** Which text to scan: assistant output only (default), or any text the event carries. */
  source?: 'assistant' | 'any';

  /**
   * Fire only on the first match (default `true`). When `false`, every match
   * is appended to the ledger (capped to avoid unbounded growth).
   */
  once?: boolean;
}

export interface WatchConditionState {
  id: string;
  type: WatchConditionType;
  /** The resolved spec, echoed back so the caller can confirm defaults. */
  spec: WatchConditionSpec;
  fired: boolean;
  fireCount: number;
  firstFiredAt?: number;
  lastFiredAt?: number;
}

export interface WatchFiring {
  conditionId: string;
  firedAt: number;
  /** The `NormalizedEvent.type` that triggered the match. */
  eventType: string;
  /** Short human-readable evidence (truncated to ~200 chars). */
  evidence: string;
}

export interface WatchSnapshot {
  /** Last observed session status (event-derived: agent_start → running, agent_end → idle). */
  status: 'idle' | 'running';
  /** Total normalized events seen by this watch. */
  eventCount: number;
  /** Number of `tool_execution_start` events seen. */
  toolCallCount: number;
  /** Whether at least one turn has completed (an `agent_end` was seen). */
  sawAgentEnd: boolean;
  lastEventType?: string;
  lastEventAt?: number;
}

export type WatchStatus = 'active' | 'detached' | 'closed';

/**
 * Opt-in action executed when a watch condition fires. This is the
 * runtime-agnostic "wake": the watch stays an observer, and the action
 * dispatches a prompt to a *different* session (typically an idle parent
 * orchestrating the watched child). The analogue of the Pi subagent
 * extension's `sendUserMessage(..., { deliverAs: 'followUp', triggerTurn: true })`,
 * but cross-session and cross-runtime.
 */
export interface WatchOnFireAction {
  /** Only `prompt` is supported today. */
  type: 'prompt';
  /** Session to wake. Must differ from the watched session. */
  targetSessionId: string;
  /**
   * Message template for the wake prompt. Placeholders: `{{conditionId}}`,
   * `{{eventType}}`, `{{sessionId}}` (watched session), `{{firedAt}}`, and
   * `{{evidence}}` (only interpolated when `includeEvidence` is true).
   */
  message: string;
  /** Dispatch mode. `follow_up` (default) queues on a busy Pi target and prompts when idle; `prompt` refuses when busy. */
  mode?: 'prompt' | 'follow_up';
  /** Max wake dispatch attempts over the watch's life (default 1, 1-10). Counts attempts, not successes. */
  maxWakeups?: number;
  /** Minimum seconds between wake dispatch attempts (default 60, 0-3600). */
  cooldownSeconds?: number;
  /** Pin the target so idle eviction cannot kill it before the wake (default true, claim `watch-target:<watchId>`). */
  pinTarget?: boolean;
  /** Interpolate `{{evidence}}` from the firing into the message (default false; evidence is child-controlled text). */
  includeEvidence?: boolean;
}

export type WatchWakeAttemptStatus = 'pending' | 'dispatched' | 'failed' | 'suppressed';

/** Durable audit record of one wake attempt, stored in the watch ledger. */
export interface WatchWakeAttempt {
  attemptedAt: number;
  targetSessionId: string;
  status: WatchWakeAttemptStatus;
  /** Condition whose firing triggered this attempt. */
  conditionId?: string;
  /** Run receipt id when the dispatch was accepted. */
  runId?: string;
  /** Error code when `failed` (e.g. `SESSION_BUSY`, `WAKE_DISPATCH_UNAVAILABLE`). */
  errorCode?: string;
  /** Suppression reason: `max_wakeups_reached` or `cooldown`. */
  reason?: string;
}

export interface RegisterWatchRequest {
  /** Conditions to evaluate. Must be non-empty. */
  conditions: WatchConditionSpec[];
  /**
   * Pin the subject session so idle/timeout eviction can't kill it while the
   * watch is running and the validator is asleep. Defaults to `true`.
   */
  pin?: boolean;
  /** Optional human-readable label for the watch. */
  label?: string;
  /**
   * Optional wake action executed when a condition fires. Opt-in: without
   * this the watch remains a pure observer.
   */
  onFire?: WatchOnFireAction;
}

export interface WatchResponse {
  watchId: string;
  sessionId: string;
  runtime: SessionRuntime;
  label?: string;
  /**
   * `active` — live broker subscription attached.
   * `detached` — ledger restored from disk but no live subscription (e.g. after
   *   a server restart, or the session no longer exists). Past firings are still
   *   readable; new ones won't be recorded until re-registered.
   * `closed` — explicitly torn down.
   */
  status: WatchStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  conditions: WatchConditionState[];
  /** Append-only ledger of every condition match recorded. */
  firings: WatchFiring[];
  /** `firings.length` — lets a poller compute the next `sinceIndex`. */
  firingCount: number;
  /** Ids of conditions that have not yet fired. */
  pendingConditionIds: string[];
  /** True once every condition has fired at least once. */
  allFired: boolean;
  /** Echoed wake action when one was registered. */
  onFire?: WatchOnFireAction;
  /** Durable audit of every wake attempt (dispatched, failed, suppressed). */
  wakeAttempts: WatchWakeAttempt[];
  snapshot: WatchSnapshot;
}

export interface DeleteWatchResponse {
  success: boolean;
  watchId?: string;
}

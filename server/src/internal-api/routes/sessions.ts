/**
 * Internal API: Session Routes
 *
 * Handles session CRUD, prompt execution, control operations, replay access,
 * and approval responses for all three runtimes.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { projectDefaultViewFromEvents, renderScreenViewMarkdown } from '@pi-web-ui/shared';
import { detectPromptInjection } from '../../security/prompt-injection.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { AntigravityService } from '../../antigravity/antigravity-service.js';
import type { MultiSessionManager } from '../../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../../session-registry.js';
import type { RegistryEntry } from '../../session-registry.js';
import type { PiService } from '../../pi/pi-service.js';
import { CommandCodeRuntimeError, type CommandCodeService } from '../../command-code/command-code-service.js';
import { commandCodeEventsToScreenEvents } from '../../command-code/command-code-event-adapter.js';
import type { CommandCodeRoleAttestation } from '../../command-code/command-code-role-attestation.js';
import type { CommandCodeInternalSessionRecord } from '../../command-code/command-code-session-store.js';
import type {
  CreateSessionRequest,
  SendPromptRequest,
  CreateSessionResponse,
  SessionInfo,
  SessionDetail,
  SessionHistoryResponse,
  SessionEvidenceResponse,
  SessionControlResponse,
  ApprovalResponseResult,
  ListSessionsResponse,
  PromptResponse,
  DuplicatePromptResponse,
  DetachedPromptResponse,
  RunReceipt,
  Verbosity,
  PromptMode,
  SessionRuntime,
  SessionControlRequest,
  ApprovalResponseRequest,
  TransferSessionRequest,
  TransferSessionResponse,
  BatchCreateRequest,
  BatchCreateEntry,
  BatchCreateResponse,
  BatchCreateResultItem,
  BatchPromptRequest,
  BatchPromptResponse,
  BatchPromptResultItem,
  AggregateUsageRequest,
  AggregateUsageResponse,
  PendingApprovalsResponse,
  WaitResponse,
  TranscriptResponse,
  ScreenViewResponse,
  RegisterWatchRequest,
  Phase7PiShadowProfile,
  Phase7PiShadowReasonCode,
} from '../types.js';
import { isThinkingLevel } from '../types.js';
import { InternalApiEventBroker } from '../event-broker.js';
import { WatchManager, WatchValidationError } from '../watch/watch-manager.js';
import { PinExpiryManager, type ApplyPinResult } from '../pin-expiry-manager.js';
import {
  IdempotencyKeyValidationError,
  RunReceiptManager,
} from '../run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../run-receipts/run-receipt-store.js';
import { resolveExecutionInstanceId } from '../execution-instance.js';
import { classifyPhase7PiShadow } from '../phase7-pi-shadow.js';
import {
  createEventCollector,
  collectAnswerEvent,
  writeTaskEvent,
  writeFullEvent,
} from '../event-filter.js';
import { createSSEStream } from '../sse-stream.js';
import { ErrorCode, enrichedErrorBody } from '../error-codes.js';
import { readBoundedJsonBody as readJsonBody } from '../request-body.js';
import {
  createSessionBodySchema,
  batchCreateBodySchema,
  batchPromptBodySchema,
  mapWithConcurrency,
  BATCH_CONCURRENCY_LIMIT,
  sessionControlBodySchema,
} from '../session-validation.js';
import { withCorrelation, newRequestId, getCorrelationContext } from '../../logging/correlation.js';
import { TransferService } from '../../session-transfer/transfer-service.js';
import {
  extractPiTranscript,
  extractClaudeTranscript,
  extractOpenCodeTranscript,
  piSessionToReplayEvents,
  replayEventsToVisibleItems,
} from '../../session-transfer/index.js';
import type { VisibleTranscript } from '../../session-transfer/types.js';
import { stat, readdir, unlink, rm } from 'fs/promises';

import path from 'path';
import os from 'os';
import { config } from '../../config.js';
import { createLogger, type LogRecord } from '../../logging/logger.js';
import { getRecentLogs } from '../diagnostics-buffer.js';
import { AdmissionCapacityError, AdmissionController } from '../admission-controller.js';
import { BoundedControlLane, ControlLaneFullError } from '../control-lane.js';
import { SessionDisposalRegistry } from '../session-disposal.js';
import { RuntimeOpError } from './batch-helpers.js';
import {
  assertPiModelAllowed,
  assertResolvedPiModelAllowed,
  blockedPiProvider,
  PiProviderNotAllowedError,
} from '../pi-provider-policy.js';

const logger = createLogger('InternalAPI');

const EVIDENCE_DEFAULT_LIMIT = 10;
const EVIDENCE_MAX_LIMIT = 50;
const EVIDENCE_DEFAULT_MAX_BYTES = 4_900;
const EVIDENCE_EXPANSIONS = new Set(['diagnostics', 'transcript', 'screen', 'runs']);

function parseEvidenceExpansions(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((value) => value.trim()).filter((value) => EVIDENCE_EXPANSIONS.has(value)));
}

function parseEvidenceLimit(raw: string | null): number {
  const parsed = raw === null ? EVIDENCE_DEFAULT_LIMIT : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return EVIDENCE_DEFAULT_LIMIT;
  return Math.min(EVIDENCE_MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

class TurnStalledError extends Error {
  constructor() {
    super('Accepted run stalled before a terminal runtime event');
    this.name = 'TurnStalledError';
  }
}

function isRuntimeAlreadyRunningError(error: Error): boolean {
  return /session is already running/i.test(error.message);
}

function runtimeErrorCode(error: Error, runtime: SessionRuntime): ErrorCode {
  if (runtime !== 'commandcode') {
    return error instanceof TurnStalledError ? ErrorCode.TURN_STALLED : ErrorCode.RUNTIME_ERROR;
  }
  if (error instanceof CommandCodeRuntimeError) {
    switch (error.code) {
      case 'auth_required': return ErrorCode.COMMANDCODE_AUTH_REQUIRED;
      case 'rate_limited': return ErrorCode.COMMANDCODE_RATE_LIMITED;
      case 'network_failure': return ErrorCode.COMMANDCODE_NETWORK_FAILURE;
      case 'provider_failure': return ErrorCode.COMMANDCODE_PROVIDER_FAILURE;
      case 'credits': return ErrorCode.COMMANDCODE_CREDITS;
      case 'max_turns': return ErrorCode.COMMANDCODE_MAX_TURNS;
      case 'no_response': return ErrorCode.COMMANDCODE_NO_RESPONSE;
      case 'protocol_error': return ErrorCode.COMMANDCODE_PROTOCOL_ERROR;
      case 'interrupted': return ErrorCode.RUNTIME_ERROR;
      case 'permission_denied': return ErrorCode.COMMANDCODE_ROLE_REFUSED;
      case 'effort_unsupported': return ErrorCode.COMMANDCODE_EFFORT_UNSUPPORTED;
      default: return ErrorCode.RUNTIME_ERROR;
    }
  }
  return ErrorCode.RUNTIME_ERROR;
}

function compactEvidenceText(value: string, knownPrompt?: string, maxLength = 320): string {
  let result = value;
  if (knownPrompt && knownPrompt.length > 0) {
    result = result.split(knownPrompt).join('[PROMPT_REDACTED]');
  }
  return result.length > maxLength ? `${result.slice(0, maxLength)}…` : result;
}

const PHASE7_SHADOW_PROFILES = new Set<Phase7PiShadowProfile>(['standard', 'heavy', 'long-horizon']);
const PHASE7_SHADOW_REASON_CODES = new Set<Phase7PiShadowReasonCode>([
  'default_standard',
  'message_tool_signal',
  'message_fork_or_memory_signal',
  'prompt_size_threshold',
  'tool_event_threshold',
  'turn_duration_threshold',
]);

function compactPhase7DiagnosticFields(
  record: LogRecord,
): Partial<SessionEvidenceResponse['diagnostics']['records'][number]> {
  const fields: Partial<SessionEvidenceResponse['diagnostics']['records'][number]> = {};
  if (record.phase7PolicyVersion === 'phase7-pi-shadow/v1') fields.phase7PolicyVersion = record.phase7PolicyVersion;
  if (typeof record.phase7Profile === 'string' && PHASE7_SHADOW_PROFILES.has(record.phase7Profile as Phase7PiShadowProfile)) {
    fields.phase7Profile = record.phase7Profile as Phase7PiShadowProfile;
  }
  if (
    Array.isArray(record.phase7ReasonCodes)
    && record.phase7ReasonCodes.length > 0
    && record.phase7ReasonCodes.length <= 8
    && record.phase7ReasonCodes.every((reason): reason is Phase7PiShadowReasonCode => (
      typeof reason === 'string' && PHASE7_SHADOW_REASON_CODES.has(reason as Phase7PiShadowReasonCode)
    ))
  ) {
    fields.phase7ReasonCodes = [...record.phase7ReasonCodes];
  }
  if (record.phase7Affinity === 'session') fields.phase7Affinity = record.phase7Affinity;
  if (typeof record.phase7AffinitySessionId === 'string' && record.phase7AffinitySessionId.length > 0) {
    fields.phase7AffinitySessionId = compactEvidenceText(record.phase7AffinitySessionId, undefined, 128);
  }
  if (record.phase7ResourceIdentity === 'shared-service') fields.phase7ResourceIdentity = record.phase7ResourceIdentity;
  if (record.phase7ResourceBoundary === 'pi-control-process') fields.phase7ResourceBoundary = record.phase7ResourceBoundary;
  if (record.phase7SessionScoped === false) fields.phase7SessionScoped = false;
  const toolEventCount = record.phase7ToolEventCount;
  if (typeof toolEventCount === 'number' && Number.isSafeInteger(toolEventCount) && toolEventCount >= 0 && toolEventCount <= 10_000) {
    fields.phase7ToolEventCount = toolEventCount;
  }
  const durationMs = record.phase7DurationMs;
  if (typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= 7 * 24 * 60 * 60 * 1000) {
    fields.phase7DurationMs = durationMs;
  }
  return fields;
}

function extractQuestionControlEvents(events: NormalizedEvent[]): NonNullable<SessionEvidenceResponse['control']>['askUserQuestions'] {
  const toolCallByRequest = new Map<string, string>();
  const result: NonNullable<SessionEvidenceResponse['control']>['askUserQuestions'] = [];
  const closeReasons = new Set(['answered', 'cancelled', 'timeout', 'aborted', 'disconnected', 'turn_end']);
  for (const event of events) {
    if (event.type !== 'ask_user_question_request' && event.type !== 'ask_user_question_closed') continue;
    const data = event.data as Record<string, unknown>;
    const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
    const explicitToolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
    if (!requestId) continue;
    if (explicitToolCallId) toolCallByRequest.set(requestId, explicitToolCallId);
    const toolCallId = explicitToolCallId ?? toolCallByRequest.get(requestId);
    if (!toolCallId) continue;
    if (event.type === 'ask_user_question_request') {
      result.push({
        type: 'request', requestId, toolCallId,
        ...(Array.isArray(data.questions) ? { questions: data.questions } : {}),
        timestamp: event.timestamp,
      });
    } else {
      const reason = typeof data.reason === 'string' && closeReasons.has(data.reason)
        ? data.reason as 'answered' | 'cancelled' | 'timeout' | 'aborted' | 'disconnected' | 'turn_end'
        : undefined;
      result.push({ type: 'closed', requestId, toolCallId, ...(reason ? { reason } : {}), timestamp: event.timestamp });
    }
  }
  return result;
}

function compactDiagnosticRecord(
  record: LogRecord,
  knownPrompt?: string,
  messageLimit = 320,
): SessionEvidenceResponse['diagnostics']['records'][number] {
  return {
    ts: record.ts,
    level: record.level,
    component: record.component,
    msg: compactEvidenceText(record.msg, knownPrompt, messageLimit),
    ...(record.requestId ? { requestId: record.requestId } : {}),
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.runtime ? { runtime: record.runtime } : {}),
    ...(record.executionInstanceId ? { executionInstanceId: record.executionInstanceId } : {}),
    ...compactPhase7DiagnosticFields(record),
    ...(record.error
      ? {
          error: {
            name: compactEvidenceText(record.error.name, knownPrompt, 120),
            message: compactEvidenceText(record.error.message, knownPrompt, messageLimit),
          },
        }
      : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function logPhase7Shadow(runId: string, shadow: NonNullable<RunReceipt['phase7Shadow']>): void {
  logger.child({
    runId,
    sessionId: shadow.affinity.sessionId,
    phase7PolicyVersion: shadow.policyVersion,
    phase7Profile: shadow.profile,
    phase7ReasonCodes: shadow.reasonCodes,
    phase7Affinity: shadow.affinity.kind,
    phase7AffinitySessionId: shadow.affinity.sessionId,
    phase7ResourceIdentity: shadow.resourceIdentity.kind,
    phase7ResourceBoundary: shadow.resourceIdentity.boundary,
    phase7SessionScoped: shadow.resourceIdentity.sessionScoped,
    phase7ToolEventCount: shadow.evidence.toolEventCount,
    ...(shadow.evidence.durationMs !== undefined ? { phase7DurationMs: shadow.evidence.durationMs } : {}),
  }).info(`[Phase7Shadow] ${runId} profile=${shadow.profile}`);
}


export interface SessionRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
  multiSessionManager: MultiSessionManager;
  sessionRegistry: SessionRegistryManager;
  piService: PiService;
  /** Internal API client ID prefix for Pi SDK sessions */
  internalClientId: string;
  /** Directory for durable watch ledgers (long-horizon validation). */
  watchDir: string;
  /** Optional durable run-receipt manager. Direct route tests use an in-memory fallback. */
  runReceiptManager?: RunReceiptManager;
  /** Directory for durable run receipts when no manager is injected. */
  runReceiptDir?: string;
  /** Idempotency replay window for a newly accepted run. */
  runReceiptIdempotencyTtlMs?: number;
  /** Directory for the durable API-pin expiry ledger. Optional: when absent, pin
   * requests still pin in-memory but are not time-bounded/tracked (used by some unit tests). */
  pinDir?: string;
  /** Default API-pin lifetime (ms). Defaults to 24h. */
  pinDefaultTtlMs?: number;
  /** Hard maximum API-pin lifetime (ms). Defaults to 7d. */
  pinMaxTtlMs?: number;
  /** How often the pin-expiry sweep runs (ms). */
  pinExpiryIntervalMs?: number;
  /** Callback to notify WebSocket clients of new sessions */
  onSessionCreated?: (sessionId: string, sessionPath: string, runtime: string) => void;
  /** Directory for Pi session files. Defaults to config. */
  piSessionDir?: string;
  /** Directory for Claude session JSONL files. Defaults to config. */
  claudeSessionDir?: string;
  /** Directory for Antigravity session JSONL/log files. Defaults to config. */
  antigravitySessionDir?: string;
  /** Shared process-local execution admission authority. */
  admissionController?: AdmissionController;
  /** Optional bounded control lane for P0/P1 handlers (defaults to a bounded instance). */
  controlLane?: BoundedControlLane;
  /** Optional per-session disposal registry (defaults to a new instance). */
  disposal?: SessionDisposalRegistry;
  /** Pi providers denied for Internal API agent execution. */
  blockedPiProviders?: readonly string[];
  /** Feature-gated server-local Command Code runtime. */
  commandCodeService?: CommandCodeService;
}

export function createSessionRoutes(deps: SessionRoutesDeps) {
  const {
    claudeService,
    opencodeService,
    antigravityService,
    multiSessionManager,
    sessionRegistry,
    piService,
    internalClientId,
    onSessionCreated,
  } = deps;
  const commandCodeService = deps.commandCodeService;

  const claudeSessionDir = deps.claudeSessionDir ?? config.claudeSessionDir;
  const antigravitySessionDir = deps.antigravitySessionDir ?? config.antigravitySessionDir;
  const blockedPiProviders = deps.blockedPiProviders ?? config.internalApiBlockedPiProviders;
  const runReceipts = deps.runReceiptManager ?? new RunReceiptManager({
    store: new RunReceiptStore(deps.runReceiptDir),
    idempotencyTtlMs: deps.runReceiptIdempotencyTtlMs,
  });
  // Priority model (server-derived; callers cannot self-declare a class):
  //   P0 — human/browser prompts: enter via WebSocket and are bounded per-session
  //        (one active turn per WS session) and by the runtime's maxSessions cap;
  //        they do NOT go through this Internal API arbiter. The arbiter's role re:
  //        P0 is to cap P2/P3 so the shared service keeps capacity for the browser.
  //        CAVEAT: Phase 4 preserves GLOBAL service slack for P0 but does NOT
  //        guarantee runtime-specific P0 admission under same-runtime P2/P3
  //        saturation (P2/P3 share the runtime's maxSessions); per-runtime priority
  //        isolation is Phase 6.
  //   P1 — Agent OS control operations (cancel, evidence, run-receipt, session
  //        control, approval response, delete): run through the bounded controlLane
  //        (concurrency cap + queue), NOT execution admission, so P2/P3 saturation
  //        cannot block them at the admission layer.
  //   P2 — ordinary Internal API prompt execution: acquires below, bounded by
  //        executionCapacity (= maxActiveTurns - controlReserve).
  //   P3 — server/config-assigned bulk work.
  // SCOPE: this caps P2/P3 execution capacity and bounds control concurrency. It
  // does NOT, by itself, protect control from shared-resource contention (event
  // loop, memory, sockets) caused by in-flight P2 turns — that requires process
  // isolation (Phase 6 per-session cgroups).
  const admission = deps.admissionController ?? new AdmissionController();
  // Bounded control lane (P0/P1 guardrail): control operations bypass execution
  // admission but are NOT unbounded — this caps concurrent control-handler
  // executions and queues excess (up to a timeout), so a control flood cannot
  // monopolise the shared event loop/memory/sockets that P0/P1 also depend on.
  // maxConcurrent=8 is sized well above the expected control-op rate (cancel/
  // evidence/receipt/control/approval/delete are lightweight read/state ops);
  // maxQueued=16 bounds a flood with fail-fast 503 + Retry-After. Both tunable
  // via deps.controlLane. (emergency/control ops bypass execution admission but
  // must NOT be unbounded — this lane is their guardrail.)
  const controlLane = deps.controlLane ?? new BoundedControlLane(8, 5000, 16);
  // Per-session disposal registry: every per-session resource (queued-run
  // correlations, observers, timers, snapshots, drain handles) registers a
  // dispose handle here so handleDeleteSession and shutdown tear them all down
  // in one place, and late callbacks are tombstoned. This is the ownership seam
  // that prevents deleted sessions from leaving live timers/queues/observers.
  const disposal = deps.disposal ?? new SessionDisposalRegistry();
  // A synchronous, process-local claim closes the gap between the liveness
  // pre-flight and runtime dispatch when two Internal API callers race.
  const activeDirectDispatchTokens = new Map<string, number>();
  const nextDirectDispatchToken = new Map<string, number>();
  interface QueuedPiRunCorrelation {
    runId: string;
    message: string;
    delivered: boolean;
    awaitingMessageStart: boolean;
    queueIndex?: number;
    sessionPath: string;
  }
  const queuedPiRuns = new Map<string, QueuedPiRunCorrelation[]>();
  const queuedPiObservers = new Map<string, (event: unknown) => void>();
  const queuedPiEventChains = new Map<string, Promise<void>>();
  const queuedPiLastFollowUp = new Map<string, string[]>();
  const queuedRunDisposalRegistered = new Set<string>();

  function claimDirectDispatch(sessionId: string): { token: number; release: () => void } | undefined {
    if (activeDirectDispatchTokens.has(sessionId)) return undefined;
    const token = (nextDirectDispatchToken.get(sessionId) ?? 0) + 1;
    nextDirectDispatchToken.set(sessionId, token);
    activeDirectDispatchTokens.set(sessionId, token);
    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        if (activeDirectDispatchTokens.get(sessionId) === token) activeDirectDispatchTokens.delete(sessionId);
      },
    };
  }

  /**
   * Per-session event broker. Long-lived: subscribers added via
   * `GET /sessions/:id/events` persist across prompts and across clients.
   * Every Internal-API prompt path publishes events here so any open
   * subscriber sees them in real time.
   */
  const broker = new InternalApiEventBroker({
    replayBufferSize: 100,
    // Deletion fence: once a session is tombstoned in the disposal registry,
    // a late runtime event cannot recreate the broker replay buffer or notify
    // subscribers. The predicate is keyed on the broker key, which for Pi is
    // the sessionPath — handleDeleteSession tombstones that alias too.
    isSessionDisposed: (key) => disposal.isDisposed(key),
  });

  /** Track Pi/OpenCode sessions we have already attached a long-lived observer to. */
  const piObservedSessions = new Set<string>();
  const opencodeObservedSessions = new Set<string>();
  /**
   * The exact long-lived broker-feeding callback attached for a session, keyed
   * by the broker key (Pi: sessionPath; OpenCode: sessionId). Retained so
   * handleDeleteSession can remove the precise callback on unload/delete instead
   * of leaking it (and its idempotency key) for the process lifetime.
   */
  const piObserverByPath = new Map<string, (event: unknown) => void>();
  const opencodeObserverById = new Map<string, (event: NormalizedEvent) => void>();

  /**
   * Attach a long-lived api observer to a Pi session so events emitted by
   * ANY client (not just the Internal API) flow into the broker. Safe to
   * call repeatedly; idempotent.
   */
  function attachPiObserverIfNeeded(sessionPath: string): void {
    if (piObservedSessions.has(sessionPath)) return;
    const observer = (event: unknown) => {
      try {
        broker.publish(sessionPath, event as NormalizedEvent);
      } catch {
        /* non-fatal */
      }
    };
    try {
      multiSessionManager.addApiObserver(sessionPath, observer);
      piObservedSessions.add(sessionPath);
      piObserverByPath.set(sessionPath, observer);
      // Own the observer teardown in the disposal registry (broker key = path)
      // so handleDeleteSession/shutdown detach it, not just the manual path.
      disposal.register(sessionPath, 'pi-broker-observer', () => {
        multiSessionManager.removeApiObserver?.(sessionPath, observer);
        piObserverByPath.delete(sessionPath);
        piObservedSessions.delete(sessionPath);
      });
    } catch {
      /* session may not be loaded yet; retry on next prompt */
    }
  }

  /**
   * Attach a long-lived observer to an OpenCode session so plugin-driven turns
   * (for example goal-engine auto-continuations started inside OpenCode rather
   * than through this API) still flow into the broker and durable watches.
   */
  function attachOpenCodeObserverIfNeeded(sessionId: string): void {
    if (opencodeObservedSessions.has(sessionId)) return;
    const observer = (event: NormalizedEvent) => {
      try {
        broker.publish(sessionId, event);
      } catch {
        /* non-fatal */
      }
    };
    try {
      opencodeService.addApiObserver(sessionId, observer);
      opencodeObservedSessions.add(sessionId);
      opencodeObserverById.set(sessionId, observer);
      // Own the observer teardown in the disposal registry (broker key = id).
      disposal.register(sessionId, 'opencode-broker-observer', () => {
        opencodeService.removeApiObserver?.(sessionId, observer);
        opencodeObserverById.delete(sessionId);
        opencodeObservedSessions.delete(sessionId);
      });
    } catch {
      /* session may not be loaded yet; retry on next prompt/watch */
    }
  }

  /** Pin a session via the right runtime service. Used by watch registration. */
  async function pinSessionById(sessionId: string, claimId = 'web-ui'): Promise<boolean> {
    const commandCodeEntry = await commandCodeService?.getSession(sessionId);
    if (commandCodeEntry) return commandCodeService?.pinSession(sessionId, claimId) ?? false;
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return false;
    if (entry.sdkType === 'claude') return claudeService.pinSession(sessionId, claimId);
    if (entry.sdkType === 'opencode') return opencodeService.pinSession(sessionId, claimId);
    if (entry.sdkType === 'antigravity') return antigravityService.pinSession(sessionId, claimId);
    return multiSessionManager.pinSession(entry.path, claimId);
  }

  /** Revoke one source-owned runtime claim via the right service. */
  async function unpinSessionById(sessionId: string, claimId = 'web-ui'): Promise<boolean> {
    const commandCodeEntry = await commandCodeService?.getSession(sessionId);
    if (commandCodeEntry) return commandCodeService?.unpinSession(sessionId, claimId) ?? false;
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return false;
    if (entry.sdkType === 'claude') return claudeService.unpinSession(sessionId, claimId);
    if (entry.sdkType === 'opencode') return opencodeService.unpinSession(sessionId, claimId);
    if (entry.sdkType === 'antigravity') return antigravityService.unpinSession(sessionId, claimId);
    return multiSessionManager.unpinSession(entry.path, claimId);
  }

  function isSessionPinnedByEntry(entry: RegistryEntry): boolean {
    if (entry.sdkType === 'claude') return claudeService.isSessionPinned(entry.id);
    if (entry.sdkType === 'opencode') return opencodeService.isSessionPinned(entry.id);
    if (entry.sdkType === 'antigravity') return antigravityService.isSessionPinned(entry.id);
    return multiSessionManager.isSessionPinned(entry.path);
  }

  /**
   * Long-horizon watch manager. Subscribes to the same broker the prompt and
   * `/events` paths feed, so a watch records condition firings to a durable
   * ledger regardless of whether any client is connected.
   */
  const watchManager = new WatchManager({
    broker,
    storeDir: deps.watchDir,
    pinSession: pinSessionById,
    unpinSession: unpinSessionById,
  });

  /**
   * API-pin expiry manager. Owns the time-bounded pin lifecycle for sessions
   * pinned through this API (create-time `pin:true` or `control {action:"pin"}`).
   * Only constructed when a pin directory is configured; otherwise pin requests
   * fall back to direct in-memory pinning (no TTL tracking).
   */
  const pinExpiry = deps.pinDir
    ? new PinExpiryManager({
        dir: deps.pinDir,
        pin: pinSessionById,
        unpin: unpinSessionById,
        defaultTtlMs: deps.pinDefaultTtlMs,
        maxTtlMs: deps.pinMaxTtlMs,
        intervalMs: deps.pinExpiryIntervalMs,
        logger: (message) => logger.info(`[InternalAPI/PinExpiry] ${message}`),
      })
    : undefined;
  const ready = pinExpiry
    ? pinExpiry.init().then(() => pinExpiry.start())
    : Promise.resolve();

  async function shutdown(): Promise<void> {
    await ready.catch(() => { /* startup surfaces the original initialization error */ });
    pinExpiry?.stop();
    await runReceipts.shutdown();
    disposal.disposeAll();
  }

  /** Pin without TTL tracking — the fallback when no PinExpiryManager exists. */
  async function pinWithoutExpiry(sessionId: string): Promise<ApplyPinResult> {
    const ok = await pinSessionById(sessionId, 'internal-api:legacy-untracked');
    return ok ? { pinned: true } : { pinned: false, reason: 'PIN_LIMIT_REACHED' };
  }

  /** ISO deadline for a session's API pin, when tracked. */
  function apiPinDeadline(sessionId: string): string | undefined {
    const ms = pinExpiry?.getPinnedUntil(sessionId);
    return ms ? new Date(ms).toISOString() : undefined;
  }

  function currentRunModel(entry: RegistryEntry): string | undefined {
    if (entry.sdkType !== 'pi') return entry.model;
    const currentModel = multiSessionManager.getAgentSession(entry.path)?.model;
    return currentModel ? `${currentModel.provider}/${currentModel.id}` : entry.model;
  }

  function piProviderPolicyError(entry: RegistryEntry): PiProviderNotAllowedError | undefined {
    if (entry.sdkType !== 'pi') return undefined;
    const provider = blockedPiProvider(currentRunModel(entry), blockedPiProviders);
    return provider ? new PiProviderNotAllowedError(provider) : undefined;
  }

  function sendPiProviderPolicyError(res: ServerResponse, error: PiProviderNotAllowedError): void {
    sendJson(res, 403, enrichedErrorBody(ErrorCode.PROVIDER_NOT_ALLOWED, error.message));
  }

  function withPiModelLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return typeof piService.withSessionModelLock === 'function'
      ? piService.withSessionModelLock(sessionId, operation)
      : operation();
  }

  function acquirePiModelLock(sessionId: string): Promise<() => void> {
    return typeof piService.acquireSessionModelLock === 'function'
      ? piService.acquireSessionModelLock(sessionId)
      : Promise.resolve(() => undefined);
  }

  function modelSelectorForEntry(entry: RegistryEntry): string | undefined {
    return entry.sdkType === 'claude' && entry.claudeProfileId
      ? `profile:${entry.claudeProfileId}`
      : undefined;
  }

  function commandCodeRequestedEffort(record: CommandCodeInternalSessionRecord): CommandCodeInternalSessionRecord['effort'] {
    return record.effortSource === 'explicit' ? record.effort : undefined;
  }

  function commandCodeSessionInfo(record: CommandCodeInternalSessionRecord): SessionInfo {
    return {
      sessionId: record.sessionId,
      sessionPath: record.sessionId,
      runtime: 'commandcode',
      executionInstanceId: record.executionInstanceId,
      cwd: record.cwd,
      model: record.modelSelector,
      modelSelector: record.modelSelector,
      invocationRole: record.invocationRole,
      effort: record.effort,
      requestedEffort: commandCodeRequestedEffort(record),
      acceptedEffort: record.effort,
      effortSource: record.effortSource,
      defaultEffort: record.defaultEffort,
      effectiveEffort: record.effectiveEffort,
      effortEvidenceMethod: record.effortEvidenceMethod,
      effortCapabilityHash: record.effortCapabilityHash,
      status: record.state === 'running' ? 'running' : record.state === 'failed' || record.state === 'aborted' ? 'error' : 'idle',
      messageCount: record.messageCount,
      firstMessage: record.firstMessage,
      createdAt: record.createdAt,
      lastActivity: record.updatedAt,
    };
  }

  async function commandCodeSessionDetail(record: CommandCodeInternalSessionRecord): Promise<SessionDetail> {
    await runReceipts.init();
    const latest = runReceipts.listBySession(record.sessionId)
      .sort((a, b) => Date.parse(b.terminalAt ?? b.acceptedAt) - Date.parse(a.terminalAt ?? a.acceptedAt))[0];
    return {
      ...commandCodeSessionInfo(record),
      backendMode: 'subprocess',
      nativeSessionId: record.nativeSessionId,
      status: record.state === 'running' ? 'running' : record.state === 'failed' || record.state === 'aborted' ? 'error' : 'idle',
      ...(latest?.tokenUsage ? { tokenUsage: latest.tokenUsage } : {}),
    };
  }

  async function cleanupRejectedCreatedSession(sessionId: string): Promise<void> {
    if (await commandCodeService?.getSession(sessionId)) {
      await commandCodeService?.deleteSession(sessionId);
      return;
    }
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return;
    if (entry.sdkType === 'claude') claudeService.abort(sessionId);
    if (entry.sdkType === 'opencode') opencodeService.disposeSession(sessionId);
    if (entry.sdkType === 'antigravity') antigravityService.disposeSession(sessionId);
    if (entry.sdkType === 'pi') multiSessionManager.disposeLoadedSession(entry.path);
    await deleteSessionFiles(entry);
    await sessionRegistry.delete(sessionId);
  }

  function evidenceStatus(entry: RegistryEntry): SessionInfo['status'] {
    try {
      const running = entry.sdkType === 'pi'
        ? ['busy', 'streaming'].includes(multiSessionManager.getSessionStatus(entry.path)?.status ?? '')
        : entry.sdkType === 'claude'
          ? claudeService.isRunning(entry.id)
          : entry.sdkType === 'opencode'
            ? opencodeService.isRunning(entry.id)
            : antigravityService.isRunning(entry.id);
      return running ? 'running' : entry.status;
    } catch {
      return entry.status;
    }
  }

  function evidenceRetention(sessionId: string): SessionEvidenceResponse['retention'] {
    const now = Date.now();
    const leases = (pinExpiry?.listLeases(sessionId) ?? []).filter((lease) => lease.pinnedUntil > now);
    const expiries = leases.map((lease) => lease.pinnedUntil);
    return {
      durableLeaseCount: leases.filter((lease) => (lease.mode ?? 'resident') === 'durable').length,
      residentLeaseCount: leases.filter((lease) => (lease.mode ?? 'resident') === 'resident').length,
      ...(expiries.length ? { latestExpiryAt: new Date(Math.max(...expiries)).toISOString() } : {}),
    };
  }

  function evidenceResidency(entry: RegistryEntry): SessionEvidenceResponse['residency'] {
    const observedAt = new Date().toISOString();
    try {
      const materialized = entry.sdkType === 'pi'
        ? multiSessionManager.hasSession(entry.path)
        : entry.sdkType === 'claude'
          ? claudeService.hasSession(entry.id)
          : entry.sdkType === 'opencode'
            ? opencodeService.hasSession(entry.id)
            : antigravityService.hasSession(entry.id);
      return { state: materialized ? 'materialized' : 'not_materialized', observedAt };
    } catch {
      return { state: 'unknown', observedAt };
    }
  }

  async function evidenceBackendMode(entry: RegistryEntry): Promise<SessionDetail['backendMode']> {
    if (entry.sdkType === 'pi') return 'native';
    if (entry.sdkType === 'opencode') return 'server';
    if (entry.sdkType === 'antigravity') return 'subprocess';
    try {
      return await claudeService.getBackendMode();
    } catch {
      return entry.claudeProfileBackend === 'sdk-subscription'
        ? 'sdk'
        : entry.claudeProfileBackend === 'cli-direct'
          ? 'direct'
          : entry.claudeProfileBackend === 'channel'
            ? 'channel'
            : undefined;
    }
  }

  function evidenceSources(entry: RegistryEntry): SessionEvidenceResponse['sources'] {
    const runtime: Record<string, string> = {};
    let journalUnit = 'pi-web-ui';
    if (entry.sdkType === 'pi') {
      runtime.sessionPath = entry.path;
      runtime.sessionDirectory = entry.path.endsWith('.jsonl') ? path.dirname(entry.path) : entry.path;
      runtime.workerCommand = 'ps aux | grep "pi --mode rpc"';
    } else if (entry.sdkType === 'claude') {
      const nativePath = entry.cwd && entry.claudeSessionId
        ? path.join(
            os.homedir(),
            '.claude',
            'projects',
            `-${entry.cwd.split(path.sep).join('-').replace(/^-/, '')}`,
            `${entry.claudeSessionId}.jsonl`,
          )
        : undefined;
      runtime.replayPath = entry.path;
      if (entry.claudeSessionId) runtime.claudeSessionId = entry.claudeSessionId;
      if (nativePath) runtime.nativeSessionPath = nativePath;
    } else if (entry.sdkType === 'opencode') {
      journalUnit = 'opencode-serve';
      if (entry.opencodeSessionId) runtime.opencodeSessionId = entry.opencodeSessionId;
      runtime.transcriptSource = 'OpenCode runtime/message APIs';
      runtime.goalEngineStateDir = path.join(os.homedir(), '.opencode', 'goal-engine');
    } else {
      runtime.sessionJsonl = path.join(deps.antigravitySessionDir ?? config.antigravitySessionDir, `${entry.id}.jsonl`);
      if (entry.antigravityConversationId) {
        runtime.conversationId = entry.antigravityConversationId;
        runtime.conversationDb = path.join(
          os.homedir(),
          '.gemini',
          'antigravity-cli',
          'conversations',
          `${entry.antigravityConversationId}.db`,
        );
      }
      runtime.agyLogs = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log', 'cli-*.log');
    }

    return {
      registryPath: config.sessionRegistryPath,
      runtime,
      commands: [
        `npm run debug:where -- --registry ${shellQuote(config.sessionRegistryPath)} ${shellQuote(entry.id)}`,
        `sudo journalctl -u ${journalUnit} --since '15 minutes ago' --no-pager | grep -F -- ${shellQuote(`sid=${entry.id}`)}`,
      ],
    };
  }

  function evidenceLinks(sessionId: string): SessionEvidenceResponse['links'] {
    const encoded = encodeURIComponent(sessionId);
    return {
      info: `/api/v1/sessions/${encoded}/info`,
      diagnostics: `/api/v1/sessions/${encoded}/diagnostics`,
      transcript: `/api/v1/sessions/${encoded}/transcript`,
      screen: `/api/v1/sessions/${encoded}/transcript?view=screen`,
      history: `/api/v1/sessions/${encoded}/history`,
    };
  }

  function duplicatePromptResponse(
    sessionId: string,
    receipt: RunReceipt,
    detached: boolean,
  ): DuplicatePromptResponse {
    return {
      sessionId,
      runId: receipt.runId,
      duplicate: true,
      receipt,
      ...(detached ? { detached: true } : {}),
    } satisfies DuplicatePromptResponse;
  }

  /** Merge an ApplyPinResult into the pin fields of a response object. */
  function pinResponseFields(result: ApplyPinResult): {
    pinned: boolean;
    pinnedUntil?: string;
    pinReason?: 'PIN_LIMIT_REACHED';
    retentionLeaseId?: string;
    retentionMode?: 'durable' | 'resident';
  } {
    return {
      pinned: result.pinned,
      pinnedUntil: result.retentionMode !== 'durable' && result.pinnedUntil !== undefined
        ? new Date(result.pinnedUntil).toISOString()
        : undefined,
      pinReason: result.reason,
      retentionLeaseId: result.retentionLeaseId,
      retentionMode: result.retentionMode,
    };
  }

  async function handleCreateSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readJsonBody<unknown>(req);
    const parsed = createSessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      sendJson(res, 400, {
        error: parsed.error.issues[0]?.message ?? 'Invalid request body',
        code: ErrorCode.INVALID_REQUEST,
        details: parsed.error.issues,
      });
      return;
    }
    const body: CreateSessionRequest = parsed.data as CreateSessionRequest;

    const runtime: SessionRuntime = parsed.data.runtime;
    const cwd = parsed.data.cwd || process.env.PI_WEB_UI_VALIDATION_DEFAULT_CWD || process.cwd();
    if (runtime === 'pi') {
      try {
        assertPiModelAllowed(body.model, blockedPiProviders);
      } catch (error) {
        if (error instanceof PiProviderNotAllowedError) {
          sendPiProviderPolicyError(res, error);
          return;
        }
        throw error;
      }
    }
    let base: CreateSessionResponse | null = null;
    let createdPiSessionPath: string | undefined;
    let createdCommandCodeSessionId: string | undefined;

    try {
      switch (runtime) {
        case 'commandcode': {
          if (!commandCodeService || !commandCodeService.isEnabled()) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'Command Code runtime is disabled'));
            return;
          }
          if (!commandCodeService.isAvailable()) {
            const health = commandCodeService.getHealth();
            const code = health.status === 'executable_missing'
              ? ErrorCode.COMMANDCODE_CLI_MISSING
              : ErrorCode.COMMANDCODE_MODEL_UNAVAILABLE;
            sendJson(res, 503, enrichedErrorBody(code, `Command Code runtime is ${health.status}`));
            return;
          }
          const selectedModel = body.model;
          if (selectedModel !== 'qwen/qwen3.8-max' && selectedModel !== 'meta/muse-spark-1.2-contributor') {
            sendJson(res, 400, enrichedErrorBody(ErrorCode.COMMANDCODE_MODEL_UNAVAILABLE, 'Command Code requires one of the two exact allowlisted model ids'));
            return;
          }
          const invocationRole = body.invocationRole;
          if (invocationRole !== 'conductor-root' && invocationRole !== 'implementation-child') {
            sendJson(res, 403, enrichedErrorBody(ErrorCode.COMMANDCODE_ROLE_REFUSED, 'Command Code invocationRole is required and server-owned'));
            return;
          }
          const created = await commandCodeService.createSession({
            cwd,
            model: selectedModel,
            effort: body.effort,
            permissionProfile: invocationRole === 'conductor-root' ? 'agent-os-7f-root-readonly' : 'implementation-child-wide',
            invocationRole,
            roleAttestation: body.commandCodeAttestation as CommandCodeRoleAttestation | undefined,
          });
          createdCommandCodeSessionId = created.sessionId;
          base = {
            sessionId: created.sessionId,
            sessionPath: created.sessionId,
            runtime: 'commandcode',
            model: selectedModel,
            modelSelector: selectedModel,
            invocationRole,
            effort: created.effort,
            requestedEffort: created.effortSource === 'explicit' ? created.effort : undefined,
            acceptedEffort: created.effort,
            effortSource: created.effortSource,
            defaultEffort: created.defaultEffort,
            effortCapabilityHash: created.effortCapabilityHash,
            executionInstanceId: created.executionInstanceId,
            cwd: created.cwd,
            createdAt: created.createdAt,
          };
          break;
        }
        case 'claude': {
          const explicitProfileId = (body as { profileId?: string }).profileId;
          if (body.model?.startsWith('profile:')
            && explicitProfileId
            && body.model.slice('profile:'.length) !== explicitProfileId) {
            sendJson(res, 400, {
              error: 'model profile selector and profileId must identify the same Claude profile',
              code: ErrorCode.INVALID_REQUEST,
            });
            return;
          }
          if (!(await claudeService.isAvailable())) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'Claude runtime is not available'));
            return;
          }
          // Support profile selection via model="profile:<id>" or explicit profileId
          let profileId: string | undefined = explicitProfileId;
          let model: string | undefined = body.model || 'sonnet';
          if (model.startsWith('profile:')) {
            profileId = model.slice('profile:'.length);
            model = undefined; // the profile determines the model
          }
          const { sessionId } = await claudeService.createSession(cwd, model || 'sonnet', body.thinkingLevel, profileId);
          let resolvedEntry: RegistryEntry | undefined;
          if (profileId !== undefined) {
            resolvedEntry = await sessionRegistry.get(sessionId);
            if (!resolvedEntry
              || resolvedEntry.sdkType !== 'claude'
              || resolvedEntry.claudeProfileId !== profileId
              || !resolvedEntry.claudeProfileBackend
              || !resolvedEntry.claudeProviderId) {
              await cleanupRejectedCreatedSession(sessionId);
              throw new Error(`Explicit Claude profile '${profileId}' did not resolve to the requested concrete session binding.`);
            }
          }
          base = {
            sessionId,
            sessionPath: sessionId,
            runtime: 'claude',
            model: profileId !== undefined ? `profile:${profileId}` : (body.model || 'sonnet'),
            ...(profileId !== undefined ? { modelSelector: `profile:${profileId}`, executionInstanceId: profileId } : {}),
            cwd,
            createdAt: new Date().toISOString(),
          };
          break;
        }

        case 'opencode': {
          if (!opencodeService.isEnabled()) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'OpenCode runtime is disabled (OPENCODE_ENABLED=false)'));
            return;
          }
          if (!(await opencodeService.isAvailable())) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'OpenCode runtime is not available'));
            return;
          }
          const { sessionId } = await opencodeService.createSession(cwd);
          if (body.model) {
            await opencodeService.setModel?.(sessionId, body.model).catch(() => { /* non-fatal */ });
          }
          if (body.thinkingLevel) {
            await opencodeService.setThinkingLevel(sessionId, body.thinkingLevel);
          }
          base = {
            sessionId,
            sessionPath: sessionId,
            runtime: 'opencode',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          };
          break;
        }

        case 'antigravity': {
          if (!(await antigravityService.isAvailable())) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'Antigravity runtime is not available'));
            return;
          }
          const { sessionId } = await antigravityService.createSession(cwd, body.model);
          base = {
            sessionId,
            sessionPath: sessionId,
            runtime: 'antigravity',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          };
          break;
        }

        case 'pi': {
          const status = await multiSessionManager.createAndSubscribe(internalClientId, cwd);
          createdPiSessionPath = status.sessionPath;
          await sessionRegistry.upsert({
            id: status.sessionId,
            sdkType: 'pi',
            path: status.sessionPath,
            cwd,
            firstMessage: '',
            messageCount: 0,
            status: 'idle',
          });
          if (body.model) {
            await piService.setModel(status.sessionId, body.model).catch(() => { /* non-fatal */ });
          }
          const effectiveModel = multiSessionManager.getAgentSession(status.sessionPath)?.model;
          try {
            assertResolvedPiModelAllowed(
              effectiveModel ? `${effectiveModel.provider}/${effectiveModel.id}` : body.model,
              blockedPiProviders,
            );
          } catch (error) {
            if (error instanceof PiProviderNotAllowedError) {
              multiSessionManager.disposeLoadedSession(status.sessionPath);
              await deleteSessionFiles({ sdkType: 'pi', path: status.sessionPath, id: status.sessionId });
              await sessionRegistry.delete(status.sessionId);
              sendPiProviderPolicyError(res, error);
              return;
            }
            throw error;
          }
          if (body.thinkingLevel) {
            const agentSession = multiSessionManager.getAgentSession(status.sessionPath);
            if (!agentSession) {
              throw new Error('Pi session not loaded');
            }
            agentSession.setThinkingLevel(body.thinkingLevel);
          }
          base = {
            sessionId: status.sessionId,
            sessionPath: status.sessionPath,
            runtime: 'pi',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          };
          break;
        }

        default: {
          // Unreachable: createSessionBodySchema restricts runtime to the four
          // supported values. Kept as defense in depth so a future bypass can
          // never silently create a Pi session for an unknown runtime.
          sendJson(res, 400, { error: `Unsupported runtime: ${runtime}`, code: ErrorCode.INVALID_REQUEST });
          return;
        }
      }

      if (!base) {
        sendJson(res, 500, { error: 'Failed to create session', code: ErrorCode.SESSION_CREATE_FAILED });
        return;
      }

      // Required source-owned retention is atomic from the caller's perspective:
      // if the guarantee cannot be persisted/applied, remove the unused session.
      if (body.retention) {
        if (!pinExpiry) {
          await cleanupRejectedCreatedSession(base.sessionId);
          sendJson(res, 503, { error: 'Durable retention storage is unavailable', code: ErrorCode.RETENTION_STORE_UNAVAILABLE });
          return;
        }
        try {
          const result = await pinExpiry.acquireLease(base.sessionId, {
            ttlSeconds: body.retention.ttlSeconds,
            sessionPath: base.sessionPath,
            runtime: base.runtime,
            mode: body.retention.mode,
            ownerId: body.retention.ownerId,
            label: body.retention.label,
          });
          if (!result.retentionLeaseId) {
            await cleanupRejectedCreatedSession(base.sessionId);
            sendJson(res, 409, {
              error: 'Required resident retention capacity is unavailable',
              code: ErrorCode.RETENTION_RESIDENT_CAPACITY_EXHAUSTED,
            });
            return;
          }
          Object.assign(base, pinResponseFields(result), {
            retention: {
              leaseId: result.retentionLeaseId,
              mode: body.retention.mode,
              ownerId: body.retention.ownerId,
              expiresAt: new Date(result.pinnedUntil as number).toISOString(),
            },
          });
        } catch (error) {
          await cleanupRejectedCreatedSession(base.sessionId);
          sendJson(res, 503, {
            error: error instanceof Error ? error.message : 'Retention store unavailable',
            code: ErrorCode.RETENTION_STORE_UNAVAILABLE,
          });
          return;
        }
      } else if (body.pin) {
        // Legacy pin remains additive/backward compatible, now represented by
        // its own API claim rather than the Web UI's human pin slot.
        const result = pinExpiry
          ? await pinExpiry.applyPin(base.sessionId, {
              ttlSeconds: body.pinTtlSeconds,
              sessionPath: base.sessionPath,
              runtime: base.runtime,
              label: 'internal-api:create',
            })
          : await pinWithoutExpiry(base.sessionId);
        Object.assign(base, pinResponseFields(result));
      }

      sendJson(res, 201, base satisfies CreateSessionResponse);
      onSessionCreated?.(base.sessionId, base.sessionPath, base.runtime);
    } catch (err) {
      if (createdCommandCodeSessionId) await commandCodeService?.deleteSession(createdCommandCodeSessionId).catch(() => undefined);
      if (err instanceof CommandCodeRuntimeError && err.code === 'permission_denied') {
        sendJson(res, 403, enrichedErrorBody(ErrorCode.COMMANDCODE_ROLE_REFUSED, err.message));
        return;
      }
      if (err instanceof CommandCodeRuntimeError && err.code === 'effort_unsupported') {
        sendJson(res, 400, enrichedErrorBody(ErrorCode.COMMANDCODE_EFFORT_UNSUPPORTED, err.message));
        return;
      }
      logger.errorObject('Failed to create session', err);
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Failed to create session',
        code: ErrorCode.SESSION_CREATE_FAILED,
      });
    } finally {
      // The Internal API is not a human viewer. Its synthetic creation
      // subscription must not keep every Pi session resident indefinitely.
      if (createdPiSessionPath) multiSessionManager.unsubscribeClient(internalClientId, createdPiSessionPath);
    }
  }

  async function handleListSessions(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const all = await sessionRegistry.listAll();
      const sessions: SessionInfo[] = all.map((entry) => ({
        sessionId: entry.id,
        sessionPath: entry.path,
        runtime: entry.sdkType as SessionRuntime,
        executionInstanceId: resolveExecutionInstanceId(entry),
        cwd: entry.cwd,
        model: entry.model,
        modelSelector: modelSelectorForEntry(entry),
        status: entry.status,
        messageCount: entry.messageCount,
        firstMessage: entry.firstMessage,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
      }));
      if (commandCodeService?.isEnabled()) {
        const commandCodeSessions = await commandCodeService.listSessions();
        sessions.push(...commandCodeSessions.map(commandCodeSessionInfo));
      }

      sendJson(res, 200, { sessions } satisfies ListSessionsResponse);
    } catch (err) {
      logger.errorObject('Failed to list sessions', err);
      sendJson(res, 500, { error: 'Failed to list sessions', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function buildSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const commandCodeEntry = await commandCodeService?.getSession(sessionId);
    if (commandCodeEntry) return commandCodeSessionDetail(commandCodeEntry);
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return null;

    const detail: SessionDetail = {
      sessionId: entry.id,
      sessionPath: entry.path,
      runtime: entry.sdkType as SessionRuntime,
      executionInstanceId: resolveExecutionInstanceId(entry),
      cwd: entry.cwd,
      model: entry.model,
      modelSelector: modelSelectorForEntry(entry),
      status: entry.status === 'error' ? 'error' : 'idle',
      messageCount: entry.messageCount,
      firstMessage: entry.firstMessage,
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
    };

    if (entry.sdkType === 'claude') {
      const [stats, context, backendMode] = await Promise.all([
        claudeService.getSessionStats(sessionId),
        claudeService.getContextUsage(sessionId),
        claudeService.getBackendMode(),
      ]);

      detail.backendMode = backendMode;
      detail.pinned = claudeService.isSessionPinned(sessionId);
      const claudePinUntil = apiPinDeadline(sessionId);
      if (claudePinUntil) detail.pinnedUntil = claudePinUntil;
      detail.status = claudeService.isRunning(sessionId) ? 'running' : detail.status;
      // Expose Claude-specific profile metadata (never secrets)
      if (entry.claudeProfileId) {
        (detail as SessionDetail & { claudeProfileId?: string; claudeProfileBackend?: string; claudeProviderId?: string }).claudeProfileId = entry.claudeProfileId;
        (detail as SessionDetail & { claudeProfileBackend?: string }).claudeProfileBackend = entry.claudeProfileBackend;
        (detail as SessionDetail & { claudeProviderId?: string }).claudeProviderId = entry.claudeProviderId;
      }
      if (stats) {
        detail.nativeSessionId = stats.sessionId;
        detail.sessionFile = stats.sessionFile;
        detail.model = stats.model ?? detail.model;
        detail.tokens = { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total };
        detail.cost = stats.cost;
        detail.stats = {
          userMessages: stats.userMessages,
          assistantMessages: stats.assistantMessages,
          toolCalls: stats.toolCalls,
          toolResults: stats.toolResults,
          totalMessages: stats.totalMessages,
        };
        detail.lastActivityAt = stats.lastActivityAt ?? undefined;
      }
      detail.context = {
        contextWindow: context?.contextWindow,
        used: context?.tokens,
        percent: context?.percent,
      };
      return detail;
    }

    if (entry.sdkType === 'opencode') {
      const stats = await opencodeService.getSessionStats(sessionId);
      const context = opencodeService.getContextUsage(sessionId);
      detail.backendMode = 'server';
      detail.pinned = opencodeService.isSessionPinned(sessionId);
      const opencodePinUntil = apiPinDeadline(sessionId);
      if (opencodePinUntil) detail.pinnedUntil = opencodePinUntil;
      detail.status = opencodeService.isRunning(sessionId) ? 'running' : detail.status;
      if (stats) {
        detail.nativeSessionId = entry.opencodeSessionId ?? stats.sessionId;
        detail.model = stats.model ?? detail.model;
        detail.tokens = { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total };
        detail.cost = stats.cost;
        detail.stats = {
          userMessages: stats.userMessages,
          assistantMessages: stats.assistantMessages,
          toolCalls: stats.toolCalls,
          toolResults: stats.toolResults,
          totalMessages: stats.totalMessages,
        };
      }
      detail.context = {
        contextWindow: context?.contextWindow,
        used: context?.tokens,
        percent: context?.percent,
      };
      return detail;
    }

    if (entry.sdkType === 'antigravity') {
      const stats = await antigravityService.getSessionStats(sessionId);
      detail.backendMode = 'subprocess';
      detail.pinned = antigravityService.isSessionPinned(sessionId);
      const antigravityPinUntil = apiPinDeadline(sessionId);
      if (antigravityPinUntil) detail.pinnedUntil = antigravityPinUntil;
      detail.status = antigravityService.isRunning(sessionId) ? 'running' : detail.status;
      if (stats) {
        detail.model = stats.model ?? detail.model;
        detail.stats = {
          userMessages: stats.userMessages,
          assistantMessages: stats.assistantMessages,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: stats.totalMessages,
        };
      }
      return detail;
    }

    const agentSession = multiSessionManager.getAgentSession(entry.path);
    detail.backendMode = 'native';
    detail.pinned = multiSessionManager.isSessionPinned(entry.path);
    const piPinUntil = apiPinDeadline(sessionId);
    if (piPinUntil) detail.pinnedUntil = piPinUntil;
    if (agentSession) {
      const stats = agentSession.getSessionStats();
      const context = agentSession.getContextUsage();
      detail.nativeSessionId = agentSession.sessionId;
      detail.sessionFile = agentSession.sessionFile;
      detail.model = agentSession.model ? `${agentSession.model.provider}/${agentSession.model.id}` : detail.model;
      detail.tokens = {
        input: stats.tokens?.input ?? 0,
        output: stats.tokens?.output ?? 0,
        total: stats.tokens?.total ?? ((stats.tokens?.input ?? 0) + (stats.tokens?.output ?? 0)),
      };
      detail.cost = stats.cost ?? 0;
      detail.stats = {
        userMessages: stats.userMessages ?? 0,
        assistantMessages: stats.assistantMessages ?? 0,
        toolCalls: stats.toolCalls ?? 0,
        toolResults: stats.toolResults ?? 0,
        totalMessages: stats.totalMessages ?? 0,
      };
      detail.context = {
        contextWindow: context?.contextWindow,
        used: context?.tokens ?? undefined,
        percent: context?.percent ?? undefined,
      };
    }
    return detail;
  }

  async function handleGetSession(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const detail = await buildSessionDetail(sessionId);
      if (!detail) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }
      sendJson(res, 200, detail);
    } catch (err) {
      logger.errorObject('Failed to get session', err);
      sendJson(res, 500, { error: 'Failed to get session', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function handleGetSessionInfo(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const detail = await buildSessionDetail(sessionId);
      if (!detail) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }
      sendJson(res, 200, detail);
    } catch (err) {
      logger.errorObject('Failed to get session info', err);
      sendJson(res, 500, { error: 'Failed to get session info', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function commandCodeTranscript(record: CommandCodeInternalSessionRecord, scope: 'visible_recent' | 'visible_full'): Promise<TranscriptResponse> {
    const events = await commandCodeService!.getReplayEvents(record.sessionId);
    const projected = replayEventsToVisibleItems(commandCodeEventsToScreenEvents(events));
    // Journals written before user message events were introduced still have a
    // useful last prompt in the session record. Keep that bounded compatibility
    // fallback, but never duplicate it when the normalized journal has users.
    const allItems: TranscriptResponse['items'] = projected.length > 0 && projected.some((item) => item.kind === 'user')
      ? projected
      : record.lastMessage
        ? [{ kind: 'user', text: record.lastMessage }, ...projected]
        : projected;
    const bounded = scope === 'visible_recent' && allItems.length > 20 ? allItems.slice(-20) : allItems;
    return {
      sessionId: record.sessionId,
      runtime: 'commandcode',
      scope,
      itemCount: bounded.length,
      truncated: bounded.length !== allItems.length,
      items: bounded,
      source: {
        sessionId: record.sessionId,
        displayName: record.firstMessage?.slice(0, 50) || record.sessionId,
        sdkType: 'commandcode',
        cwd: record.cwd,
        createdAt: record.createdAt,
        lastActivity: record.updatedAt,
      },
    };
  }

  async function handleCommandCodeEvidence(
    res: ServerResponse,
    record: CommandCodeInternalSessionRecord,
    query: URLSearchParams,
  ): Promise<void> {
    await runReceipts.init();
    const expansions = parseEvidenceExpansions(query.get('expand'));
    const limit = parseEvidenceLimit(query.get('limit'));
    const receipts = runReceipts.listBySession(record.sessionId)
      .sort((a, b) => Date.parse(b.terminalAt ?? b.acceptedAt) - Date.parse(a.terminalAt ?? a.acceptedAt));
    const diagnostics = record.diagnostics ? [{
      ts: record.updatedAt,
      level: record.diagnostics.protocolError ? 'warn' : 'info',
      component: 'CommandCodeService',
      msg: record.diagnostics.protocolError ?? `Command Code state=${record.state}`,
      runtime: 'commandcode',
      executionInstanceId: record.executionInstanceId,
    }] : [];
    const response: SessionEvidenceResponse = {
      sessionId: record.sessionId,
      runtime: 'commandcode',
      aliases: {
        internalId: record.sessionId,
        path: record.sessionId,
        ...(record.nativeSessionId ? { commandCodeNativeSessionId: record.nativeSessionId } : {}),
      },
      status: record.state === 'running' ? 'running' : record.state === 'failed' || record.state === 'aborted' ? 'error' : 'idle',
      backendMode: 'subprocess',
      model: record.modelSelector,
      cwd: record.cwd,
      messageCount: record.messageCount,
      createdAt: record.createdAt,
      lastActivity: record.updatedAt,
      executionInstanceId: record.executionInstanceId,
      invocationRole: record.invocationRole,
      permissionProfile: record.permissionProfile,
      effort: record.effort,
      requestedEffort: commandCodeRequestedEffort(record),
      acceptedEffort: record.effort,
      effortSource: record.effortSource,
      defaultEffort: record.defaultEffort,
      effectiveEffort: record.effectiveEffort,
      effortEvidenceMethod: record.effortEvidenceMethod,
      effortCapabilityHash: record.effortCapabilityHash,
      ...(receipts[0]?.tokenUsage ? { tokenUsage: receipts[0].tokenUsage } : {}),
      activity: { status: record.state === 'running' ? 'running' : record.state === 'failed' || record.state === 'aborted' ? 'error' : 'idle', lastActivity: record.updatedAt },
      sources: {
        registryPath: 'private command-code session store',
        runtime: {
          executionInstanceId: record.executionInstanceId,
          eventJournal: record.eventJournalRef,
          nativeTranscript: 'owned by Command Code; not read or copied by Pi Web UI',
        },
        commands: [],
      },
      diagnostics: { processLocal: true, expanded: expansions.has('diagnostics'), records: expansions.has('diagnostics') ? diagnostics : diagnostics.slice(-3) },
      receiptSummary: { durable: true, count: receipts.length, ...(receipts[0] ? { latest: receipts[0] } : {}) },
      retention: evidenceRetention(record.sessionId),
      residency: { state: record.state === 'running' ? 'materialized' : 'not_materialized', observedAt: new Date().toISOString() },
      runChronology: receipts.slice(0, 3).map((receipt) => ({
        runId: receipt.runId, status: receipt.status, acceptedAt: receipt.acceptedAt,
        ...(receipt.startedAt ? { startedAt: receipt.startedAt } : {}),
        ...(receipt.agentEndAt ? { agentEndAt: receipt.agentEndAt } : {}),
        ...(receipt.terminalAt ? { terminalAt: receipt.terminalAt } : {}),
        ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
        ...(receipt.liveness ? { liveness: receipt.liveness } : {}),
        ...(receipt.tokenUsage ? { tokenUsage: receipt.tokenUsage } : {}),
      })),
      warnings: [
        'Command Code native credentials and transcript files remain owned by Command Code and are not copied here.',
        'The private normalized event journal is the Pi Web UI replay source.',
      ],
      links: evidenceLinks(record.sessionId),
    };
    if (expansions.has('runs')) response.runReceipts = receipts.slice(0, limit);
    if (expansions.has('transcript')) response.transcript = await commandCodeTranscript(record, 'visible_recent');
    if (expansions.has('screen')) {
      const events = await commandCodeService!.getReplayEvents(record.sessionId);
      const screenView = projectDefaultViewFromEvents(commandCodeEventsToScreenEvents(events), { expand: parseScreenViewExpand(query.get('expand')) });
      response.screen = {
        sessionId: record.sessionId, runtime: 'commandcode', view: 'screen', expanded: screenView.expanded,
        screenView, markdown: renderScreenViewMarkdown(screenView),
        source: { sessionId: record.sessionId, displayName: record.firstMessage?.slice(0, 50) || record.sessionId, sdkType: 'commandcode', cwd: record.cwd, createdAt: record.createdAt, lastActivity: record.updatedAt },
      };
    }
    sendJson(res, 200, response);
  }

  async function handleGetSessionEvidence(
    _req: IncomingMessage,
    res: ServerResponse,
    identifier: string,
    query: URLSearchParams,
  ): Promise<void> {
    try {
      const commandCodeEntry = await commandCodeService?.findSession(identifier);
      if (commandCodeEntry) {
        await handleCommandCodeEvidence(res, commandCodeEntry, query);
        return;
      }
      const entry = await resolveSessionEntry(identifier);
      if (!entry) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }

      const expansions = parseEvidenceExpansions(query.get('expand'));
      const limit = parseEvidenceLimit(query.get('limit'));
      const status = evidenceStatus(entry);
      let model = entry.model;
      try {
        model = currentRunModel(entry);
      } catch {
        // Registry metadata remains a sufficient fallback for evidence lookup.
      }
      const backendMode = await evidenceBackendMode(entry);
      // Ensure restart-surviving receipts are loaded before building the durable
      // summary; the default bundle must not silently look empty during startup.
      await runReceipts.init();
      const diagnosticLimit = expansions.has('diagnostics') ? limit : Math.min(limit, EVIDENCE_DEFAULT_LIMIT);
      const diagnosticRecords = [
        ...getRecentLogs({ sessionId: entry.id, limit: diagnosticLimit }),
        ...(entry.path !== entry.id
          ? getRecentLogs({ sessionId: entry.path, limit: diagnosticLimit })
          : []),
      ]
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
        .slice(-diagnosticLimit)
        .map((record) => compactDiagnosticRecord(
          record,
          entry.firstMessage,
          expansions.has('diagnostics') ? 320 : 180,
        ));
      const receipts = runReceipts
        .listBySession(entry.id)
        .sort((a, b) => Date.parse(b.terminalAt ?? b.acceptedAt) - Date.parse(a.terminalAt ?? a.acceptedAt));
      const sources = evidenceSources(entry);
      const response: SessionEvidenceResponse = {
        sessionId: entry.id,
        runtime: entry.sdkType as SessionRuntime,
        aliases: {
          internalId: entry.id,
          path: entry.path,
          ...(entry.claudeSessionId ? { claudeSessionId: entry.claudeSessionId } : {}),
          ...(entry.opencodeSessionId ? { opencodeSessionId: entry.opencodeSessionId } : {}),
          ...(entry.antigravityConversationId ? { antigravityConversationId: entry.antigravityConversationId } : {}),
        },
        status,
        ...(backendMode ? { backendMode } : {}),
        ...(model ? { model } : {}),
        cwd: entry.cwd,
        messageCount: entry.messageCount,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
        executionInstanceId: resolveExecutionInstanceId(entry),
        activity: { status, lastActivity: entry.lastActivity },
        sources,
        diagnostics: {
          processLocal: true,
          expanded: expansions.has('diagnostics'),
          records: diagnosticRecords,
        },
        receiptSummary: {
          durable: true,
          count: receipts.length,
          ...(receipts[0] ? { latest: receipts[0] } : {}),
        },
        retention: evidenceRetention(entry.id),
        residency: evidenceResidency(entry),
        runChronology: receipts.slice(0, 3).map((receipt) => ({
          runId: receipt.runId,
          status: receipt.status,
          acceptedAt: receipt.acceptedAt,
          ...(receipt.startedAt ? { startedAt: receipt.startedAt } : {}),
          ...(receipt.agentEndAt ? { agentEndAt: receipt.agentEndAt } : {}),
          ...(receipt.terminalAt ? { terminalAt: receipt.terminalAt } : {}),
          ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
          ...(receipt.liveness ? { liveness: receipt.liveness } : {}),
        })),
        control: {
          askUserQuestions: extractQuestionControlEvents(broker.getRecentEvents(entry.id, EVIDENCE_MAX_LIMIT)),
        },
        warnings: [
          'Diagnostics are process-local and reset when the server restarts.',
          'Run receipts and runtime-owned source files are durable; this bundle is intentionally bounded.',
          'Residency means adapter materialisation only; it does not prove execution progress, process quiescence, or semantic completion.',
        ],
        links: evidenceLinks(entry.id),
      };

      if (expansions.has('runs')) {
        response.runReceipts = receipts.slice(0, limit);
      }
      if (expansions.has('transcript')) {
        const loaded = await loadSessionTranscript(entry, 'visible_recent');
        response.transcript = {
          sessionId: entry.id,
          runtime: entry.sdkType as SessionRuntime,
          ...loaded.transcript,
        };
      }
      if (expansions.has('screen')) {
        const events = await loadScreenViewEvents(entry);
        const screenView = projectDefaultViewFromEvents(events, {
          expand: parseScreenViewExpand(query.get('expand')),
        });
        response.screen = {
          sessionId: entry.id,
          runtime: entry.sdkType as SessionRuntime,
          view: 'screen',
          expanded: screenView.expanded,
          screenView,
          markdown: renderScreenViewMarkdown(screenView),
          source: {
            sessionId: entry.id,
            displayName: entry.firstMessage?.slice(0, 50) ?? entry.id,
            sdkType: entry.sdkType as SessionRuntime,
            cwd: entry.cwd,
            createdAt: entry.createdAt,
            lastActivity: entry.lastActivity,
          },
        };
      }

      if (expansions.size === 0) {
        while (
          response.diagnostics.records.length > 0
          && Buffer.byteLength(JSON.stringify(response)) > EVIDENCE_DEFAULT_MAX_BYTES
        ) {
          response.diagnostics.records.shift();
        }
      }

      sendJson(res, 200, response);
    } catch (err) {
      logger.errorObject('Failed to build session evidence', err);
      sendJson(res, 500, { error: 'Failed to build session evidence', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function handleGetRunReceipt(
    _req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): Promise<void> {
    await runReceipts.init();
    const receipt = runReceipts.get(runId);
    if (!receipt) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.RUN_NOT_FOUND, 'Run receipt not found'));
      return;
    }
    sendJson(res, 200, receipt);
  }

  async function handleGetSessionHistory(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const commandCodeEntry = await commandCodeService?.findSession(sessionId);
      if (commandCodeEntry) {
        sendJson(res, 200, { sessionId: commandCodeEntry.sessionId, runtime: 'commandcode', events: (await commandCodeService!.getReplayEvents(commandCodeEntry.sessionId)).map((event) => ({ ...event })) } satisfies SessionHistoryResponse);
        return;
      }
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }

      let events: Array<Record<string, unknown>> = [];
      if (entry.sdkType === 'claude') {
        events = await claudeService.getReplayEvents(sessionId);
      } else if (entry.sdkType === 'opencode') {
        events = await opencodeService.getReplayEvents(sessionId);
      } else if (entry.sdkType === 'antigravity') {
        events = await antigravityService.getReplayEvents(sessionId);
      } else if (entry.sdkType === 'pi') {
        // Pi has no native NormalizedEvent history; build one from the
        // session JSONL via the source adapter.
        const source = {
          sessionId: entry.id,
          displayName: entry.firstMessage?.slice(0, 50) ?? entry.id,
          sdkType: 'pi' as const,
          cwd: entry.cwd,
          createdAt: entry.createdAt,
          lastActivity: entry.lastActivity,
        };
        const adapted = await extractPiTranscript(entry.path, source, 'visible_full');
        events = adapted.transcript.items.map((item) => ({
          type: item.kind === 'tool' ? 'tool_execution_end' : 'message_end',
          sessionId,
          timestamp: item.timestamp ?? Date.now(),
          data: {
            role: item.kind,
            text: item.text,
            toolName: item.toolName,
            toolPrimaryArg: item.toolPrimaryArg,
          },
        }));
      } else {
        sendJson(res, 501, { error: `Replay history not supported for runtime: ${entry.sdkType}`, code: ErrorCode.NOT_IMPLEMENTED });
        return;
      }

      sendJson(res, 200, {
        sessionId,
        runtime: entry.sdkType,
        events,
      } satisfies SessionHistoryResponse);
    } catch (err) {
      logger.errorObject('Failed to get session history', err);
      sendJson(res, 500, { error: 'Failed to get session history', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function deleteSessionFiles(entry: { sdkType: string; path: string; id: string }): Promise<void> {
    switch (entry.sdkType) {
      case 'pi': {
        try {
          const s = await stat(entry.path);
          if (s.isDirectory()) {
            await rm(entry.path, { recursive: true, force: true });
          } else {
            await unlink(entry.path);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        break;
      }
      case 'claude': {
        const jsonlFile = path.join(claudeSessionDir, `${entry.id}.jsonl`);
        try {
          await unlink(jsonlFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        break;
      }
      case 'antigravity': {
        const jsonlFile = path.join(antigravitySessionDir, `${entry.id}.jsonl`);
        try {
          await unlink(jsonlFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        const logsDir = path.join(antigravitySessionDir, 'agy-logs');
        try {
          const logFiles = await readdir(logsDir);
          for (const logFile of logFiles) {
            if (logFile.startsWith(`${entry.id}-`)) {
              await unlink(path.join(logsDir, logFile));
            }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        break;
      }
      case 'opencode':
        break;
    }
  }

  async function handleDeleteSession(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const commandCodeEntry = await commandCodeService?.findSession(sessionId);
      if (commandCodeEntry) {
        await runReceipts.cancelSession(commandCodeEntry.sessionId);
        disposal.dispose(commandCodeEntry.sessionId);
        broker.clear(commandCodeEntry.sessionId);
        // Release every source-owned claim while the Command Code record is
        // still resolvable. Deleting first would make unpinSessionById unable
        // to find the runtime record and leave durable retention leases behind.
        await watchManager.delete(commandCodeEntry.sessionId);
        if (pinExpiry) await pinExpiry.clear(commandCodeEntry.sessionId);
        await unpinSessionById(commandCodeEntry.sessionId).catch(() => false);
        await commandCodeService!.deleteSession(commandCodeEntry.sessionId);
        sendJson(res, 200, { success: true, nativeTranscriptRetained: true });
        return;
      }
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }

      // Mark the accepted run cancelled before asking the runtime to abort.
      // Late runtime callbacks cannot overwrite an explicit user deletion.
      await runReceipts.cancelSession(sessionId);

      // Tombstone the session and run every registered per-session dispose
      // handle (queued-run correlations, timers, snapshots, drain handles) so
      // late runtime callbacks cannot repopulate broker/state after deletion.
      disposal.dispose(sessionId);
      // Tombstone the broker-key alias too (Pi publishes under entry.path, not
      // the canonical sessionId), so the broker's deletion fence covers Pi.
      // Idempotent; runs no handles unless a surface registered under the path.
      if (entry.path && entry.path !== sessionId) disposal.dispose(entry.path);

      if (entry.sdkType === 'claude') {
        claudeService.abort(sessionId);
      } else if (entry.sdkType === 'opencode') {
        opencodeService.abort(sessionId);
      } else if (entry.sdkType === 'antigravity') {
        antigravityService.abort(sessionId);
      } else {
        const agentSession = multiSessionManager.getAgentSession(entry.path);
        if (agentSession) {
          await agentSession.abort().catch(() => { /* non-fatal */ });
        }
      }

      // Drop the persistent broker-feeding observer for this session and prune
      // its broker replay tail, so a deleted session leaves no live observer,
      // idempotency key, or event buffer behind (lifecycle ownership).
      broker.clear(sessionId);
      if (entry.path && entry.path !== sessionId) broker.clear(entry.path);
      if (entry.sdkType === 'pi') {
        const attached = piObserverByPath.get(entry.path);
        if (attached) {
          multiSessionManager.removeApiObserver?.(entry.path, attached);
          piObserverByPath.delete(entry.path);
        }
        piObservedSessions.delete(entry.path);
      } else if (entry.sdkType === 'opencode') {
        const attached = opencodeObserverById.get(sessionId);
        if (attached) {
          opencodeService.removeApiObserver?.(sessionId, attached);
          opencodeObserverById.delete(sessionId);
        }
        opencodeObservedSessions.delete(sessionId);
      }

      // Release every source-owned claim while the registry/runtime object is
      // still resolvable. A durable-ledger failure is fatal here: deleting the
      // session while leaving a lease behind would resurrect stale ownership on
      // restart. Each release is ownership-scoped and cannot clear another.
      await watchManager.delete(sessionId);
      if (pinExpiry) await pinExpiry.clear(sessionId);
      await unpinSessionById(sessionId).catch(() => false); // human Web UI claim

      if (entry.sdkType === 'pi') {
        // Dispose the live SDK object before unlinking its backing JSONL. This
        // also removes synthetic subscriber and event-handler references.
        multiSessionManager.disposeLoadedSession(entry.path);
      }

      // Remove the runtime's persisted session files so the session does not
      // reappear in the UI after a registry rebuild.
      await deleteSessionFiles(entry);

      await sessionRegistry.delete(sessionId);
      sendJson(res, 200, { success: true });
    } catch (err) {
      logger.errorObject('Failed to delete session', err);
      sendJson(res, 500, { error: 'Failed to delete session', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function executePromptWithReceipt(
    runId: string,
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    mode: PromptMode,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
    admittedLease?: { release: () => void; turnToken?: number },
  ): Promise<void> {
    const admissionLease = admittedLease ?? await admission.acquire(runtime, 'P2');
    runReceipts.attachLease(runId, admissionLease);
    try {
    let completed = false;
    let completionError: Error | undefined;
    let persistence: Promise<unknown> = Promise.resolve();
    const eventPersistence: Promise<void>[] = [];

    const complete = (error?: Error, cessationBasis?: 'documented_handler_return'): void => {
      if (completed) return;
      completed = true;
      completionError = error;
      // Keep persistence in the turn's promise chain. The transport callback
      // is deliberately deferred until this write completes, so even an SSE
      // client cannot observe success before its terminal receipt is durable.
      const busy = error ? isRuntimeAlreadyRunningError(error) : false;
      const terminalWrite = busy
        ? runReceipts.rejectBeforeDispatch(runId, { status: 'cancelled', errorCode: ErrorCode.SESSION_BUSY })
        : runReceipts.finish(runId, error
          ? {
              status: 'failed',
              errorCode: error instanceof PiProviderNotAllowedError
                ? ErrorCode.PROVIDER_NOT_ALLOWED
                : runtimeErrorCode(error, runtime),
            }
          : cessationBasis
            ? { status: 'completed', cessationBasis }
            : {});
      persistence = terminalWrite.then((receipt) => {
        if (receipt?.phase7Shadow) logPhase7Shadow(runId, receipt.phase7Shadow);
        return receipt;
      });
    };

    let executionError: Error | undefined;
    const execution = executePrompt(
      sessionId,
      runtime,
      message,
      mode,
      (event) => {
        eventPersistence.push(runReceipts.observeEvent(runId, event));
        onEvent(event);
      },
      complete,
      admittedLease?.turnToken,
      runId,
    ).then(() => {
      // Existing runtimes normally call onComplete at their turn boundary. The
      // fallback keeps the receipt explicit if a runtime returns without doing
      // so, without inventing a new runtime-specific completion hook.
      if (!completed) complete();
    }).catch((error) => {
      executionError = error instanceof Error ? error : new Error(String(error));
      complete(executionError);
    });

    const winner = await Promise.race([
      execution.then(() => ({ kind: 'execution' as const })),
      runReceipts.waitForTerminal(runId).then((receipt) => ({ kind: 'terminal' as const, receipt })),
    ]);
    if (winner.kind === 'terminal' && winner.receipt.errorCode === ErrorCode.TURN_STALLED) {
      const stalled = new TurnStalledError();
      complete(stalled);
      await abortRuntimeTurn(sessionId, runtime).catch((error) => {
        logger.warn(`Failed to abort stalled run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      // The runtime promise may settle later; its handlers above are fenced by
      // complete() and prevent an unhandled rejection or false success.
    } else {
      await execution;
    }

    // Wait for agent_end evidence as well as the terminal transition. This
    // handles runtimes whose completion callback wins the event-order race.
    await Promise.all(eventPersistence);
    // Always await the terminal receipt write before notifying any response
    // transport. Otherwise a process crash in this small window could leave a
    // run reported as complete but persisted as merely started.
    let persistenceError: Error | undefined;
    try {
      await persistence;
    } catch (error) {
      persistenceError = error instanceof Error ? error : new Error(String(error));
    }

    try {
      onComplete(persistenceError ?? completionError);
    } catch (callbackError) {
      // A transport callback must not hide the durable terminal outcome or
      // leave executePrompt's promise unresolved.
      logger.errorObject(`Prompt response callback failed for run ${runId}`, callbackError);
    }

    if (persistenceError) throw persistenceError;
    if (executionError) throw executionError;
    } finally {
      admissionLease.release();
    }
  }

  function isSessionBusy(entry: RegistryEntry): boolean {
    if (activeDirectDispatchTokens.has(entry.id)) return true;
    if (entry.sdkType === 'claude') return claudeService.isRunning(entry.id);
    if (entry.sdkType === 'opencode') return opencodeService.isRunning(entry.id);
    if (entry.sdkType === 'antigravity') return antigravityService.isRunning(entry.id);
    const status = multiSessionManager.getSessionStatus?.(entry.path)?.status;
    return status === 'busy' || status === 'streaming';
  }

  function chooseDispatchMode(
    runtime: SessionRuntime,
    mode: PromptMode,
    busy: boolean,
    requireActiveTurn: boolean,
  ): { dispatchMode: PromptMode; error?: never } | {
    dispatchMode?: never;
    error: typeof ErrorCode.SESSION_BUSY | typeof ErrorCode.SESSION_NOT_STREAMING;
  } {
    if (mode === 'steer') {
      return busy ? { dispatchMode: 'steer' } : { error: ErrorCode.SESSION_NOT_STREAMING };
    }
    if (mode === 'follow_up') {
      if (busy) return runtime === 'pi' ? { dispatchMode: 'follow_up' } : { error: ErrorCode.SESSION_BUSY };
      if (requireActiveTurn) return { error: ErrorCode.SESSION_NOT_STREAMING };
      return { dispatchMode: 'prompt' };
    }
    return busy ? { error: ErrorCode.SESSION_BUSY } : { dispatchMode: 'prompt' };
  }

  async function handleCommandCodePrompt(
    req: IncomingMessage,
    res: ServerResponse,
    record: CommandCodeInternalSessionRecord,
    body: SendPromptRequest,
  ): Promise<void> {
    const verbosity: Verbosity = body.verbosity || parseVerbosityHeader(req.headers['x-verbosity'] as string | undefined) || 'answers';
    const mode = body.mode ?? 'prompt';
    if (mode === 'steer') {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'Command Code does not support steer mode'));
      return;
    }
    if (body.detach && (verbosity === 'full' || verbosity === 'tasks')) {
      sendJson(res, 400, { error: 'detach=true requires verbosity=answers (non-streaming)', code: ErrorCode.INVALID_REQUEST });
      return;
    }
    const dispatchMode: PromptMode = 'prompt';
    const busy = commandCodeService!.isRunning(record.sessionId) || (await commandCodeService!.getSession(record.sessionId))?.state === 'running';
    if (busy || mode === 'follow_up' && body.requireActiveTurn) {
      res.setHeader('Retry-After', String(admission.snapshot().retryAfterSeconds));
      sendJson(res, 409, enrichedErrorBody(busy ? ErrorCode.SESSION_BUSY : ErrorCode.SESSION_NOT_STREAMING, busy ? 'Session is currently busy' : 'Session does not have an active turn'));
      return;
    }
    const beginInput = {
      sessionId: record.sessionId,
      runtime: 'commandcode' as const,
      executionInstanceId: record.executionInstanceId,
      model: record.modelSelector,
      modelSelector: record.modelSelector,
      effort: record.effort,
      requestedEffort: commandCodeRequestedEffort(record),
      acceptedEffort: record.effort,
      effortSource: record.effortSource,
      defaultEffort: record.defaultEffort,
      effortCapabilityHash: record.effortCapabilityHash,
      invocationRole: record.invocationRole,
      permissionProfile: record.permissionProfile,
      message: body.message,
      mode,
      dispatchMode,
      verbosity,
      detach: body.detach === true,
      requireActiveTurn: body.requireActiveTurn === true,
      idempotencyKey: body.idempotencyKey,
    } as const;
    if (body.idempotencyKey !== undefined) {
      try {
        const existing = await runReceipts.findExistingRun(beginInput);
        if (existing?.kind === 'conflict') {
          sendJson(res, 409, { ...enrichedErrorBody(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'Idempotency key was already used for a different prompt'), runId: existing.receipt.runId });
          return;
        }
        if (existing?.kind === 'duplicate') {
          sendJson(res, 200, duplicatePromptResponse(record.sessionId, existing.receipt, body.detach === true));
          return;
        }
      } catch (error) {
        sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, error instanceof Error ? error.message : String(error)));
        return;
      }
    }
    let reservation;
    try {
      reservation = await runReceipts.beginRun(beginInput);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to reserve run receipt', code: ErrorCode.INTERNAL_ERROR });
      return;
    }
    if (reservation.kind !== 'created') {
      if (reservation.kind === 'conflict') sendJson(res, 409, { ...enrichedErrorBody(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'Idempotency key was already used for a different prompt'), runId: reservation.receipt.runId });
      else sendJson(res, 200, duplicatePromptResponse(record.sessionId, reservation.receipt, body.detach === true));
      return;
    }
    const runId = reservation.receipt.runId;
    let rawLease: { release: () => void };
    try {
      rawLease = await admission.acquire('commandcode', 'P2');
    } catch (error) {
      await runReceipts.rejectBeforeDispatch(runId, { status: 'cancelled', errorCode: ErrorCode.ADMISSION_CAPACITY_EXHAUSTED });
      const capacityError = error instanceof AdmissionCapacityError ? error : new AdmissionCapacityError('global_limit');
      res.setHeader('Retry-After', String(capacityError.retryAfterSeconds));
      sendJson(res, 429, { ...enrichedErrorBody(ErrorCode.ADMISSION_CAPACITY_EXHAUSTED, capacityError.message), reason: capacityError.reason, retryAfterSeconds: capacityError.retryAfterSeconds, runId });
      return;
    }
    let released = false;
    const lease = { release: () => { if (released) return; released = true; rawLease.release(); } };
    runReceipts.attachLease(runId, lease);
    try {
      await runReceipts.markStarted(runId);
    } catch (error) {
      lease.release();
      await runReceipts.rejectBeforeDispatch(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR }).catch(() => undefined);
      logger.errorObject(`Failed to start Command Code run receipt ${runId}`, error);
      sendJson(res, 500, { error: 'Failed to start run', code: ErrorCode.INTERNAL_ERROR, runId });
      return;
    }
    const runContext = { runId, executionInstanceId: record.executionInstanceId };
    if (body.detach) {
      void withCorrelation(runContext, async () => {
        logger.info(`[InternalAPI] Prompt dispatched: runtime=commandcode verbosity=${verbosity} mode=${mode} dispatchMode=${dispatchMode} runId=${runId}`);
        await executePromptWithReceipt(runId, record.sessionId, 'commandcode', body.message, dispatchMode, () => undefined, (error) => {
          if (error) logger.errorObject(`Detached Command Code prompt failed ${record.sessionId} run=${runId}`, error);
        }, lease);
      }).catch((error) => logger.errorObject(`Detached Command Code prompt error for ${record.sessionId} run=${runId}`, error));
      sendJson(res, 202, { sessionId: record.sessionId, runId, detached: true, status: 'accepted', mode, dispatchMode } satisfies DetachedPromptResponse);
      return;
    }
    try {
      await withCorrelation(runContext, async () => {
        logger.info(`[InternalAPI] Prompt dispatched: runtime=commandcode verbosity=${verbosity} mode=${mode} dispatchMode=${dispatchMode} runId=${runId}`);
        if (verbosity === 'full' || verbosity === 'tasks') {
          await handleStreamingPrompt(req, res, record.sessionId, 'commandcode', body.message, verbosity, mode, dispatchMode, runId, lease);
        } else {
          await handleAnswersPrompt(res, record.sessionId, 'commandcode', body.message, mode, dispatchMode, runId, lease);
        }
      });
    } catch (error) {
      lease.release();
      await runReceipts.finish(runId, { status: 'failed', errorCode: runtimeErrorCode(error instanceof Error ? error : new Error(String(error)), 'commandcode') }).catch(() => undefined);
      if (!res.headersSent) sendJson(res, 500, { error: 'Command Code prompt failed. Inspect evidence using the returned runId.', code: ErrorCode.RUNTIME_ERROR, runId });
    }
  }

  async function handleSendPrompt(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await readJsonBody<SendPromptRequest>(req);
    if (!body || !body.message) {
      sendJson(res, 400, { error: 'message is required', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    const injectionCheck = detectPromptInjection(body.message);
    if (injectionCheck.recommendation === 'block') {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.PROMPT_INJECTION, 'Prompt contains potentially malicious content'));
      return;
    }

    const verbosity: Verbosity = body.verbosity || parseVerbosityHeader(req.headers['x-verbosity'] as string | undefined) || 'answers';
    const mode = body.mode ?? 'prompt';
    if (mode !== 'prompt' && mode !== 'follow_up' && mode !== 'steer') {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, 'mode must be prompt, follow_up, or steer'));
      return;
    }

    const commandCodeEntry = await commandCodeService?.findSession(sessionId);
    if (commandCodeEntry) {
      const requestId = getCorrelationContext()?.requestId ?? newRequestId();
      await withCorrelation({ requestId, sessionId, runtime: 'commandcode' }, async () => {
        await handleCommandCodePrompt(req, res, commandCodeEntry, body);
      });
      return;
    }

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    if (mode === 'steer' && entry.sdkType !== 'pi') {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, `Prompt mode '${mode}' is not supported for ${entry.sdkType}`));
      return;
    }

    const runtime = entry.sdkType;

    // Fail-closed BEFORE any receipt/admission/runtime call: a disabled OpenCode
    // must reject with the contracted error, not proceed to dispatch (which
    // spawn/attaches via ensureServer) or leave a started receipt behind.
    if (runtime === 'opencode' && !opencodeService.isEnabled()) {
      sendJson(res, 503, enrichedErrorBody(ErrorCode.OPENCODE_UNAVAILABLE, 'OpenCode runtime is disabled (OPENCODE_ENABLED=false)'));
      return;
    }

    // Stamp a per-prompt correlation id on every log line emitted during this
    // prompt's lifecycle (requestId + sessionId + runtime), so an agent can
    // `grep <requestId>` to reconstruct the whole causal chain in one pass.
    const requestId = getCorrelationContext()?.requestId ?? newRequestId();
    await withCorrelation({ requestId, sessionId, runtime: entry.sdkType }, async () => {
      if (body.detach && (verbosity === 'full' || verbosity === 'tasks')) {
        sendJson(res, 400, {
          error: 'detach=true requires verbosity=answers (non-streaming)',
          code: ErrorCode.INVALID_REQUEST,
        });
        return;
      }

      // Idempotent replay precedes liveness checks: a retry must recover its
      // accepted receipt even while that same run keeps the runtime busy.
      if (body.idempotencyKey !== undefined) {
        const replayInput = {
          sessionId,
          runtime,
          executionInstanceId: resolveExecutionInstanceId(entry),
          model: currentRunModel(entry),
          modelSelector: modelSelectorForEntry(entry),
          message: body.message,
          mode,
          verbosity,
          detach: body.detach === true,
          requireActiveTurn: body.requireActiveTurn === true,
          idempotencyKey: body.idempotencyKey,
        } as const;
        try {
          const existing = await runReceipts.findExistingRun(replayInput);
          if (existing?.kind === 'conflict') {
            sendJson(res, 409, {
              ...enrichedErrorBody(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'Idempotency key was already used for a different prompt'),
              runId: existing.receipt.runId,
            });
            return;
          }
          if (existing?.kind === 'duplicate') {
            sendJson(res, 200, duplicatePromptResponse(sessionId, existing.receipt, body.detach === true));
            return;
          }
        } catch (error) {
          if (error instanceof IdempotencyKeyValidationError) {
            sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, error.message));
            return;
          }
          logger.errorObject('Failed to inspect run receipt', error);
          sendJson(res, 500, { error: 'Failed to inspect run receipt', code: ErrorCode.INTERNAL_ERROR });
          return;
        }
      }

      const providerPolicyError = piProviderPolicyError(entry);
      if (providerPolicyError) {
        sendPiProviderPolicyError(res, providerPolicyError);
        return;
      }

      let dispatchMode: PromptMode;
      try {
        const decision = chooseDispatchMode(runtime, mode, isSessionBusy(entry), body.requireActiveTurn === true);
        if (decision.error) {
          if (decision.error === ErrorCode.SESSION_BUSY) {
            res.setHeader('Retry-After', String(admission.snapshot().retryAfterSeconds));
          }
          sendJson(res, 409, enrichedErrorBody(
            decision.error,
            decision.error === ErrorCode.SESSION_BUSY
              ? 'Session is currently busy'
              : 'Session does not have an active turn',
          ));
          return;
        }
        dispatchMode = decision.dispatchMode;
      } catch (error) {
        logger.errorObject('Failed to inspect session state', error);
        sendJson(res, 500, { error: 'Failed to inspect session state', code: ErrorCode.INTERNAL_ERROR });
        return;
      }

      const beginInput = {
        sessionId,
        runtime,
        executionInstanceId: resolveExecutionInstanceId(entry),
        model: currentRunModel(entry),
        modelSelector: modelSelectorForEntry(entry),
        message: body.message,
        mode,
        dispatchMode,
        verbosity,
        detach: body.detach === true,
        requireActiveTurn: body.requireActiveTurn === true,
        idempotencyKey: body.idempotencyKey,
        ...(runtime === 'pi' && config.validationMode
          ? { phase7Shadow: classifyPhase7PiShadow({ sessionId, message: body.message }) }
          : {}),
      } as const;

      // Claim a new-turn slot synchronously before the first reservation await.
      // This is the route's monotonic per-session turn token.
      let directClaim = dispatchMode === 'prompt' ? claimDirectDispatch(sessionId) : undefined;
      if (dispatchMode === 'prompt' && !directClaim) {
        res.setHeader('Retry-After', String(admission.snapshot().retryAfterSeconds));
        sendJson(res, 409, enrichedErrorBody(ErrorCode.SESSION_BUSY, 'Session is currently busy'));
        return;
      }

      let reservation;
      try {
        reservation = await runReceipts.beginRun(beginInput);
      } catch (error) {
        directClaim?.release();
        if (error instanceof IdempotencyKeyValidationError) {
          sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, error.message));
          return;
        }
        logger.errorObject('Failed to reserve run receipt', error);
        sendJson(res, 500, { error: 'Failed to reserve run receipt', code: ErrorCode.INTERNAL_ERROR });
        return;
      }

      if (reservation.kind !== 'created') {
        directClaim?.release();
        if (reservation.kind === 'conflict') {
          sendJson(res, 409, {
            ...enrichedErrorBody(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'Idempotency key was already used for a different prompt'),
            runId: reservation.receipt.runId,
          });
        } else {
          sendJson(res, 200, duplicatePromptResponse(sessionId, reservation.receipt, body.detach === true));
        }
        return;
      }

      const runId = reservation.receipt.runId;
      if (reservation.receipt.phase7Shadow) logPhase7Shadow(runId, reservation.receipt.phase7Shadow);

      // Native Pi follow-up is queue acceptance, not a separately correlated
      // turn. Persist queued before calling the SDK and never attach this run to
      // the predecessor's agent_end.
      if (dispatchMode === 'follow_up') {
        try {
          await runReceipts.markQueued(runId);
          await queuePiFollowUp(sessionId, body.message, runId);
          sendJson(res, 202, {
            sessionId,
            runId,
            detached: body.detach === true,
            status: 'accepted',
            mode,
            dispatchMode,
          });
        } catch (error) {
          const providerError = error instanceof PiProviderNotAllowedError ? error : undefined;
          await runReceipts.finish(runId, {
            status: 'failed',
            errorCode: providerError ? ErrorCode.PROVIDER_NOT_ALLOWED : ErrorCode.RUNTIME_ERROR,
          });
          if (providerError) sendPiProviderPolicyError(res, providerError);
          else sendJson(res, 500, { error: 'Runtime prompt failed', code: ErrorCode.RUNTIME_ERROR, runId });
        }
        return;
      }

      // Re-check runtime liveness after reservation. Ignore our own process-local
      // claim; only the runtime state can reveal an external/browser race here.
      let runtimeBusyAfterReservation: boolean;
      try {
        runtimeBusyAfterReservation = runtime === 'claude'
          ? claudeService.isRunning(sessionId)
          : runtime === 'opencode'
            ? opencodeService.isRunning(sessionId)
            : runtime === 'antigravity'
              ? antigravityService.isRunning(sessionId)
              : (() => {
                  const status = multiSessionManager.getSessionStatus?.(entry.path)?.status;
                  return status === 'busy' || status === 'streaming';
                })();
      } catch (error) {
        directClaim?.release();
        await runReceipts.rejectBeforeDispatch(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR });
        logger.errorObject(`Failed to re-check session state for run ${runId}`, error);
        sendJson(res, 500, { error: 'Failed to verify session state', code: ErrorCode.INTERNAL_ERROR, runId });
        return;
      }
      if (dispatchMode === 'prompt' && runtimeBusyAfterReservation) {
        directClaim?.release();
        await runReceipts.rejectBeforeDispatch(runId, { status: 'cancelled', errorCode: ErrorCode.SESSION_BUSY });
        res.setHeader('Retry-After', String(admission.snapshot().retryAfterSeconds));
        sendJson(res, 409, { ...enrichedErrorBody(ErrorCode.SESSION_BUSY, 'Session is currently busy'), runId });
        return;
      }

      let rawAdmissionLease: { release: () => void };
      try {
        rawAdmissionLease = await admission.acquire(runtime, 'P2');
      } catch (error) {
        directClaim?.release();
        await runReceipts.rejectBeforeDispatch(runId, { status: 'cancelled', errorCode: ErrorCode.ADMISSION_CAPACITY_EXHAUSTED });
        const capacityError = error instanceof AdmissionCapacityError ? error : new AdmissionCapacityError('global_limit');
        res.setHeader('Retry-After', String(capacityError.retryAfterSeconds));
        // Pressure refusals (memory/pid/host) are 503 service-unavailable — the
        // server is under resource pressure and genuinely cannot service the
        // turn. Capacity refusals (global/runtime limit) are 429 — retryable
        // admission throttling. Both carry ADMISSION_CAPACITY_EXHAUSTED + reason.
        const pressureStatus = capacityError.reason.endsWith('_pressure') ? 503 : 429;
        sendJson(res, pressureStatus, {
          ...enrichedErrorBody(ErrorCode.ADMISSION_CAPACITY_EXHAUSTED, capacityError.message),
          reason: capacityError.reason,
          retryAfterSeconds: capacityError.retryAfterSeconds,
          runId,
        });
        return;
      }
      let leaseReleased = false;
      const admissionLease = {
        turnToken: directClaim?.token,
        release: () => {
          if (leaseReleased) return;
          leaseReleased = true;
          rawAdmissionLease.release();
          directClaim?.release();
          directClaim = undefined;
        },
      };
      runReceipts.attachLease(runId, admissionLease);
      try {
        await runReceipts.markStarted(runId);
      } catch (error) {
        admissionLease.release();
        await runReceipts.rejectBeforeDispatch(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR }).catch(() => undefined);
        logger.errorObject(`Failed to start run receipt ${runId}`, error);
        sendJson(res, 500, { error: 'Failed to start run', code: ErrorCode.INTERNAL_ERROR, runId });
        return;
      }

      return withCorrelation({
        runId,
        executionInstanceId: beginInput.executionInstanceId,
      }, async () => {
        logger.info(`[InternalAPI] Prompt dispatched: runtime=${runtime} verbosity=${verbosity} mode=${mode} dispatchMode=${dispatchMode} runId=${runId}`);

        if (body.detach) {
        void executePromptWithReceipt(
          runId,
          sessionId,
          runtime,
          body.message,
          dispatchMode,
          () => { /* progress events flow to the broker inside executePrompt */ },
          (err) => {
            if (err) logger.errorObject(`Detached prompt failed for ${sessionId} run=${runId}`, err);
          },
          admissionLease,
        ).catch((error) => {
          logger.errorObject(`Detached prompt error for ${sessionId} run=${runId}`, error);
        });
        sendJson(res, 202, { sessionId, runId, detached: true, status: 'accepted', mode, dispatchMode } satisfies DetachedPromptResponse);
        return;
      }

      try {
        if (verbosity === 'full' || verbosity === 'tasks') {
          await handleStreamingPrompt(req, res, sessionId, runtime, body.message, verbosity, mode, dispatchMode, runId, admissionLease);
          return;
        }

        await handleAnswersPrompt(res, sessionId, runtime, body.message, mode, dispatchMode, runId, admissionLease);
      } catch (err) {
        admissionLease.release();
        const providerError = err instanceof PiProviderNotAllowedError ? err : undefined;
        // executePromptWithReceipt normally terminalizes before rejecting. This
        // defensive finalizer covers failures in response/stream setup that can
        // occur after markStarted but before the runtime is invoked.
        await runReceipts.finish(runId, {
          status: 'failed',
          errorCode: providerError ? ErrorCode.PROVIDER_NOT_ALLOWED : runtimeErrorCode(err instanceof Error ? err : new Error(String(err)), runtime),
        }).catch(() => undefined);
        logger.errorObject('Prompt failed', err);
          if (!res.headersSent) {
            if (providerError) sendPiProviderPolicyError(res, providerError);
            else {
              sendJson(res, 500, {
                error: 'Runtime prompt failed. Inspect diagnostics using the returned runId.',
                code: runtimeErrorCode(err instanceof Error ? err : new Error(String(err)), runtime),
                runId,
              });
            }
          }
        }
      });
    });
  }

  async function handleAnswersPrompt(
    res: ServerResponse,
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    mode: PromptMode,
    dispatchMode: PromptMode,
    runId: string,
    admissionLease: { release: () => void },
  ): Promise<void> {
    const collector = createEventCollector();

    await executePromptWithReceipt(
      runId,
      sessionId,
      runtime,
      message,
      dispatchMode,
      (event) => {
        collectAnswerEvent(collector, event);
      },
      (error) => {
        if (error) collector.error = error;
        collector.complete = true;
      },
      admissionLease,
    );

    if (collector.error) {
      const busy = isRuntimeAlreadyRunningError(collector.error);
      const errorCode = busy ? ErrorCode.SESSION_BUSY : runtimeErrorCode(collector.error, runtime);
      if (busy) res.setHeader('Retry-After', String(admission.snapshot().retryAfterSeconds));
      const status = busy ? 409 : errorCode === ErrorCode.COMMANDCODE_RATE_LIMITED ? 429 : errorCode === ErrorCode.COMMANDCODE_AUTH_REQUIRED || errorCode === ErrorCode.COMMANDCODE_CREDITS ? 503 : errorCode === ErrorCode.COMMANDCODE_NETWORK_FAILURE || errorCode === ErrorCode.COMMANDCODE_PROVIDER_FAILURE || errorCode === ErrorCode.COMMANDCODE_PROTOCOL_ERROR || errorCode === ErrorCode.COMMANDCODE_NO_RESPONSE ? 502 : 500;
      sendJson(res, status, {
        error: busy ? 'Session is currently busy' : 'Runtime prompt failed. Inspect diagnostics using the returned runId.',
        code: errorCode,
        runId,
      });
      return;
    }

    logger.info(`[InternalAPI] Prompt turn complete: runtime=${runtime} runId=${runId} chars=${collector.textParts.join('').length}`);

    sendJson(res, 200, {
      sessionId,
      runId,
      messageId: collector.lastMessageId,
      content: collector.textParts.join(''),
      tokens: collector.usage,
      turnComplete: true,
      mode,
      dispatchMode,
    } satisfies PromptResponse);
  }

  async function handleStreamingPrompt(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    verbosity: Verbosity,
    mode: PromptMode,
    dispatchMode: PromptMode,
    runId: string,
    admissionLease: { release: () => void },
  ): Promise<void> {
    res.setHeader('X-Run-Id', runId);
    const sse = createSSEStream(res);
    let turnCompleted = false;
    let disconnectHandled = false;

    const handleClientDisconnect = (): void => {
      // A normal SSE completion also closes the response. Only cancel/abort
      // when the turn has not delivered its terminal callback yet.
      if (turnCompleted || res.writableEnded || disconnectHandled) return;
      disconnectHandled = true;
      void (async () => {
        try {
          const cancelled = await runReceipts.cancelRun(runId);
          // Completion may win the race while the client connection closes.
          // Never abort a runtime after its receipt became terminal.
          if (cancelled?.status !== 'cancelled') return;
          if (runtime === 'commandcode') {
            await commandCodeService?.abort(sessionId);
          } else if (runtime === 'claude') {
            claudeService.abort(sessionId);
          } else if (runtime === 'opencode') {
            opencodeService.abort(sessionId);
          } else if (runtime === 'antigravity') {
            antigravityService.abort(sessionId);
          } else {
            const entry = await sessionRegistry.get(sessionId);
            const agentSession = entry ? multiSessionManager.getAgentSession(entry.path) : undefined;
            await agentSession?.abort().catch(() => { /* non-fatal */ });
          }
        } catch (error) {
          logger.warn(`Streaming disconnect cleanup failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    };

    res.on('close', handleClientDisconnect);
    req.on('aborted', handleClientDisconnect);

    await executePromptWithReceipt(
      runId,
      sessionId,
      runtime,
      message,
      dispatchMode,
      (event) => {
        if (verbosity === 'full') {
          writeFullEvent(sse.write, event);
        } else {
          writeTaskEvent(sse.write, event);
        }
      },
      (error) => {
        turnCompleted = true;
        if (error) {
          sse.error(error.message);
        } else {
          sse.complete({ sessionId, turnComplete: true, mode, dispatchMode });
        }
      },
      admissionLease,
    );
  }

  async function handleAbort(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const commandCodeEntry = await commandCodeService?.findSession(sessionId);
      if (commandCodeEntry) {
        await runReceipts.cancelSession(commandCodeEntry.sessionId);
        await commandCodeService!.abort(commandCodeEntry.sessionId);
        sendJson(res, 200, { success: true });
        return;
      }
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }

      await runReceipts.cancelSession(sessionId);

      if (entry.sdkType === 'claude') {
        claudeService.abort(sessionId);
      } else if (entry.sdkType === 'opencode') {
        opencodeService.abort(sessionId);
      } else if (entry.sdkType === 'antigravity') {
        antigravityService.abort(sessionId);
      } else {
        const agentSession = multiSessionManager.getAgentSession(entry.path);
        if (agentSession) {
          await agentSession.abort();
        }
      }

      sendJson(res, 200, { success: true });
    } catch (err) {
      logger.errorObject('Abort failed', err);
      sendJson(res, 500, { error: 'Failed to abort session', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function handleSessionControl(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const raw = await readJsonBody<unknown>(req);
    const parsed = sessionControlBodySchema.safeParse(raw);
    if (!parsed.success) {
      sendJson(res, 400, {
        error: parsed.error.issues[0]?.message ?? 'Invalid request body',
        code: ErrorCode.INVALID_REQUEST,
        details: parsed.error.issues,
      });
      return;
    }
    const body = parsed.data as SessionControlRequest;

    const commandCodeEntry = await commandCodeService?.findSession(sessionId);
    if (commandCodeEntry) {
      if (body.action === 'set_model') {
        if (body.modelId !== commandCodeEntry.modelSelector) {
          sendJson(res, 400, enrichedErrorBody(ErrorCode.COMMANDCODE_MODEL_UNAVAILABLE, 'Command Code model selection is fixed to the session route'));
          return;
        }
        sendJson(res, 200, { success: true, action: 'set_model', modelId: body.modelId } satisfies SessionControlResponse);
        return;
      }
      if (body.action === 'set_effort') {
        try {
          const updated = await commandCodeService!.setEffort(commandCodeEntry.sessionId, body.effort);
          sendJson(res, 200, {
            success: true,
            action: 'set_effort',
            effort: updated.effort,
            requestedEffort: updated.effortSource === 'explicit' ? updated.effort : undefined,
            acceptedEffort: updated.effort,
            effortSource: updated.effortSource,
            defaultEffort: updated.defaultEffort,
            effortCapabilityHash: updated.effortCapabilityHash,
          } satisfies SessionControlResponse);
        } catch (error) {
          const runtimeError = error as CommandCodeRuntimeError;
          if (runtimeError instanceof CommandCodeRuntimeError && runtimeError.code === 'effort_unsupported') {
            sendJson(res, 400, enrichedErrorBody(ErrorCode.COMMANDCODE_EFFORT_UNSUPPORTED, runtimeError.message));
          } else if (runtimeError instanceof CommandCodeRuntimeError && /already running|idle/i.test(runtimeError.message)) {
            sendJson(res, 409, enrichedErrorBody(ErrorCode.SESSION_BUSY, runtimeError.message));
          } else {
            sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to set Command Code effort', code: ErrorCode.INTERNAL_ERROR });
          }
        }
        return;
      }
      if (body.action === 'acquire_retention') {
        if (!pinExpiry || !body.retention) {
          sendJson(res, 400, { error: 'retention is required', code: ErrorCode.INVALID_REQUEST });
          return;
        }
        let result: ApplyPinResult;
        try {
          result = await pinExpiry.acquireLease(commandCodeEntry.sessionId, {
            mode: body.retention.mode,
            ttlSeconds: body.retention.ttlSeconds,
            ownerId: body.retention.ownerId,
            label: body.retention.label,
            sessionPath: commandCodeEntry.sessionId,
            runtime: 'commandcode',
          });
        } catch (error) {
          sendJson(res, 503, { error: error instanceof Error ? error.message : 'Retention store unavailable', code: ErrorCode.RETENTION_STORE_UNAVAILABLE });
          return;
        }
        if (!result.retentionLeaseId) {
          sendJson(res, 409, { error: 'Required resident retention capacity is unavailable', code: ErrorCode.RETENTION_RESIDENT_CAPACITY_EXHAUSTED });
          return;
        }
        sendJson(res, 200, {
          success: true,
          action: 'acquire_retention',
          pinned: commandCodeService!.isSessionPinned(commandCodeEntry.sessionId),
          retention: {
            leaseId: result.retentionLeaseId,
            mode: body.retention.mode,
            ownerId: body.retention.ownerId,
            expiresAt: new Date(result.pinnedUntil as number).toISOString(),
          },
        } satisfies SessionControlResponse);
        return;
      }
      if (body.action === 'renew_retention') {
        if (!pinExpiry || !body.retentionLeaseId) {
          sendJson(res, 400, { error: 'retentionLeaseId is required', code: ErrorCode.INVALID_REQUEST });
          return;
        }
        const claim = pinExpiry.listLeases(commandCodeEntry.sessionId).find((item) => item.leaseId === body.retentionLeaseId);
        if (!claim) {
          sendJson(res, 404, { error: 'Retention lease not found', code: ErrorCode.RETENTION_CLAIM_NOT_FOUND });
          return;
        }
        if (body.ownerId !== undefined && claim.ownerId !== body.ownerId) {
          sendJson(res, 409, { error: 'Retention lease owner mismatch', code: ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH });
          return;
        }
        let result: ApplyPinResult;
        try {
          result = await pinExpiry.renewLease(commandCodeEntry.sessionId, body.retentionLeaseId, body.pinTtlSeconds);
        } catch (error) {
          sendJson(res, 503, { error: error instanceof Error ? error.message : 'Retention store unavailable', code: ErrorCode.RETENTION_STORE_UNAVAILABLE });
          return;
        }
        sendJson(res, 200, {
          success: true,
          action: 'renew_retention',
          pinned: commandCodeService!.isSessionPinned(commandCodeEntry.sessionId),
          retention: {
            leaseId: body.retentionLeaseId,
            mode: result.retentionMode!,
            ownerId: claim.ownerId ?? '',
            expiresAt: new Date(result.pinnedUntil as number).toISOString(),
          },
        } satisfies SessionControlResponse);
        return;
      }
      if (body.action === 'release_retention') {
        if (!pinExpiry || !body.retentionLeaseId) {
          sendJson(res, 400, { error: 'retentionLeaseId is required', code: ErrorCode.INVALID_REQUEST });
          return;
        }
        try {
          await pinExpiry.releaseLease(commandCodeEntry.sessionId, body.retentionLeaseId, body.ownerId);
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const code = message === 'RETENTION_CLAIM_OWNER_MISMATCH'
            ? ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH
            : message === 'RETENTION_CLAIM_NOT_FOUND'
              ? ErrorCode.RETENTION_CLAIM_NOT_FOUND
              : ErrorCode.RETENTION_STORE_UNAVAILABLE;
          const status = code === ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH ? 409
            : code === ErrorCode.RETENTION_CLAIM_NOT_FOUND ? 404 : 503;
          sendJson(res, status, { error: message || code, code });
          return;
        }
        sendJson(res, 200, { success: true, action: 'release_retention', pinned: commandCodeService!.isSessionPinned(commandCodeEntry.sessionId) } satisfies SessionControlResponse);
        return;
      }
      if (body.action === 'pin') {
        const pinned = commandCodeService!.pinSession(commandCodeEntry.sessionId);
        sendJson(res, 200, { success: pinned, action: 'pin', pinned } satisfies SessionControlResponse);
        return;
      }
      if (body.action === 'unpin') {
        commandCodeService!.unpinSession(commandCodeEntry.sessionId);
        sendJson(res, 200, { success: true, action: 'unpin', pinned: false } satisfies SessionControlResponse);
        return;
      }
      sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'This session control operation is not supported for Command Code'));
      return;
    }

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    try {
      let response: SessionControlResponse;
      switch (body.action) {
        case 'set_model': {
          if (!body.modelId) {
            sendJson(res, 400, { error: 'modelId is required for set_model', code: ErrorCode.INVALID_REQUEST });
            return;
          }
          if (entry.sdkType === 'opencode' && !opencodeService.isEnabled()) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.OPENCODE_UNAVAILABLE, 'OpenCode runtime is disabled (OPENCODE_ENABLED=false)'));
            return;
          }

          if (entry.sdkType === 'claude') {
            const normalizedModel = await claudeService.setModel(sessionId, body.modelId);
            response = { success: true, action: 'set_model', modelId: normalizedModel };
          } else if (entry.sdkType === 'opencode') {
            const normalizedModel = await opencodeService.setModel(sessionId, body.modelId);
            response = { success: true, action: 'set_model', modelId: normalizedModel };
          } else if (entry.sdkType === 'antigravity') {
            const normalizedModel = await antigravityService.setModel(sessionId, body.modelId);
            response = { success: true, action: 'set_model', modelId: normalizedModel };
          } else {
            try {
              assertPiModelAllowed(body.modelId, blockedPiProviders);
            } catch (error) {
              if (error instanceof PiProviderNotAllowedError) {
                sendPiProviderPolicyError(res, error);
                return;
              }
              throw error;
            }
            await piService.setModel(sessionId, body.modelId);
            response = { success: true, action: 'set_model', modelId: body.modelId };
          }
          break;
        }

        case 'set_thinking_level': {
          if (!body.level) {
            sendJson(res, 400, { error: 'level is required for set_thinking_level', code: ErrorCode.INVALID_REQUEST });
            return;
          }
          if (!isThinkingLevel(body.level)) {
            sendJson(res, 400, { error: 'level is invalid for set_thinking_level', code: ErrorCode.INVALID_REQUEST });
            return;
          }
          if (entry.sdkType === 'opencode' && !opencodeService.isEnabled()) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.OPENCODE_UNAVAILABLE, 'OpenCode runtime is disabled (OPENCODE_ENABLED=false)'));
            return;
          }

          if (entry.sdkType === 'claude') {
            claudeService.setThinkingLevel(sessionId, body.level);
          } else if (entry.sdkType === 'opencode') {
            await opencodeService.setThinkingLevel(sessionId, body.level);
          } else if (entry.sdkType === 'pi') {
            const agentSession = multiSessionManager.getAgentSession(entry.path);
            if (!agentSession) {
              sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Pi session not loaded'));
              return;
            }
            agentSession.setThinkingLevel(body.level);
          } else {
            sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'Thinking level not supported for this runtime'));
            return;
          }

          response = { success: true, action: 'set_thinking_level', level: body.level };
          break;
        }

        case 'pin': {
          if (pinExpiry) {
            const result = await pinExpiry.applyPin(sessionId, {
              ttlSeconds: body.pinTtlSeconds,
              sessionPath: entry.path,
              runtime: entry.sdkType as SessionRuntime,
              label: 'internal-api:control',
            });
            response = { success: result.pinned, action: 'pin', ...pinResponseFields(result) };
          } else {
            let pinned: boolean;
            if (entry.sdkType === 'claude') {
              pinned = claudeService.pinSession(sessionId);
            } else if (entry.sdkType === 'opencode') {
              pinned = await opencodeService.pinSession(sessionId);
            } else if (entry.sdkType === 'antigravity') {
              pinned = await antigravityService.pinSession(sessionId);
            } else {
              pinned = multiSessionManager.pinSession(entry.path);
            }
            response = { success: pinned, action: 'pin', pinned };
          }
          break;
        }

        case 'acquire_retention': {
          if (!pinExpiry || !body.retention) {
            sendJson(res, 400, { error: 'retention is required', code: ErrorCode.INVALID_REQUEST });
            return;
          }
          let result: ApplyPinResult;
          try {
            result = await pinExpiry.acquireLease(sessionId, {
              mode: body.retention.mode,
              ttlSeconds: body.retention.ttlSeconds,
              ownerId: body.retention.ownerId,
              label: body.retention.label,
              sessionPath: entry.path,
              runtime: entry.sdkType as SessionRuntime,
            });
          } catch (error) {
            sendJson(res, 503, { error: error instanceof Error ? error.message : 'Retention store unavailable', code: ErrorCode.RETENTION_STORE_UNAVAILABLE });
            return;
          }
          if (!result.retentionLeaseId) {
            sendJson(res, 409, { error: 'Required resident retention capacity is unavailable', code: ErrorCode.RETENTION_RESIDENT_CAPACITY_EXHAUSTED });
            return;
          }
          response = {
            success: true,
            action: 'acquire_retention',
            pinned: isSessionPinnedByEntry(entry),
            retention: {
              leaseId: result.retentionLeaseId,
              mode: body.retention.mode,
              ownerId: body.retention.ownerId,
              expiresAt: new Date(result.pinnedUntil as number).toISOString(),
            },
          };
          break;
        }

        case 'renew_retention': {
          if (!pinExpiry || !body.retentionLeaseId) {
            sendJson(res, 400, { error: 'retentionLeaseId is required', code: ErrorCode.INVALID_REQUEST });
            return;
          }
          const claim = pinExpiry.listLeases(sessionId).find((item) => item.leaseId === body.retentionLeaseId);
          if (!claim) {
            sendJson(res, 404, { error: 'Retention lease not found', code: ErrorCode.RETENTION_CLAIM_NOT_FOUND });
            return;
          }
          if (body.ownerId !== undefined && claim.ownerId !== body.ownerId) {
            sendJson(res, 409, { error: 'Retention lease owner mismatch', code: ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH });
            return;
          }
          let result: ApplyPinResult;
          try {
            result = await pinExpiry.renewLease(sessionId, body.retentionLeaseId, body.pinTtlSeconds);
          } catch (error) {
            sendJson(res, 503, { error: error instanceof Error ? error.message : 'Retention store unavailable', code: ErrorCode.RETENTION_STORE_UNAVAILABLE });
            return;
          }
          response = {
            success: true,
            action: 'renew_retention',
            pinned: isSessionPinnedByEntry(entry),
            retention: {
              leaseId: body.retentionLeaseId,
              mode: result.retentionMode!,
              ownerId: claim.ownerId ?? '',
              expiresAt: new Date(result.pinnedUntil as number).toISOString(),
            },
          };
          break;
        }

        case 'release_retention': {
          if (!pinExpiry || !body.retentionLeaseId) {
            sendJson(res, 400, { error: 'retentionLeaseId is required', code: ErrorCode.INVALID_REQUEST });
            return;
          }
          try {
            await pinExpiry.releaseLease(sessionId, body.retentionLeaseId, body.ownerId);
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const code = message === 'RETENTION_CLAIM_OWNER_MISMATCH'
              ? ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH
              : message === 'RETENTION_CLAIM_NOT_FOUND'
                ? ErrorCode.RETENTION_CLAIM_NOT_FOUND
                : ErrorCode.RETENTION_STORE_UNAVAILABLE;
            const status = code === ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH ? 409
              : code === ErrorCode.RETENTION_CLAIM_NOT_FOUND ? 404 : 503;
            sendJson(res, status, { error: message || code, code });
            return;
          }
          response = { success: true, action: 'release_retention', pinned: isSessionPinnedByEntry(entry) };
          break;
        }

        case 'unpin': {
          // Legacy Internal API unpin releases only Internal API leases. It must
          // never clear a human Web UI or watch-owned runtime claim.
          if (pinExpiry) {
            await pinExpiry.releaseLegacyLease(sessionId);
          } else {
            await unpinSessionById(sessionId, 'internal-api:legacy-untracked');
          }
          response = { success: true, action: 'unpin', pinned: isSessionPinnedByEntry(entry) };
          break;
        }

        default:
          sendJson(res, 400, { error: `Unsupported action '${(body as { action?: string }).action}'`, code: ErrorCode.INVALID_REQUEST });
          return;
      }

      sendJson(res, 200, response);
    } catch (err) {
      logger.errorObject('Session control failed', err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Session control failed', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  function validateStringRecord(value: unknown, fieldName: string): string | null {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return `${fieldName} must be an object`;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length === 0 || typeof item !== 'string') {
        return `${fieldName} must be an object whose values are strings`;
      }
    }
    return null;
  }

  function validateAskUserQuestionAnnotations(value: unknown): string | null {
    if (value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return 'annotations must be an object';
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return 'annotations values must be objects';
      }
      const annotation = item as Record<string, unknown>;
      if (annotation.preview !== undefined && typeof annotation.preview !== 'string') {
        return 'annotations preview values must be strings';
      }
      if (annotation.notes !== undefined && typeof annotation.notes !== 'string') {
        return 'annotations notes values must be strings';
      }
    }
    return null;
  }

  async function handleRespondApproval(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const body = await readJsonBody<ApprovalResponseRequest>(req);
    if (!body || typeof body.approved !== 'boolean') {
      sendJson(res, 400, { error: 'approved is required', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    if (await commandCodeService?.findSession(sessionId)) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'Approvals are not supported for Command Code'));
      return;
    }
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    try {
      if (entry.sdkType === 'claude') {
        const resolvedKey = typeof claudeService.resolveAskUserQuestionKey === 'function'
          ? claudeService.resolveAskUserQuestionKey(requestId)
          : undefined;
        const pendingByLegacyKey = typeof claudeService.isPendingAskUserQuestion === 'function'
          && claudeService.isPendingAskUserQuestion(requestId);
        const questionKey = resolvedKey ?? (pendingByLegacyKey
          ? { requestId, toolCallId: requestId, sessionId }
          : undefined);

        if (questionKey) {
          // A globally valid question id is not authority to answer it through
          // another session's route.
          if (questionKey.sessionId !== sessionId) {
            sendJson(res, 404, enrichedErrorBody(ErrorCode.APPROVAL_REQUEST_NOT_FOUND, 'Approval request not found for this session'));
            return;
          }
          const isCancel = body.cancelled === true;
          const answersError = validateStringRecord(body.answers, 'answers');
          const annotationsError = validateAskUserQuestionAnnotations(body.annotations);
          if (!isCancel && (answersError || annotationsError)) {
            sendJson(res, 400, { error: answersError ?? annotationsError, code: ErrorCode.INVALID_REQUEST });
            return;
          }
          const resolution: { answers?: Record<string, string>; annotations?: Record<string, { preview?: string; notes?: string }>; cancelled?: boolean } = {};
          if (isCancel) resolution.cancelled = true;
          else {
            if (body.answers) resolution.answers = body.answers;
            if (body.annotations) resolution.annotations = body.annotations;
          }
          const resolved = claudeService.respondToAskUserQuestion(questionKey.requestId, resolution);
          if (!resolved) {
            logger.warn(`AskUserQuestion response ignored because request is no longer pending: ${questionKey.requestId}`);
            sendJson(res, 409, enrichedErrorBody(ErrorCode.ASK_ALREADY_CLOSED,
              'That question already closed, so the answer was not delivered to the assistant.'));
            return;
          }
          const closeReason = isCancel ? 'cancelled' : 'answered';
          broker.publish(sessionId, {
            type: 'ask_user_question_closed',
            sessionId,
            timestamp: Date.now(),
            data: {
              requestId: questionKey.requestId,
              toolCallId: questionKey.toolCallId,
              reason: closeReason,
            },
          });
          logger.info(`AskUserQuestion resolved: session=${sessionId} requestId=${questionKey.requestId} toolCallId=${questionKey.toolCallId}`);
          sendJson(res, 200, {
            success: true,
            approved: body.approved,
            resolved: true,
            kind: 'ask_user_question',
            sessionId,
            requestId: questionKey.requestId,
            toolCallId: questionKey.toolCallId,
          } satisfies ApprovalResponseResult);
          return;
        }

        if (typeof claudeService.wasRecentlyResolvedAskUserQuestion === 'function'
          && claudeService.wasRecentlyResolvedAskUserQuestion(requestId)) {
          sendJson(res, 409, enrichedErrorBody(ErrorCode.ASK_ALREADY_CLOSED,
            'That question already closed, so the answer was not delivered to the assistant.'));
          return;
        }
        if (typeof claudeService.hasChannelSession === 'function'
          && claudeService.hasChannelSession(sessionId)) {
          claudeService.sendPermissionResponse(sessionId, requestId, body.approved);
        } else {
          sendJson(res, 404, enrichedErrorBody(ErrorCode.APPROVAL_REQUEST_NOT_FOUND, 'Approval request not found for this session'));
          return;
        }
      } else if (entry.sdkType === 'opencode') {
        await opencodeService.replyPermission(sessionId, requestId, body.approved);
      } else {
        sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'Approval responses are not supported for Pi sessions'));
        return;
      }

      sendJson(res, 200, {
        success: true,
        approved: body.approved,
      } satisfies ApprovalResponseResult);
    } catch (err) {
      logger.errorObject('Approval response failed', err);
      sendJson(res, 500, { error: 'Approval response failed', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function abortRuntimeTurn(sessionId: string, runtime: SessionRuntime): Promise<void> {
    if (runtime === 'commandcode') {
      await commandCodeService?.abort(sessionId);
      return;
    }
    if (runtime === 'claude') {
      claudeService.abort(sessionId);
      return;
    }
    if (runtime === 'opencode') {
      opencodeService.abort(sessionId);
      return;
    }
    if (runtime === 'antigravity') {
      antigravityService.abort(sessionId);
      return;
    }
    const entry = await sessionRegistry.get(sessionId);
    const agentSession = entry ? multiSessionManager.getAgentSession(entry.path) : undefined;
    await agentSession?.abort().catch(() => { /* best-effort runtime fencing */ });
  }

  function isSyntheticTerminalEvent(event: NormalizedEvent): boolean {
    return event.type === 'agent_end'
      && event.data !== null
      && typeof event.data === 'object'
      && !Array.isArray(event.data)
      && (event.data as Record<string, unknown>).synthetic === true;
  }

  function queuedUserMessageMatches(event: unknown, expected: string): boolean {
    if (!event || typeof event !== 'object') return false;
    const candidate = event as {
      type?: unknown;
      data?: { message?: { role?: unknown; content?: unknown } };
    };
    const message = candidate.data?.message;
    if (candidate.type !== 'message_start' || message?.role !== 'user') return false;
    const content = message.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('')
        : '';
    return text === expected;
  }

  function removeQueuedPiRun(sessionId: string, runId: string): void {
    const queue = queuedPiRuns.get(sessionId) ?? [];
    const removed = queue.find((item) => item.runId === runId);
    const remaining = queue.filter((item) => item.runId !== runId);
    if (remaining.length > 0) {
      queuedPiRuns.set(sessionId, remaining);
      return;
    }
    queuedPiRuns.delete(sessionId);
    queuedPiEventChains.delete(sessionId);
    queuedPiLastFollowUp.delete(sessionId);
    const observer = queuedPiObservers.get(sessionId);
    if (observer) {
      if (removed) multiSessionManager.removeApiObserver(removed.sessionPath, observer);
      queuedPiObservers.delete(sessionId);
    }
  }

  /** Register the per-session queued-run correlation cleanup with the disposal
   * registry (once per session) so handleDeleteSession/shutdown drop the queue,
   * observer, follow-up snapshot, and direct-dispatch tokens in one place. */
  function ensureQueuedRunDisposal(sessionId: string): void {
    if (queuedRunDisposalRegistered.has(sessionId)) return;
    queuedRunDisposalRegistered.add(sessionId);
    disposal.register(sessionId, 'pi-queued-run-correlation', () => {
      const obs = queuedPiObservers.get(sessionId);
      const queue = queuedPiRuns.get(sessionId);
      if (obs && queue) {
        for (const item of queue) multiSessionManager.removeApiObserver(item.sessionPath, obs);
      }
      queuedPiRuns.delete(sessionId);
      queuedPiObservers.delete(sessionId);
      queuedPiEventChains.delete(sessionId);
      queuedPiLastFollowUp.delete(sessionId);
      activeDirectDispatchTokens.delete(sessionId);
      nextDirectDispatchToken.delete(sessionId);
    });
  }

  function ensureQueuedPiObserver(sessionId: string, sessionPath: string): void {
    if (queuedPiObservers.has(sessionId)) return;
    const observer = (event: unknown) => {
      const previous = queuedPiEventChains.get(sessionId) ?? Promise.resolve();
      const next = previous.then(async () => {
        const queue = queuedPiRuns.get(sessionId);
        if (!queue?.length) return;
        const normalized = event as NormalizedEvent;
        if (normalized.type === 'queue_update') {
          const data = normalized.data as { followUp?: unknown } | undefined;
          if (Array.isArray(data?.followUp) && data.followUp.every((item) => typeof item === 'string')) {
            const current = data.followUp as string[];
            const previous = queuedPiLastFollowUp.get(sessionId) ?? current;
            const removedIndexes: number[] = [];
            // SDK queue additions append and emit their own queue_update. Only
            // a shorter ordered snapshot can prove removal; treating growth or
            // substitution as removal would arm a receipt before delivery.
            if (current.length < previous.length) {
              let currentIndex = current.length - 1;
              for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex -= 1) {
                if (currentIndex >= 0 && previous[previousIndex] === current[currentIndex]) {
                  currentIndex -= 1;
                } else {
                  removedIndexes.unshift(previousIndex);
                }
              }
            }
            for (const removedIndex of removedIndexes) {
              for (const pending of queue.filter((item) => !item.delivered && item.queueIndex !== undefined)) {
                if (pending.queueIndex === removedIndex) pending.awaitingMessageStart = true;
                else if ((pending.queueIndex as number) > removedIndex) pending.queueIndex = (pending.queueIndex as number) - 1;
              }
            }
            queuedPiLastFollowUp.set(sessionId, [...current]);
          }
        }
        const active = queue.find((item) => item.delivered);
        if (active) {
          await runReceipts.observeEvent(active.runId, normalized);
          if (normalized.type === 'agent_end' && !isSyntheticTerminalEvent(normalized)) {
            await runReceipts.finish(active.runId, { status: 'completed' });
            removeQueuedPiRun(sessionId, active.runId);
          }
          return;
        }

        const pending = queue[0];
        if (!pending?.awaitingMessageStart || !queuedUserMessageMatches(normalized, pending.message)) return;
        pending.delivered = true;
        await runReceipts.markStarted(pending.runId);
        await runReceipts.observeEvent(pending.runId, normalized);
      }).catch((error) => {
        logger.warn(`Failed to correlate queued Pi follow-up for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      queuedPiEventChains.set(sessionId, next);
    };
    queuedPiObservers.set(sessionId, observer);
    multiSessionManager.addApiObserver(sessionPath, observer);
  }

  async function queuePiFollowUp(sessionId: string, message: string, runId: string): Promise<void> {
    const entry = await sessionRegistry.get(sessionId);
    if (!entry || entry.sdkType !== 'pi') throw new Error(`Pi session not found: ${sessionId}`);
    await multiSessionManager.subscribeClient(internalClientId, entry.path);
    const correlation: QueuedPiRunCorrelation = {
      runId,
      message,
      delivered: false,
      awaitingMessageStart: false,
      sessionPath: entry.path,
    };
    const releaseModelLock = await acquirePiModelLock(sessionId);
    let modelLockOwnedByRun = false;
    try {
      const agentSession = multiSessionManager.getAgentSession(entry.path);
      if (!agentSession) throw new Error(`Pi session not loaded: ${sessionId}`);
      assertResolvedPiModelAllowed(
        agentSession.model ? `${agentSession.model.provider}/${agentSession.model.id}` : entry.model,
        blockedPiProviders,
      );
      attachPiObserverIfNeeded(entry.path);
      const queue = queuedPiRuns.get(sessionId) ?? [];
      queue.push(correlation);
      queuedPiRuns.set(sessionId, queue);
      ensureQueuedRunDisposal(sessionId);
      ensureQueuedPiObserver(sessionId, entry.path);
      await agentSession.followUp(message);
      const followUpQueue = agentSession.getFollowUpMessages();
      const queueIndex = followUpQueue.length - 1;
      const queuedMessage = followUpQueue[queueIndex];
      if (queueIndex < 0 || typeof queuedMessage !== 'string') {
        throw new Error(`Pi SDK did not expose the accepted follow-up queue entry for run ${runId}`);
      }
      correlation.message = queuedMessage;
      correlation.queueIndex = queueIndex;
      queuedPiLastFollowUp.set(sessionId, [...followUpQueue]);
      modelLockOwnedByRun = true;
      void runReceipts.waitForTerminal(runId).then(() => {
        removeQueuedPiRun(sessionId, runId);
        releaseModelLock();
      }).catch(() => {
        removeQueuedPiRun(sessionId, runId);
        releaseModelLock();
      });
    } catch (error) {
      removeQueuedPiRun(sessionId, runId);
      throw error;
    } finally {
      if (!modelLockOwnedByRun) releaseModelLock();
      await multiSessionManager.unsubscribeClient(internalClientId, entry.path);
    }
  }

  async function executePrompt(
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    mode: PromptMode,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error, cessationBasis?: 'documented_handler_return') => void,
    turnToken?: number,
    runId?: string,
  ): Promise<void> {
    // Wrap onEvent so every event also flows into the broker. This lets
    // long-lived subscribers (e.g. GET /sessions/:id/events) observe the
    // turn regardless of which client started it.
    const broadcast = (event: NormalizedEvent) => {
      broker.publish(sessionId, event);
      try { onEvent(event); } catch { /* non-fatal */ }
    };

    switch (runtime) {
      case 'commandcode': {
        if (!commandCodeService) throw new Error('Command Code service is not configured');
        return new Promise<void>((resolve) => {
          const wrappedComplete = (error?: Error) => {
            onComplete(error);
            resolve();
          };
          commandCodeService.sendPrompt(sessionId, message, broadcast, wrappedComplete, runId).catch((error) => {
            onComplete(error instanceof Error ? error : new Error(String(error)));
            resolve();
          });
        });
      }

      case 'claude': {
        return new Promise<void>((resolve) => {
          const wrappedComplete = (error?: Error) => {
            onComplete(error);
            resolve();
          };
          claudeService.sendPrompt(sessionId, message, broadcast, wrappedComplete).catch((err) => {
            onComplete(err instanceof Error ? err : new Error(String(err)));
            resolve();
          });
        });
      }

      case 'opencode': {
        return new Promise<void>((resolve) => {
          const wrappedComplete = (error?: Error) => {
            onComplete(error);
            resolve();
          };
          opencodeService.sendPrompt(sessionId, message, broadcast, wrappedComplete).catch((err) => {
            onComplete(err instanceof Error ? err : new Error(String(err)));
            resolve();
          });
        });
      }

      case 'antigravity': {
        return new Promise<void>((resolve) => {
          const wrappedComplete = (error?: Error) => {
            onComplete(error);
            resolve();
          };
          antigravityService.sendPrompt(sessionId, message, broadcast, wrappedComplete).catch((err) => {
            onComplete(err instanceof Error ? err : new Error(String(err)));
            resolve();
          });
        });
      }

      case 'pi':
      default: {
        const entry = await sessionRegistry.get(sessionId);
        if (!entry) {
          throw new Error(`Pi session not found: ${sessionId}`);
        }
        const sessionPath = entry.path;
        await multiSessionManager.subscribeClient(internalClientId, sessionPath);
        await pinExpiry?.reapplyForSession(sessionId);
        try {
        await withPiModelLock(sessionId, async () => {
        const agentSession = multiSessionManager.getAgentSession(sessionPath);
        if (!agentSession) {
          throw new Error(`Pi session not loaded: ${sessionId}`);
        }
        assertResolvedPiModelAllowed(
          agentSession.model ? `${agentSession.model.provider}/${agentSession.model.id}` : entry.model,
          blockedPiProviders,
        );

        // Attach a long-lived observer so broker subscribers receive events
        // even if a future prompt is started by another client.
        attachPiObserverIfNeeded(sessionPath);

        // Per-prompt observer that forwards events to this prompt's caller.
        // (The persistent observer only feeds the broker.)
        const eventObserver = (event: unknown) => {
          try { onEvent(event as NormalizedEvent); } catch { /* non-fatal */ }
        };
        multiSessionManager.addApiObserver(sessionPath, eventObserver);

        let ended = false;
        let resolveTurnBoundary!: () => void;
        const turnBoundary = new Promise<void>((resolve) => { resolveTurnBoundary = resolve; });
        const endObserver = (event: unknown) => {
          const normalized = event as NormalizedEvent;
          const ownsTurn = turnToken === undefined || activeDirectDispatchTokens.get(sessionId) === turnToken;
          if (normalized.type === 'agent_end' && !isSyntheticTerminalEvent(normalized) && ownsTurn && !ended) {
            ended = true;
            multiSessionManager.removeApiObserver(sessionPath, endObserver);
            multiSessionManager.removeApiObserver(sessionPath, eventObserver);
            onComplete();
            resolveTurnBoundary();
          }
        };
        multiSessionManager.addApiObserver(sessionPath, endObserver);

        try {
          if (mode === 'follow_up') {
            await agentSession.followUp(message);
          } else if (mode === 'steer') {
            await agentSession.steer(message);
          } else {
            await agentSession.prompt(message);
          }
          // Pi extension slash commands are handled synchronously by prompt()
          // and do not emit an agent_end turn event. Their handler return is a
          // documented command boundary, unlike an ordinary LLM prompt return.
          if (!ended && mode === 'prompt' && /^\s*\//.test(message)) {
            ended = true;
            multiSessionManager.removeApiObserver(sessionPath, endObserver);
            multiSessionManager.removeApiObserver(sessionPath, eventObserver);
            onComplete(undefined, 'documented_handler_return');
            resolveTurnBoundary();
          }
        } catch (err) {
          multiSessionManager.removeApiObserver(sessionPath, endObserver);
          multiSessionManager.removeApiObserver(sessionPath, eventObserver);
          if (!ended) {
            ended = true;
            onComplete(err instanceof Error ? err : new Error(String(err)));
            resolveTurnBoundary();
          }
        }
        // Pi's prompt promise can resolve at an auto-compaction boundary while
        // the same AgentSession resumes asynchronously. The normalized
        // agent_end event—not prompt() return—is the true terminal turn signal.
        await turnBoundary;
        });
        } finally {
          multiSessionManager.unsubscribeClient(internalClientId, sessionPath);
        }
        break;
      }
    }
  }

  // ─── New orchestration endpoints ─────────────────────────────────────────

  async function handleSessionEvents(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const commandCodeEntry = await commandCodeService?.findSession(sessionId);
    const entry = commandCodeEntry ? undefined : await sessionRegistry.get(sessionId);
    if (!entry && !commandCodeEntry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    // For Pi sessions, eagerly attach the long-lived broker observer so
    // events emitted by any future prompt reach this subscriber.
    if (entry?.sdkType === 'pi') {
      attachPiObserverIfNeeded(entry.path);
    }

    const brokerSessionId = commandCodeEntry?.sessionId ?? sessionId;
    const sse = createSSEStream(res);

    const unsub = broker.subscribe(brokerSessionId, (event) => {
      sse.write(event.type, event);
    }, true, 'sse');

    // Own the live SSE stream + its heartbeat timer in the disposal registry.
    // broker.clear() drops broker subscribers but CANNOT close this HTTP
    // response (the broker holds no req/res), so without this handle a deleted
    // session would leave an open SSE connection + 15s heartbeat until the
    // client disconnects. On delete, disposal closes the stream cleanly.
    const unregisterDispose = disposal.register(brokerSessionId, 'sse-events-stream', () => {
      unsub();
      try { sse.complete({ reason: 'session_deleted' }); } catch { /* already closed */ }
    });

    // Keep this handler alive until the client disconnects. Without this,
    // Node may consider the GET request "complete" (it has no body) and
    // garbage-collect the response, closing the SSE stream prematurely.
    // Awaiting the close promise guarantees the response object survives
    // for the lifetime of the subscription.
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        unsub();
        unregisterDispose(); // normal client disconnect removes the handle (no stale handle)
        resolve();
      };
      sse.res.on('close', cleanup);
      sse.res.on('error', cleanup);
      req.on('aborted', cleanup);
      req.on('error', cleanup);
    });
  }

  async function handleSessionWait(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    const commandCodeEntry = await commandCodeService?.findSession(sessionId);
    if (commandCodeEntry) {
      const timeoutMs = Math.min(Math.max(parseInt(query.get('timeout') || '60000', 10), 0), 300000);
      const start = Date.now();
      const pollCommandCode = (): void => {
        const status: WaitResponse['status'] = commandCodeService!.isRunning(commandCodeEntry.sessionId) ? 'running' : 'idle';
        const elapsed = Date.now() - start;
        if (status === (query.get('status') || 'idle') || elapsed >= timeoutMs) {
          sendJson(res, 200, { sessionId: commandCodeEntry.sessionId, status: status === (query.get('status') || 'idle') ? status : 'timeout', waitedMs: elapsed } satisfies WaitResponse);
          return;
        }
        setTimeout(pollCommandCode, Math.min(500, timeoutMs - elapsed));
      };
      pollCommandCode();
      return;
    }
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    const targetStatus = (query.get('status') || 'idle') as WaitResponse['status'];
    const timeoutMs = Math.min(Math.max(parseInt(query.get('timeout') || '60000', 10), 0), 300000);
    const start = Date.now();

    const checkStatus = (): WaitResponse['status'] => {
      switch (entry.sdkType) {
        case 'claude':
          return claudeService.isRunning(sessionId) ? 'running' : 'idle';
        case 'opencode':
          return opencodeService.isRunning(sessionId) ? 'running' : 'idle';
        case 'antigravity':
          return antigravityService.isRunning(sessionId) ? 'running' : 'idle';
        case 'pi': {
          if (runReceipts.hasActiveRun(sessionId)) return 'running';
          const agentSession = multiSessionManager.getAgentSession(entry.path);
          if (!agentSession) return 'idle';
          // Pi agentSession has no synchronous isStreaming flag we can rely on
          // across module boundaries, so fall back to registry status.
          return entry.status === 'running' ? 'running' : 'idle';
        }
        default:
          return 'idle';
      }
    };

    const poll = (): void => {
      const current = checkStatus();
      const elapsed = Date.now() - start;
      if (current === targetStatus) {
        sendJson(res, 200, {
          sessionId,
          status: current,
          waitedMs: elapsed,
        } satisfies WaitResponse);
        return;
      }
      if (elapsed >= timeoutMs) {
        sendJson(res, 200, {
          sessionId,
          status: 'timeout',
          waitedMs: elapsed,
        } satisfies WaitResponse);
        return;
      }
      setTimeout(poll, Math.min(500, timeoutMs - elapsed));
    };

    poll();
  }

  /**
   * Resolve a session by ANY identifier form — internal id, registry path,
   * Claude session id, OpenCode session id, or Antigravity conversation id.
   * Mirrors scripts/debug-where.mjs `findSessionEntry` so the screen-view and
   * transcript endpoints accept whatever id form the user reads off the UI.
   */
  async function resolveSessionEntry(identifier: string): Promise<RegistryEntry | undefined> {
    // Fast path: the common case is the internal id.
    const byId = await sessionRegistry.get(identifier);
    if (byId) return byId;
    const entries = await sessionRegistry.listAll();
    return entries.find(
      (e) =>
        e.path === identifier ||
        e.claudeSessionId === identifier ||
        e.opencodeSessionId === identifier ||
        e.antigravityConversationId === identifier,
    );
  }

  /** Parse `?expand=tools,thinking` into the projection options. */
  function parseScreenViewExpand(raw: string | null): { tools?: boolean; thinking?: boolean } {
    if (!raw) return {};
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const expand: { tools?: boolean; thinking?: boolean } = {};
    if (parts.includes('tools')) expand.tools = true;
    if (parts.includes('thinking')) expand.thinking = true;
    return expand;
  }

  /**
   * Resolve a Pi session file from a registry entry path.
   *
   * Pi registry entries store a session *directory* (e.g.
   * `~/.pi/agent/sessions/--root-pi-web-ui--/`), not a single `.jsonl` file.
   * This resolver picks the best `.jsonl` to feed into the replay-event reader
   * (`piSessionToReplayEvents`), using three strategies in order:
   *
   * 1. If `entryPath` is already a `.jsonl` file, use it directly.
   * 2. If the session is active in `multiSessionManager`, use the live agent's
   *    session file (the one the Pi SDK is actively writing to).
   * 3. Otherwise scan the directory for `*.jsonl` files and return the most
   *    recently modified one.
   *
   * Returns `null` when no readable `.jsonl` file can be found — callers
   * should treat that as an empty/valid-thin session.
   */
  async function resolvePiSessionFile(entryPath: string): Promise<string | null> {
    // 1. Already a .jsonl file — straightforward.
    try {
      const st = await stat(entryPath);
      if (st.isFile() && entryPath.endsWith('.jsonl')) {
        return entryPath;
      }
    } catch {
      // Path doesn't exist or is not stat-able — fall through.
    }

    // 2. Active Pi session — prefer the file the live agent is writing to.
    //    Iterate active sessions and pick the first whose sessionPath lives
    //    under the entry directory and still exists on disk.
    const allStatuses = multiSessionManager.getAllSessionStatuses();
    for (const status of allStatuses) {
      if (
        status.sessionPath.startsWith(entryPath) &&
        status.sessionPath.endsWith('.jsonl')
      ) {
        try {
          await stat(status.sessionPath);
          return status.sessionPath;
        } catch {
          continue; // stale reference — keep scanning.
        }
      }
    }

    // 3. Scan directory for .jsonl files, pick the most recently modified.
    try {
      const dirEntries = await readdir(entryPath);
      const jsonlFiles = dirEntries.filter((f) => f.endsWith('.jsonl'));
      if (jsonlFiles.length === 0) return null;

      let bestPath: string | null = null;
      let bestTime = 0;
      for (const file of jsonlFiles) {
        const fullPath = path.join(entryPath, file);
        try {
          const st = await stat(fullPath);
          if (st.mtimeMs > bestTime) {
            bestTime = st.mtimeMs;
            bestPath = fullPath;
          }
        } catch {
          // Skip unreadable entries.
        }
      }
      return bestPath;
    } catch {
      return null;
    }
  }

  /**
   * Load the common replay-event stream for a session, per runtime. All four
   * runtimes reduce to the same flat event shape so the shared projection can
   * consume them uniformly. Read-only — none of these loaders mutate state.
   */
  async function loadScreenViewEvents(entry: RegistryEntry): Promise<Array<Record<string, unknown>>> {
    switch (entry.sdkType) {
      case 'pi': {
        const resolved = await resolvePiSessionFile(entry.path);
        if (!resolved) return [];
        return await piSessionToReplayEvents(resolved);
      }
      case 'claude':
        return await claudeService.getReplayEvents(entry.id);
      case 'opencode':
        return await opencodeService.getReplayEvents(entry.id);
      case 'antigravity':
        return await antigravityService.getReplayEvents(entry.id);
      default:
        return [];
    }
  }

  /**
   * Build and return the read-only screen view for a resolved session. Never
   * starts a session, sends a prompt, or writes registry/session state — it
   * only reads replay events and runs the pure shared projection. A thin/empty
   * session yields a valid (empty) view rather than an error.
   */
  async function handleScreenView(
    res: ServerResponse,
    entry: RegistryEntry,
    query: URLSearchParams,
  ): Promise<void> {
    const expand = parseScreenViewExpand(query.get('expand'));
    let events: Array<Record<string, unknown>>;
    try {
      events = await loadScreenViewEvents(entry);
    } catch (err) {
      logger.errorObject('Failed to load screen-view events', err);
      sendJson(res, 500, { error: 'Failed to build screen view', code: ErrorCode.INTERNAL_ERROR });
      return;
    }

    const screenView = projectDefaultViewFromEvents(events, { expand });
    const markdown = renderScreenViewMarkdown(screenView);

    sendJson(res, 200, {
      sessionId: entry.id,
      runtime: entry.sdkType as SessionRuntime,
      view: 'screen',
      expanded: screenView.expanded,
      screenView,
      markdown,
      source: {
        sessionId: entry.id,
        displayName: entry.firstMessage?.slice(0, 50) ?? entry.id,
        sdkType: entry.sdkType,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
      },
    } satisfies ScreenViewResponse);
  }

  async function loadSessionTranscript(
    entry: RegistryEntry,
    scope: 'visible_recent' | 'visible_full',
  ): Promise<{ transcript: VisibleTranscript; error?: string }> {
    const source = {
      sessionId: entry.id,
      displayName: entry.firstMessage?.slice(0, 50) ?? entry.id,
      sdkType: entry.sdkType,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
    };

    if (entry.sdkType === 'pi') {
      const adapted = await extractPiTranscript(entry.path, source, scope);
      return adapted;
    }
    if (entry.sdkType === 'claude') {
      return extractClaudeTranscript(
        (sid) => claudeService.loadSessionHistory(sid),
        entry.id,
        source,
        scope,
      );
    }
    if (entry.sdkType === 'opencode') {
      return extractOpenCodeTranscript(opencodeService, entry.id, source, scope);
    }
    if (entry.sdkType === 'antigravity') {
      const events = await antigravityService.getReplayEvents(entry.id);
      const { replayEventsToVisibleItems, buildVisibleTranscript } = await import('../../session-transfer/visible-transcript.js');
      return {
        transcript: buildVisibleTranscript(replayEventsToVisibleItems(events), source, scope),
      };
    }
    return {
      transcript: {
        scope,
        itemCount: 0,
        truncated: false,
        items: [],
        source,
      },
      error: `Transcript not supported for runtime: ${entry.sdkType}`,
    };
  }

  async function handleSessionTranscript(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    try {
      const commandCodeEntry = await commandCodeService?.findSession(sessionId);
      if (commandCodeEntry) {
        if (query.get('view') === 'screen') {
          const events = await commandCodeService!.getReplayEvents(commandCodeEntry.sessionId);
          const screenView = projectDefaultViewFromEvents(commandCodeEventsToScreenEvents(events), { expand: parseScreenViewExpand(query.get('expand')) });
          sendJson(res, 200, {
            sessionId: commandCodeEntry.sessionId, runtime: 'commandcode', view: 'screen', expanded: screenView.expanded,
            screenView, markdown: renderScreenViewMarkdown(screenView),
            source: { sessionId: commandCodeEntry.sessionId, displayName: commandCodeEntry.firstMessage?.slice(0, 50) || commandCodeEntry.sessionId, sdkType: 'commandcode', cwd: commandCodeEntry.cwd, createdAt: commandCodeEntry.createdAt, lastActivity: commandCodeEntry.updatedAt },
          } satisfies ScreenViewResponse);
        } else {
          const scope = query.get('scope') === 'visible_full' ? 'visible_full' : 'visible_recent';
          sendJson(res, 200, await commandCodeTranscript(commandCodeEntry, scope));
        }
        return;
      }
      const entry = await resolveSessionEntry(sessionId);
      if (!entry) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }

      // view=screen → faithful read-only "what the user sees" projection.
      // Additive: when `view` is absent the existing transcript behaviour is
      // unchanged (regression-safe).
      if (query.get('view') === 'screen') {
        await handleScreenView(res, entry, query);
        return;
      }

      const scope = (query.get('scope') === 'visible_full' ? 'visible_full' : 'visible_recent') as
        | 'visible_recent'
        | 'visible_full';

      const loaded = await loadSessionTranscript(entry, scope);
      const transcriptResult = loaded.transcript;
      const transcriptError = loaded.error;
      if (transcriptError && transcriptResult.itemCount === 0) {
        sendJson(res, 404, { error: transcriptError, code: ErrorCode.EMPTY_TRANSCRIPT });
        return;
      }

      const t = transcriptResult;
      sendJson(res, 200, {
        sessionId: entry.id,
        runtime: entry.sdkType as SessionRuntime,
        scope: t.scope,
        itemCount: t.itemCount,
        truncated: t.truncated,
        items: t.items,
        source: t.source,
      } satisfies TranscriptResponse);
    } catch (err) {
      logger.errorObject('Failed to build transcript', err);
      sendJson(res, 500, { error: 'Failed to build transcript', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function handleSessionTransfer(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await readJsonBody<TransferSessionRequest>(req);
    if (!body) {
      sendJson(res, 400, { error: 'Request body required', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    const targetSdk = body.createNew && !body.targetRuntime ? undefined : body.targetRuntime;
    if (body.createNew && !body.targetRuntime) {
      sendJson(res, 400, { error: 'targetRuntime is required when createNew is true', code: ErrorCode.INVALID_REQUEST });
      return;
    }
    if (targetSdk === 'commandcode') {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'Session transfer to Command Code is not supported'));
      return;
    }

    if (await commandCodeService?.findSession(sessionId)) {
      sendJson(res, 400, enrichedErrorBody(ErrorCode.UNSUPPORTED_OPERATION, 'Session transfer is not supported for Command Code'));
      return;
    }
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Source session not found'));
      return;
    }

    // Lazy-import the Pi session dir resolution. Default matches the
    // multi-session-manager's convention.
    const piSessionDir = config.sessionDir
      || process.env.PI_SESSIONS_DIR
      || `${config.piAgentDir}/sessions`;

    const transferService = new TransferService({
      registry: sessionRegistry,
      claudeService,
      opencodeService,
      antigravityService,
      piSessionDir,
      isPiSessionBusy: (sessionPath: string) => {
        const status = multiSessionManager.getSessionStatus(sessionPath)?.status;
        return status === 'busy' || status === 'streaming';
      },
      abortPiPrompt: (sessionPath: string) => multiSessionManager.abort(sessionPath),
      createPiSession: async (cwd: string) => {
        const status = await multiSessionManager.createAndSubscribe(internalClientId, cwd);
        const createdModel = multiSessionManager.getAgentSession(status.sessionPath)?.model;
        try {
          assertResolvedPiModelAllowed(
            createdModel ? `${createdModel.provider}/${createdModel.id}` : undefined,
            blockedPiProviders,
          );
        } catch (error) {
          multiSessionManager.unsubscribeClient(internalClientId, status.sessionPath);
          multiSessionManager.disposeLoadedSession?.(status.sessionPath);
          await unlink(status.sessionPath).catch(() => undefined);
          await sessionRegistry.delete(status.sessionId);
          throw error;
        }
        return { sessionId: status.sessionId, sessionPath: status.sessionPath };
      },
      sendPiPrompt: async (sessionPath: string, message: string, onEvent: (event: unknown) => void, cwd?: string) => {
        const transferClientId = `${internalClientId}-transfer`;
        let hydrated = false;
        if (!multiSessionManager.getSessionStatus(sessionPath)) {
          await multiSessionManager.subscribeClient(transferClientId, sessionPath, cwd);
          hydrated = true;
        }
        const targetSessionId = multiSessionManager.getAgentSession(sessionPath)?.sessionId;
        if (!targetSessionId) {
          if (hydrated) multiSessionManager.unsubscribeClient(transferClientId, sessionPath);
          throw new Error(`Pi session not loaded: ${sessionPath}`);
        }
        try {
          await withPiModelLock(targetSessionId, async () => {
            const targetModel = multiSessionManager.getAgentSession(sessionPath)?.model;
            assertResolvedPiModelAllowed(
              targetModel ? `${targetModel.provider}/${targetModel.id}` : undefined,
              blockedPiProviders,
            );
            let observing = true;
            const transferObserver = (event: unknown) => {
              onEvent(event);
              if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'agent_start') {
                // The transfer response is acceptance-based, so do not retain
                // an observer for a later/stalled target turn.
                multiSessionManager.removeApiObserver(sessionPath, transferObserver);
                observing = false;
              }
            };
            multiSessionManager.addApiObserver(sessionPath, transferObserver);
            try {
              await multiSessionManager.prompt(sessionPath, message);
            } finally {
              if (observing) multiSessionManager.removeApiObserver(sessionPath, transferObserver);
            }
          });
        } finally {
          if (hydrated) multiSessionManager.unsubscribeClient(transferClientId, sessionPath);
        }
      },
    });

    try {
      if (!body.createNew && body.targetSessionId) {
        const targetEntry = await sessionRegistry.get(body.targetSessionId)
          ?? await sessionRegistry.getByPath(body.targetSessionId);
        if (targetEntry) {
          const policyError = piProviderPolicyError(targetEntry);
          if (policyError) {
            const response: TransferSessionResponse = {
              success: false,
              sourceSessionId: sessionId,
              targetSessionId: targetEntry.id,
              createdNewSession: false,
              targetRuntime: 'pi',
              error: { code: policyError.code, message: policyError.message },
            };
            sendJson(res, 403, response);
            return;
          }
        }
      }

      const result = await transferService.executeTransfer({
        sourceSessionId: sessionId,
        targetSessionId: body.targetSessionId,
        createNew: body.createNew,
        targetSdkType: targetSdk,
        targetCwd: body.targetCwd ?? entry.cwd,
        scope: body.scope ?? 'visible_recent',
        sourceDisplayName: body.sourceDisplayName,
      });

      if (result.success && result.createdNewSession && result.targetSessionId) {
        onSessionCreated?.(result.targetSessionId, result.targetSessionPath ?? result.targetSessionId, result.targetSdkType ?? 'pi');
      }

      const response: TransferSessionResponse = {
        success: result.success,
        sourceSessionId: result.sourceSessionId,
        targetSessionId: result.targetSessionId || undefined,
        createdNewSession: result.createdNewSession,
        targetSessionPath: result.targetSessionPath,
        targetRuntime: (result.targetSdkType as SessionRuntime | undefined) ?? (targetSdk as SessionRuntime | undefined),
        error: result.error,
      };
      const responseStatus = result.success
        ? 200
        : result.error?.code === ErrorCode.PROVIDER_NOT_ALLOWED
          ? 403
          : 400;
      sendJson(res, responseStatus, response);
    } catch (err) {
      logger.errorObject('Transfer failed', err);
      sendJson(res, 500, {
        success: false,
        sourceSessionId: sessionId,
        createdNewSession: false,
        error: {
          code: ErrorCode.TRANSFER_DISPATCH_FAILED,
          message: err instanceof Error ? err.message : 'Transfer failed',
        },
      } satisfies TransferSessionResponse);
    }
  }

  async function handleBatchCreate(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readJsonBody<unknown>(req);
    const parsed = batchCreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      sendJson(res, 400, {
        error: parsed.error.issues[0]?.message ?? 'sessions[] is required and must be non-empty',
        code: ErrorCode.INVALID_REQUEST,
        details: parsed.error.issues,
      });
      return;
    }
    const body: BatchCreateRequest = { sessions: parsed.data.sessions as BatchCreateEntry[] };

    const results = await mapWithConcurrency(body.sessions, BATCH_CONCURRENCY_LIMIT, async (entry, index) => {
      try {
        // Reuse the single-session create logic by invoking it against a
        // throwaway response collector, then translate to a result item.
        const { createOneSession } = await import('./batch-helpers.js');
        const created = await createOneSession({
          entry,
          deps: {
            claudeService,
            opencodeService,
            antigravityService,
            multiSessionManager,
            sessionRegistry,
            piService,
            internalClientId,
            cleanupRejectedSession: cleanupRejectedCreatedSession,
            blockedPiProviders,
            commandCodeService,
          },
        });
        onSessionCreated?.(created.sessionId, created.sessionPath, created.runtime);
        const result: BatchCreateResultItem = {
          index,
          success: true,
          sessionId: created.sessionId,
          sessionPath: created.sessionPath,
          runtime: created.runtime,
          model: created.model,
          modelSelector: created.modelSelector,
          executionInstanceId: created.executionInstanceId,
          effort: created.effort as BatchCreateResultItem['effort'],
          requestedEffort: created.effortSource === 'explicit' ? created.effort : undefined,
          acceptedEffort: created.effort,
          effortSource: created.effortSource,
          defaultEffort: created.defaultEffort,
          effortCapabilityHash: created.effortCapabilityHash,
          cwd: created.cwd,
        };
        // Optional per-entry create-time pin (see POST /sessions pin field).
        if (entry.pin) {
          const pinResult = pinExpiry
            ? await pinExpiry.applyPin(created.sessionId, {
                ttlSeconds: entry.pinTtlSeconds,
                sessionPath: created.sessionPath,
                runtime: created.runtime,
                label: 'internal-api:batch',
              })
            : await pinWithoutExpiry(created.sessionId);
          Object.assign(result, pinResponseFields(pinResult));
        }
        return result;
      } catch (err) {
        return {
          index,
          success: false,
          runtime: entry.runtime,
          error: {
            code: err instanceof RuntimeOpError
              ? err.code
              : err instanceof CommandCodeRuntimeError && err.code === 'permission_denied'
                ? ErrorCode.COMMANDCODE_ROLE_REFUSED
                : err instanceof CommandCodeRuntimeError && err.code === 'effort_unsupported'
                  ? ErrorCode.COMMANDCODE_EFFORT_UNSUPPORTED
                  : ErrorCode.SESSION_CREATE_FAILED,
            message: err instanceof Error ? err.message : 'Failed to create session',
          },
        };
      }
    });

    const createdCount = results.filter((r) => r.success).length;
    sendJson(res, 200, {
      created: results,
      createdCount,
      failedCount: results.length - createdCount,
    } satisfies BatchCreateResponse);
  }

  async function handleBatchPrompt(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readJsonBody<unknown>(req);
    const parsed = batchPromptBodySchema.safeParse(raw);
    if (!parsed.success) {
      sendJson(res, 400, {
        error: parsed.error.issues[0]?.message ?? 'prompts[] is required and must be non-empty',
        code: ErrorCode.INVALID_REQUEST,
        details: parsed.error.issues,
      });
      return;
    }
    const body: BatchPromptRequest = {
      prompts: parsed.data.prompts as BatchPromptRequest['prompts'],
      parallel: parsed.data.parallel,
    };

    const parallel = body.parallel !== false;

    const runOne = async (entry: BatchPromptRequest['prompts'][number], index: number): Promise<BatchPromptResultItem> => {
      const injection = detectPromptInjection(entry.message);
      if (injection.recommendation === 'block') {
        return {
          index,
          sessionId: entry.sessionId,
          success: false,
          error: { code: ErrorCode.PROMPT_INJECTION, message: 'Prompt blocked by safety filter' },
        };
      }
      let reservedRunId: string | undefined;
      try {
        const reg = await sessionRegistry.get(entry.sessionId);
        if (!reg) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            error: { code: ErrorCode.SESSION_NOT_FOUND, message: 'Session not found' },
          };
        }

        // Fail-closed BEFORE any receipt/admission/runtime call: a disabled
        // OpenCode must reject with the contracted error, not proceed to
        // dispatch (spawn/attach via ensureServer) or leave a started receipt.
        if (reg.sdkType === 'opencode' && !opencodeService.isEnabled()) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            error: { code: ErrorCode.OPENCODE_UNAVAILABLE, message: 'OpenCode runtime is disabled (OPENCODE_ENABLED=false)' },
          };
        }

        const beginInput = {
          sessionId: entry.sessionId,
          runtime: reg.sdkType as SessionRuntime,
          executionInstanceId: resolveExecutionInstanceId(reg),
          model: currentRunModel(reg),
          modelSelector: modelSelectorForEntry(reg),
          message: entry.message,
          mode: 'prompt' as const,
          verbosity: 'answers' as const,
          detach: false,
          idempotencyKey: entry.idempotencyKey,
          ...(reg.sdkType === 'pi' && config.validationMode
            ? { phase7Shadow: classifyPhase7PiShadow({ sessionId: entry.sessionId, message: entry.message }) }
            : {}),
        };

        // As with the single-prompt route, an idempotent retry must be
        // replayable while the runtime is still busy.
        try {
          if (entry.idempotencyKey !== undefined) {
            const existing = await runReceipts.findExistingRun(beginInput);
            if (existing?.kind === 'conflict') {
              return {
                index,
                sessionId: entry.sessionId,
                success: false,
                runId: existing.receipt.runId,
                receipt: existing.receipt,
                error: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT, message: 'Idempotency key was already used for a different prompt' },
              };
            }
            if (existing?.kind === 'duplicate') {
              const completed = existing.receipt.status === 'completed';
              return {
                index,
                sessionId: entry.sessionId,
                success: completed,
                runId: existing.receipt.runId,
                duplicate: true,
                receipt: existing.receipt,
                error: completed ? undefined : {
                  code: existing.receipt.errorCode ?? ErrorCode.SESSION_BUSY,
                  message: `Existing run is ${existing.receipt.status}`,
                },
              };
            }
          }
        } catch (error) {
          if (error instanceof IdempotencyKeyValidationError) {
            return {
              index,
              sessionId: entry.sessionId,
              success: false,
              error: { code: ErrorCode.INVALID_REQUEST, message: error.message },
            };
          }
          throw error;
        }

        const providerPolicyError = piProviderPolicyError(reg);
        if (providerPolicyError) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            error: { code: providerPolicyError.code, message: providerPolicyError.message },
          };
        }

        const isBusy = reg.sdkType === 'claude'
          ? claudeService.isRunning(entry.sessionId)
          : reg.sdkType === 'opencode'
            ? opencodeService.isRunning(entry.sessionId)
            : false;
        if (isBusy) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            error: { code: ErrorCode.SESSION_BUSY, message: 'Session is currently busy' },
          };
        }

        let reservation;
        try {
          reservation = await runReceipts.beginRun(beginInput);
        } catch (error) {
          if (error instanceof IdempotencyKeyValidationError) {
            return {
              index,
              sessionId: entry.sessionId,
              success: false,
              error: { code: ErrorCode.INVALID_REQUEST, message: error.message },
            };
          }
          throw error;
        }

        if (reservation.kind === 'conflict') {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId: reservation.receipt.runId,
            receipt: reservation.receipt,
            error: { code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT, message: 'Idempotency key was already used for a different prompt' },
          };
        }
        if (reservation.kind === 'duplicate') {
          const completed = reservation.receipt.status === 'completed';
          return {
            index,
            sessionId: entry.sessionId,
            success: completed,
            runId: reservation.receipt.runId,
            duplicate: true,
            receipt: reservation.receipt,
            error: completed ? undefined : {
              code: reservation.receipt.errorCode ?? ErrorCode.SESSION_BUSY,
              message: `Existing run is ${reservation.receipt.status}`,
            },
          };
        }

        const runId = reservation.receipt.runId;
        reservedRunId = runId;
        if (reservation.receipt.phase7Shadow) logPhase7Shadow(runId, reservation.receipt.phase7Shadow);
        let busyAfterReservation: boolean;
        try {
          busyAfterReservation = reg.sdkType === 'claude'
            ? claudeService.isRunning(entry.sessionId)
            : reg.sdkType === 'opencode'
              ? opencodeService.isRunning(entry.sessionId)
              : reg.sdkType === 'antigravity'
                ? antigravityService.isRunning(entry.sessionId)
                : (() => {
                    const status = multiSessionManager.getSessionStatus?.(reg.path)?.status;
                    return status === 'busy' || status === 'streaming';
                  })();
        } catch (error) {
          await runReceipts.rejectBeforeDispatch(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR }).catch(() => undefined);
          logger.errorObject(`Failed to re-check session state for batch run ${runId}`, error);
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: { code: ErrorCode.INTERNAL_ERROR, message: 'Failed to verify session state' },
          };
        }
        if (busyAfterReservation) {
          await runReceipts.rejectBeforeDispatch(runId, { status: 'cancelled', errorCode: ErrorCode.SESSION_BUSY });
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: { code: ErrorCode.SESSION_BUSY, message: 'Session is currently busy' },
          };
        }
        // Acquire admission BEFORE marking the run started: an admission refusal
        // must reject the reserved receipt cleanly (not leave it 'started') and
        // surface the contracted ADMISSION_CAPACITY_EXHAUSTED + reason — never a
        // generic RUNTIME_ERROR or a stranded started receipt. The lease is
        // passed through to executePromptWithReceipt so it is not re-acquired.
        let batchAdmissionLease: { release: () => void };
        try {
          batchAdmissionLease = await admission.acquire(reg.sdkType as SessionRuntime, 'P2');
        } catch (error) {
          const capacityError = error instanceof AdmissionCapacityError ? error : new AdmissionCapacityError('global_limit');
          await runReceipts.rejectBeforeDispatch(runId, { status: 'cancelled', errorCode: ErrorCode.ADMISSION_CAPACITY_EXHAUSTED }).catch(() => undefined);
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: {
              code: ErrorCode.ADMISSION_CAPACITY_EXHAUSTED,
              reason: capacityError.reason,
              message: capacityError.message,
              retryAfterSeconds: capacityError.retryAfterSeconds,
            },
          };
        }
        try {
          await runReceipts.markStarted(runId);
        } catch (error) {
          batchAdmissionLease.release();
          await runReceipts.rejectBeforeDispatch(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR }).catch(() => undefined);
          logger.errorObject(`Failed to start batch run receipt ${runId}`, error);
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: { code: ErrorCode.INTERNAL_ERROR, message: 'Failed to start run' },
          };
        }
        const collector = createEventCollector();
        await withCorrelation({
          runId,
          sessionId: entry.sessionId,
          runtime: reg.sdkType,
          executionInstanceId: beginInput.executionInstanceId,
        }, () => executePromptWithReceipt(
          runId,
          entry.sessionId,
          reg.sdkType as SessionRuntime,
          entry.message,
          'prompt',
          (event) => collectAnswerEvent(collector, event),
          (error) => {
            if (error) collector.error = error;
            collector.complete = true;
          },
          batchAdmissionLease,
        ));
        if (collector.error) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: { code: ErrorCode.RUNTIME_ERROR, message: 'Runtime prompt failed. Inspect diagnostics using the returned runId.' },
          };
        }
        return {
          index,
          sessionId: entry.sessionId,
          success: true,
          runId,
          content: collector.textParts.join(''),
          tokens: collector.usage,
        };
      } catch (error) {
        const providerError = error instanceof PiProviderNotAllowedError ? error : undefined;
        return {
          index,
          sessionId: entry.sessionId,
          success: false,
          runId: reservedRunId,
          error: {
            code: providerError ? ErrorCode.PROVIDER_NOT_ALLOWED : ErrorCode.RUNTIME_ERROR,
            message: providerError?.message ?? 'Runtime prompt failed. Inspect diagnostics using the returned runId.',
          },
        };
      }
    };

    const results = parallel
      ? await mapWithConcurrency(body.prompts, BATCH_CONCURRENCY_LIMIT, (p, i) => runOne(p, i))
      : await body.prompts.reduce(async (acc, p, i) => {
          const list = await acc;
          list.push(await runOne(p, i));
          return list;
        }, Promise.resolve([] as Awaited<ReturnType<typeof runOne>>[]));

    const successCount = results.filter((r) => r.success).length;
    sendJson(res, 200, {
      results,
      successCount,
      failedCount: results.length - successCount,
    } satisfies BatchPromptResponse);
  }

  async function handleAggregateUsage(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<AggregateUsageRequest>(req);
    if (!body || !Array.isArray(body.sessionIds)) {
      sendJson(res, 400, { error: 'sessionIds[] is required', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    const perSession: AggregateUsageResponse['perSession'] = [];
    const missing: string[] = [];
    let input = 0, output = 0, total = 0, cost = 0;

    for (const sessionId of body.sessionIds) {
      try {
        const detail = await buildSessionDetail(sessionId);
        if (!detail) {
          missing.push(sessionId);
          continue;
        }
        const t = detail.tokens ?? { input: 0, output: 0, total: 0 };
        const c = detail.cost ?? 0;
        input += t.input;
        output += t.output;
        total += t.total;
        cost += c;
        perSession.push({
          sessionId,
          runtime: detail.runtime,
          input: t.input,
          output: t.output,
          total: t.total,
          cost: c,
        });
      } catch {
        missing.push(sessionId);
      }
    }

    sendJson(res, 200, {
      sessionIds: body.sessionIds,
      counted: perSession.map((p) => p.sessionId),
      missing,
      totals: { input, output, total, cost },
      perSession,
    } satisfies AggregateUsageResponse);
  }

  async function handleListPendingApprovals(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    let status: 'idle' | 'running' = 'idle';
    if (entry.sdkType === 'claude') status = claudeService.isRunning(sessionId) ? 'running' : 'idle';
    else if (entry.sdkType === 'opencode') status = opencodeService.isRunning(sessionId) ? 'running' : 'idle';
    else if (entry.sdkType === 'antigravity') status = antigravityService.isRunning(sessionId) ? 'running' : 'idle';

    const approvals = entry.sdkType === 'claude'
      ? claudeService.listPendingAskUserQuestionsForSession(sessionId)
      : [];
    sendJson(res, 200, {
      sessionId,
      runtime: entry.sdkType as SessionRuntime,
      status,
      approvals,
    } satisfies PendingApprovalsResponse);
  }

  // ─── Watch endpoints (long-horizon validation) ───────────────────────────

  async function handleRegisterWatch(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await readJsonBody<RegisterWatchRequest>(req);
    if (!body || !Array.isArray(body.conditions) || body.conditions.length === 0) {
      sendJson(res, 400, { error: 'conditions[] is required and must be non-empty', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    // For Pi/OpenCode, ensure the persistent observer is attached so events
    // flow into the broker (and therefore the watch) even before any prompt/SSE
    // consumer. OpenCode needs this for plugin-driven auto-continuation turns.
    if (entry.sdkType === 'pi') {
      attachPiObserverIfNeeded(entry.path);
    } else if (entry.sdkType === 'opencode') {
      attachOpenCodeObserverIfNeeded(sessionId);
    }

    try {
      const watch = await watchManager.register({
        sessionId,
        sessionPath: entry.path,
        runtime: entry.sdkType as SessionRuntime,
        request: body,
      });
      sendJson(res, 201, watch);
    } catch (err) {
      if (err instanceof WatchValidationError) {
        sendJson(res, 400, { error: err.message, code: ErrorCode.INVALID_REQUEST });
        return;
      }
      logger.errorObject('Failed to register watch', err);
      sendJson(res, 500, { error: 'Failed to register watch', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function handleGetWatch(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    await watchManager.init();
    const watch = watchManager.get(sessionId);
    if (!watch) {
      sendJson(res, 404, { error: 'No watch registered for this session', code: ErrorCode.WATCH_NOT_FOUND });
      return;
    }
    // `?sinceIndex=N` returns only firings recorded after the caller's last
    // poll. `firingCount` stays the absolute total so the caller can compute
    // its next `sinceIndex`.
    const sinceRaw = query.get('sinceIndex');
    if (sinceRaw !== null) {
      const sinceIndex = parseInt(sinceRaw, 10);
      if (Number.isFinite(sinceIndex) && sinceIndex > 0) {
        watch.firings = watch.firings.slice(sinceIndex);
      }
    }
    sendJson(res, 200, watch);
  }

  async function handleDeleteWatch(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    await watchManager.init();
    const existed = await watchManager.delete(sessionId);
    if (!existed) {
      sendJson(res, 404, { error: 'No watch registered for this session', code: ErrorCode.WATCH_NOT_FOUND });
      return;
    }
    sendJson(res, 200, { success: true, watchId: `watch-${sessionId}` });
  }

  async function handleCapacity(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    await runReceipts.init();
    sendJson(res, 200, {
      ...admission.snapshot(),
      stalledRuns: runReceipts.getStalledRunCount(),
      quarantinedRuns: runReceipts.getQuarantinedCount(),
      oldestActiveRunStartedAt: runReceipts.getOldestActiveRunStartedAt(),
      control: { inFlight: controlLane.inFlight, queued: controlLane.queued },
      disposalOwners: disposal.getCounts(),
    });
  }

  const wrapControl = <A extends unknown[]>(h: (...a: A) => Promise<void>) =>
    async (...a: A): Promise<void> => {
      const res = a[1] as ServerResponse;
      // Emergency floor: control bypasses execution admission, but at the critical
      // memory floor (controlAvailable=false) even control is refused to preserve
      // the process. Below that, control stays available under P2/P3 saturation.
      if (!admission.snapshot().controlAvailable) {
        try { sendJson(res, 503, { error: 'Control unavailable at critical memory', code: 'CONTROL_CRITICAL', retryAfterSeconds: 2 }); } catch { /* response closed */ }
        return;
      }
      let slot: { release: () => void };
      try {
        slot = await controlLane.acquire();
      } catch (err) {
        if (err instanceof ControlLaneFullError) {
          // Control flood: fail fast with Retry-After rather than growing the queue.
          try {
            res.setHeader('Retry-After', '2');
            sendJson(res, 503, { error: 'Control lane saturated; retry shortly', code: 'CONTROL_LANE_FULL', retryAfterSeconds: 2 });
          } catch { /* response already closed */ }
          return;
        }
        throw err;
      }
      try { await h(...a); } finally { slot.release(); }
    };

  return {
    ready,
    shutdown,
    controlLane,
    disposal,
    broker,
    reapplyRetentionForSession: (sessionId: string) => pinExpiry?.reapplyForSession(sessionId) ?? Promise.resolve(),
    handleCreateSession,
    handleListSessions,
    handleGetSession,
    handleGetSessionInfo,
    handleGetSessionEvidence: wrapControl(handleGetSessionEvidence),
    handleGetRunReceipt: wrapControl(handleGetRunReceipt),
    handleGetSessionHistory: wrapControl(handleGetSessionHistory),
    handleDeleteSession: wrapControl(handleDeleteSession),
    handleSendPrompt,
    handleAbort: wrapControl(handleAbort),
    handleSessionControl: wrapControl(handleSessionControl),
    handleRespondApproval: wrapControl(handleRespondApproval),
    // Orchestration endpoints
    handleSessionEvents,
    handleSessionWait,
    handleSessionTranscript,
    handleSessionTransfer,
    handleBatchCreate,
    handleBatchPrompt,
    handleAggregateUsage,
    handleListPendingApprovals,
    // Watch endpoints
    handleRegisterWatch,
    handleGetWatch,
    handleDeleteWatch,
    handleCapacity,
  };
}

function parseVerbosityHeader(header: string | undefined): Verbosity | undefined {
  if (!header) return undefined;
  const v = header.toLowerCase().trim();
  if (v === 'answers' || v === 'tasks' || v === 'full') {
    return v;
  }
  return undefined;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

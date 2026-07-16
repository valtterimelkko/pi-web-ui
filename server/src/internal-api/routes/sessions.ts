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
import type {
  CreateSessionRequest,
  SendPromptRequest,
  CreateSessionResponse,
  SessionInfo,
  SessionDetail,
  SessionHistoryResponse,
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
} from '../types.js';
import { InternalApiEventBroker } from '../event-broker.js';
import { WatchManager, WatchValidationError } from '../watch/watch-manager.js';
import { PinExpiryManager, type ApplyPinResult } from '../pin-expiry-manager.js';
import {
  IdempotencyKeyValidationError,
  RunReceiptManager,
} from '../run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../run-receipts/run-receipt-store.js';
import { resolveExecutionInstanceId } from '../execution-instance.js';
import {
  createEventCollector,
  collectAnswerEvent,
  writeTaskEvent,
  writeFullEvent,
} from '../event-filter.js';
import { createSSEStream } from '../sse-stream.js';
import { ErrorCode, enrichedErrorBody } from '../error-codes.js';
import { withCorrelation, newRequestId, getCorrelationContext } from '../../logging/correlation.js';
import { TransferService } from '../../session-transfer/transfer-service.js';
import {
  extractPiTranscript,
  extractClaudeTranscript,
  extractOpenCodeTranscript,
  piSessionToReplayEvents,
} from '../../session-transfer/index.js';
import { stat, readdir, unlink, rm } from 'fs/promises';
import path from 'path';
import { config } from '../../config.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('InternalAPI');


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

  const piSessionDir = deps.piSessionDir ?? path.join(config.piAgentDir, 'sessions');
  const claudeSessionDir = deps.claudeSessionDir ?? config.claudeSessionDir;
  const antigravitySessionDir = deps.antigravitySessionDir ?? config.antigravitySessionDir;
  const runReceipts = deps.runReceiptManager ?? new RunReceiptManager({
    store: new RunReceiptStore(deps.runReceiptDir),
    idempotencyTtlMs: deps.runReceiptIdempotencyTtlMs,
  });

  /**
   * Per-session event broker. Long-lived: subscribers added via
   * `GET /sessions/:id/events` persist across prompts and across clients.
   * Every Internal-API prompt path publishes events here so any open
   * subscriber sees them in real time.
   */
  const broker = new InternalApiEventBroker({ replayBufferSize: 100 });

  /** Track Pi/OpenCode sessions we have already attached a long-lived observer to. */
  const piObservedSessions = new Set<string>();
  const opencodeObservedSessions = new Set<string>();

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
    } catch {
      /* session may not be loaded yet; retry on next prompt/watch */
    }
  }

  /** Pin a session via the right runtime service. Used by watch registration. */
  async function pinSessionById(sessionId: string): Promise<boolean> {
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return false;
    if (entry.sdkType === 'claude') return claudeService.pinSession(sessionId);
    if (entry.sdkType === 'opencode') return opencodeService.pinSession(sessionId);
    if (entry.sdkType === 'antigravity') return antigravityService.pinSession(sessionId);
    return multiSessionManager.pinSession(entry.path);
  }

  /** Revoke a session's pin via the right runtime service (mirror of pinSessionById). */
  async function unpinSessionById(sessionId: string): Promise<boolean> {
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return false;
    if (entry.sdkType === 'claude') return claudeService.unpinSession(sessionId);
    if (entry.sdkType === 'opencode') return opencodeService.unpinSession(sessionId);
    if (entry.sdkType === 'antigravity') return antigravityService.unpinSession(sessionId);
    return multiSessionManager.unpinSession(entry.path);
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
  if (pinExpiry) {
    // init() is async; kick it off without blocking route construction. On
    // resolve it re-applies non-expired pins from the ledger (restart safety)
    // and the periodic expiry sweep starts.
    void pinExpiry.init().then(() => pinExpiry.start());
  }

  /** Pin without TTL tracking — the fallback when no PinExpiryManager exists. */
  async function pinWithoutExpiry(sessionId: string): Promise<ApplyPinResult> {
    const ok = await pinSessionById(sessionId);
    return ok ? { pinned: true } : { pinned: false, reason: 'PIN_LIMIT_REACHED' };
  }

  /** ISO deadline for a session's API pin, when tracked. */
  function apiPinDeadline(sessionId: string): string | undefined {
    const ms = pinExpiry?.getPinnedUntil(sessionId);
    return ms ? new Date(ms).toISOString() : undefined;
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
  } {
    return {
      pinned: result.pinned,
      pinnedUntil: result.pinned ? new Date(result.pinnedUntil as number).toISOString() : undefined,
      pinReason: result.pinned ? undefined : result.reason,
    };
  }

  async function handleCreateSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<CreateSessionRequest>(req);
    if (!body || !body.runtime) {
      sendJson(res, 400, { error: 'runtime is required', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    const runtime: SessionRuntime = body.runtime;
    const cwd = body.cwd || process.cwd();
    let base: CreateSessionResponse | null = null;

    try {
      switch (runtime) {
        case 'claude': {
          if (!(await claudeService.isAvailable())) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'Claude runtime is not available'));
            return;
          }
          // Support profile selection via model="profile:<id>" or explicit profileId
          let profileId: string | undefined = (body as { profileId?: string }).profileId;
          let model: string | undefined = body.model || 'sonnet';
          if (model.startsWith('profile:')) {
            profileId = model.slice('profile:'.length);
            model = undefined; // the profile determines the model
          }
          const { sessionId } = await claudeService.createSession(cwd, model || 'sonnet', body.thinkingLevel, profileId);
          base = {
            sessionId,
            sessionPath: sessionId,
            runtime: 'claude',
            model: profileId ? `profile:${profileId}` : (body.model || 'sonnet'),
            cwd,
            createdAt: new Date().toISOString(),
          };
          break;
        }

        case 'opencode': {
          if (!(await opencodeService.isAvailable())) {
            sendJson(res, 503, enrichedErrorBody(ErrorCode.RUNTIME_UNAVAILABLE, 'OpenCode runtime is not available'));
            return;
          }
          const { sessionId } = await opencodeService.createSession(cwd);
          if (body.model) {
            await opencodeService.setModel?.(sessionId, body.model).catch(() => { /* non-fatal */ });
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

        case 'pi':
        default: {
          const status = await multiSessionManager.createAndSubscribe(internalClientId, cwd);
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
      }

      if (!base) {
        sendJson(res, 500, { error: 'Failed to create session', code: ErrorCode.SESSION_CREATE_FAILED });
        return;
      }

      // Optional create-time pin: a persistent, time-bounded "don't clean this
      // up while my long task runs" guarantee, decoupled from the watch machinery.
      if (body.pin) {
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
      logger.errorObject('Failed to create session', err);
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Failed to create session',
        code: ErrorCode.SESSION_CREATE_FAILED,
      });
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
        status: entry.status,
        messageCount: entry.messageCount,
        firstMessage: entry.firstMessage,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
      }));

      sendJson(res, 200, { sessions } satisfies ListSessionsResponse);
    } catch (err) {
      logger.errorObject('Failed to list sessions', err);
      sendJson(res, 500, { error: 'Failed to list sessions', code: ErrorCode.INTERNAL_ERROR });
    }
  }

  async function buildSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return null;

    const detail: SessionDetail = {
      sessionId: entry.id,
      sessionPath: entry.path,
      runtime: entry.sdkType as SessionRuntime,
      executionInstanceId: resolveExecutionInstanceId(entry),
      cwd: entry.cwd,
      model: entry.model,
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
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
        return;
      }

      // Mark the accepted run cancelled before asking the runtime to abort.
      // Late runtime callbacks cannot overwrite an explicit user deletion.
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
          await agentSession.abort().catch(() => { /* non-fatal */ });
        }
      }

      // Release the runtime's in-memory pin slot before removing registry
      // metadata. The durable API-pin ledger is cleared below, but services also
      // keep their own per-runtime pinned state; deleting a pinned session must
      // not leave a stale slot occupied until process restart.
      await unpinSessionById(sessionId).catch(() => false);

      // Remove the runtime's persisted session files so the session does not
      // reappear in the UI after a registry rebuild.
      await deleteSessionFiles(entry);

      await sessionRegistry.delete(sessionId);
      // Drop any API-pin ledger record so the expiry sweep won't try to unpin a
      // session that no longer exists.
      if (pinExpiry) await pinExpiry.clear(sessionId).catch(() => { /* non-fatal */ });
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
  ): Promise<void> {
    let completed = false;
    let persistence: Promise<unknown> = Promise.resolve();
    const eventPersistence: Promise<void>[] = [];

    const complete = (error?: Error): void => {
      if (completed) return;
      completed = true;
      // Keep persistence in the turn's promise chain. A successful answer must
      // not be reported as complete if its terminal receipt could not reach
      // disk; detached callers observe the rejection in their fire-and-forget
      // catch below.
      persistence = runReceipts.finish(runId, error
        ? { status: 'failed', errorCode: ErrorCode.RUNTIME_ERROR }
        : {});
      try {
        onComplete(error);
      } catch (callbackError) {
        // A transport callback must not prevent the receipt from reaching its
        // terminal state or leave executePrompt's promise unresolved.
        logger.errorObject(`Prompt response callback failed for run ${runId}`, callbackError);
      }
    };

    let executionError: Error | undefined;
    try {
      await executePrompt(
        sessionId,
        runtime,
        message,
        mode,
        (event) => {
          eventPersistence.push(runReceipts.observeEvent(runId, event));
          onEvent(event);
        },
        complete,
      );
      // Existing runtimes normally call onComplete at their turn boundary. The
      // fallback keeps the receipt explicit if a runtime returns without doing
      // so, without inventing a new runtime-specific completion hook.
      if (!completed) complete();
    } catch (error) {
      executionError = error instanceof Error ? error : new Error(String(error));
      complete(executionError);
    }

    // Wait for agent_end evidence as well as the terminal transition. This
    // handles runtimes whose completion callback wins the event-order race.
    await Promise.all(eventPersistence);
    // Always await the terminal receipt write before propagating a runtime
    // error. Otherwise a process crash in this small window could leave a
    // failed run persisted as merely started.
    await persistence;
    if (executionError) throw executionError;
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
    const mode: PromptMode = body.mode ?? 'prompt';

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

      const beginInput = {
        sessionId,
        runtime,
        executionInstanceId: resolveExecutionInstanceId(entry),
        model: entry.model,
        message: body.message,
        mode,
        verbosity,
        detach: body.detach === true,
        idempotencyKey: body.idempotencyKey,
      } as const;

      // A retry of an accepted detached/streaming run must be replayable even
      // while the runtime reports the session busy. Peek before the busy check;
      // beginRun repeats the check under its key lock for the race where two
      // callers arrive together.
      if (body.idempotencyKey !== undefined) {
        try {
          const existing = await runReceipts.findExistingRun(beginInput);
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

      const isBusy = runtime === 'claude'
        ? claudeService.isRunning(sessionId)
        : runtime === 'opencode'
          ? opencodeService.isRunning(sessionId)
          : false;
      if (isBusy && mode === 'prompt') {
        sendJson(res, 409, enrichedErrorBody(ErrorCode.SESSION_BUSY, 'Session is currently busy'));
        return;
      }

      let reservation;
      try {
        reservation = await runReceipts.beginRun(beginInput);
      } catch (error) {
        if (error instanceof IdempotencyKeyValidationError) {
          sendJson(res, 400, enrichedErrorBody(ErrorCode.INVALID_REQUEST, error.message));
          return;
        }
        logger.errorObject('Failed to reserve run receipt', error);
        sendJson(res, 500, { error: 'Failed to reserve run receipt', code: ErrorCode.INTERNAL_ERROR });
        return;
      }

      if (reservation.kind === 'conflict') {
        sendJson(res, 409, {
          ...enrichedErrorBody(ErrorCode.IDEMPOTENCY_KEY_CONFLICT, 'Idempotency key was already used for a different prompt'),
          runId: reservation.receipt.runId,
        });
        return;
      }

      if (reservation.kind === 'duplicate') {
        // A replay is a JSON receipt response even when the original request
        // was detached; its nested receipt carries the real current status.
        sendJson(res, 200, duplicatePromptResponse(sessionId, reservation.receipt, body.detach === true));
        return;
      }

      const runId = reservation.receipt.runId;
      const busyAfterReservation = runtime === 'claude'
        ? claudeService.isRunning(sessionId)
        : runtime === 'opencode'
          ? opencodeService.isRunning(sessionId)
          : false;
      if (busyAfterReservation && mode === 'prompt') {
        await runReceipts.finish(runId, { status: 'cancelled', errorCode: ErrorCode.SESSION_BUSY });
        sendJson(res, 409, {
          ...enrichedErrorBody(ErrorCode.SESSION_BUSY, 'Session is currently busy'),
          runId,
        });
        return;
      }
      try {
        await runReceipts.markStarted(runId);
      } catch (error) {
        await runReceipts.finish(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR }).catch(() => undefined);
        logger.errorObject(`Failed to start run receipt ${runId}`, error);
        sendJson(res, 500, { error: 'Failed to start run', code: ErrorCode.INTERNAL_ERROR, runId });
        return;
      }

      logger.info(`[InternalAPI] Prompt dispatched: runtime=${runtime} verbosity=${verbosity} mode=${mode} runId=${runId}`);

      if (body.detach) {
        void executePromptWithReceipt(
          runId,
          sessionId,
          runtime,
          body.message,
          mode,
          () => { /* progress events flow to the broker inside executePrompt */ },
          (err) => {
            if (err) logger.errorObject(`Detached prompt failed for ${sessionId} run=${runId}`, err);
          },
        ).catch((error) => {
          logger.errorObject(`Detached prompt error for ${sessionId} run=${runId}`, error);
        });
        sendJson(res, 202, { sessionId, runId, detached: true, status: 'accepted' } satisfies DetachedPromptResponse);
        return;
      }

      try {
        if (verbosity === 'full' || verbosity === 'tasks') {
          await handleStreamingPrompt(req, res, sessionId, runtime, body.message, verbosity, mode, runId);
          return;
        }

        await handleAnswersPrompt(res, sessionId, runtime, body.message, mode, runId);
      } catch (err) {
        logger.errorObject('Prompt failed', err);
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : 'Prompt execution failed',
            code: ErrorCode.RUNTIME_ERROR,
            runId,
          });
        }
      }
    });
  }

  async function handleAnswersPrompt(
    res: ServerResponse,
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    mode: PromptMode,
    runId: string,
  ): Promise<void> {
    const collector = createEventCollector();

    await executePromptWithReceipt(
      runId,
      sessionId,
      runtime,
      message,
      mode,
      (event) => {
        collectAnswerEvent(collector, event);
      },
      (error) => {
        if (error) collector.error = error;
        collector.complete = true;
      },
    );

    if (collector.error) {
      sendJson(res, 500, {
        error: collector.error.message,
        code: ErrorCode.RUNTIME_ERROR,
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
    runId: string,
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
          if (runtime === 'claude') {
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
      mode,
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
          sse.complete({ sessionId, turnComplete: true });
        }
      },
    );
  }

  async function handleAbort(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
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
    const body = await readJsonBody<SessionControlRequest>(req);
    if (!body?.action) {
      sendJson(res, 400, { error: 'action is required', code: ErrorCode.INVALID_REQUEST });
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

        case 'unpin': {
          let unpinned: boolean;
          if (entry.sdkType === 'claude') {
            unpinned = claudeService.unpinSession(sessionId);
          } else if (entry.sdkType === 'opencode') {
            unpinned = opencodeService.unpinSession(sessionId);
          } else if (entry.sdkType === 'antigravity') {
            unpinned = antigravityService.unpinSession(sessionId);
          } else {
            unpinned = multiSessionManager.unpinSession(entry.path);
          }
          // Drop the API-pin ledger record so a later restart won't re-pin a
          // session the caller explicitly unpinned.
          if (pinExpiry) await pinExpiry.clear(sessionId);
          response = { success: unpinned, action: 'unpin', pinned: false };
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

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    try {
      if (entry.sdkType === 'claude') {
        // SDK AskUserQuestion requests are resolved with structured answers
        // (or a cancellation). Check this before the channel permission path
        // so an answer is never misrouted to sendPermissionResponse.
        if (typeof claudeService.isPendingAskUserQuestion === 'function'
          && claudeService.isPendingAskUserQuestion(requestId)) {
          const isCancel = body.cancelled === true;
          const answersError = validateStringRecord(body.answers, 'answers');
          const annotationsError = validateAskUserQuestionAnnotations(body.annotations);
          if (!isCancel && (answersError || annotationsError)) {
            sendJson(res, 400, { error: answersError ?? annotationsError, code: ErrorCode.INVALID_REQUEST });
            return;
          }
          const resolution: { answers?: Record<string, string>; annotations?: Record<string, { preview?: string; notes?: string }>; cancelled?: boolean } = {};
          if (isCancel) {
            resolution.cancelled = true;
          } else {
            if (body.answers) resolution.answers = body.answers;
            if (body.annotations) resolution.annotations = body.annotations;
          }
          const resolved = claudeService.respondToAskUserQuestion(requestId, resolution);
          if (!resolved) {
            // Race: the request resolved between the pending check above and the
            // call (e.g. it just timed out). Return a clear conflict instead of
            // a silent success so the caller knows the answer was not delivered.
            logger.warn(`AskUserQuestion response ignored because request is no longer pending: ${requestId}`);
            sendJson(res, 409, enrichedErrorBody(ErrorCode.ASK_ALREADY_CLOSED,
              'That question already closed, so the answer was not delivered to the assistant.'));
            return;
          }
          sendJson(res, 200, {
            success: true,
            approved: body.approved,
          } satisfies ApprovalResponseResult);
          return;
        }
        // Late answer: the request was an AskUserQuestion that already closed.
        // Return a clear conflict instead of misrouting to the channel permission
        // path or answering with a silent 200 (D3).
        if (typeof claudeService.wasRecentlyResolvedAskUserQuestion === 'function'
          && claudeService.wasRecentlyResolvedAskUserQuestion(requestId)) {
          sendJson(res, 409, enrichedErrorBody(ErrorCode.ASK_ALREADY_CLOSED,
            'That question already closed, so the answer was not delivered to the assistant.'));
          return;
        }
        claudeService.sendPermissionResponse(sessionId, requestId, body.approved);
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

  async function executePrompt(
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    mode: PromptMode,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    // Wrap onEvent so every event also flows into the broker. This lets
    // long-lived subscribers (e.g. GET /sessions/:id/events) observe the
    // turn regardless of which client started it.
    const broadcast = (event: NormalizedEvent) => {
      broker.publish(sessionId, event);
      try { onEvent(event); } catch { /* non-fatal */ }
    };

    switch (runtime) {
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
        const agentSession = multiSessionManager.getAgentSession(sessionPath);
        if (!agentSession) {
          throw new Error(`Pi session not loaded: ${sessionId}`);
        }

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
        const endObserver = (event: unknown) => {
          const normalized = event as NormalizedEvent;
          if (normalized.type === 'agent_end' && !ended) {
            ended = true;
            multiSessionManager.removeApiObserver(sessionPath, endObserver);
            multiSessionManager.removeApiObserver(sessionPath, eventObserver);
            onComplete();
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
        } catch (err) {
          multiSessionManager.removeApiObserver(sessionPath, endObserver);
          multiSessionManager.removeApiObserver(sessionPath, eventObserver);
          if (!ended) {
            onComplete(err instanceof Error ? err : new Error(String(err)));
          }
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
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found'));
      return;
    }

    // For Pi sessions, eagerly attach the long-lived broker observer so
    // events emitted by any future prompt reach this subscriber.
    if (entry.sdkType === 'pi') {
      attachPiObserverIfNeeded(entry.path);
    }

    const sse = createSSEStream(res);

    const unsub = broker.subscribe(sessionId, (event) => {
      sse.write(event.type, event);
    });

    // Keep this handler alive until the client disconnects. Without this,
    // Node may consider the GET request "complete" (it has no body) and
    // garbage-collect the response, closing the SSE stream prematurely.
    // Awaiting the close promise guarantees the response object survives
    // for the lifetime of the subscription.
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        unsub();
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

  async function handleSessionTranscript(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    try {
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

      const source = {
        sessionId: entry.id,
        displayName: entry.firstMessage?.slice(0, 50) ?? entry.id,
        sdkType: entry.sdkType,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
      };

      let transcriptResult: {
        scope: 'visible_recent' | 'visible_full';
        itemCount: number;
        truncated: boolean;
        items: TranscriptResponse['items'];
        source: TranscriptResponse['source'];
      };
      let transcriptError: string | undefined;

      if (entry.sdkType === 'pi') {
        const adapted = await extractPiTranscript(entry.path, source, scope);
        transcriptResult = adapted.transcript;
        transcriptError = adapted.error;
      } else if (entry.sdkType === 'claude') {
        const adapted = await extractClaudeTranscript(
          (sid) => claudeService.loadSessionHistory(sid),
          entry.id,
          source,
          scope,
        );
        transcriptResult = adapted.transcript;
        transcriptError = adapted.error;
      } else if (entry.sdkType === 'opencode') {
        const adapted = await extractOpenCodeTranscript(opencodeService, entry.id, source, scope);
        transcriptResult = adapted.transcript;
        transcriptError = adapted.error;
      } else if (entry.sdkType === 'antigravity') {
        // Antigravity has no native VisibleTranscriptSource adapter, but its
        // replay events can be reduced into VisibleTranscriptItems using the
        // shared helper. This keeps the transcript format uniform.
        const events = await antigravityService.getReplayEvents(entry.id);
        const { replayEventsToVisibleItems, buildVisibleTranscript } = await import('../../session-transfer/visible-transcript.js');
        const items = replayEventsToVisibleItems(events);
        transcriptResult = buildVisibleTranscript(items, source, scope);
      } else {
        sendJson(res, 501, { error: `Transcript not supported for runtime: ${entry.sdkType}`, code: ErrorCode.NOT_IMPLEMENTED });
        return;
      }

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

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Source session not found'));
      return;
    }

    // Lazy-import the Pi session dir resolution. Default matches the
    // multi-session-manager's convention.
    const piSessionDir = process.env.PI_SESSIONS_DIR ||
      `${process.env.HOME || '/root'}/.pi/agent/sessions`;

    const transferService = new TransferService({
      registry: sessionRegistry,
      claudeService,
      opencodeService,
      antigravityService,
      piSessionDir,
      createPiSession: async (cwd: string) => {
        const status = await multiSessionManager.createAndSubscribe(internalClientId, cwd);
        return { sessionId: status.sessionId, sessionPath: status.sessionPath };
      },
      sendPiPrompt: async (sessionPath: string, message: string, onEvent: (event: unknown) => void) => {
        let observing = true;
        const transferObserver = (event: unknown) => {
          onEvent(event);
          if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'agent_start') {
            // The transfer response is acceptance-based, so do not retain an
            // observer for a later/stalled target turn.
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
      },
    });

    try {
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
      sendJson(res, result.success ? 200 : 400, response);
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
    const body = await readJsonBody<BatchCreateRequest>(req);
    if (!body || !Array.isArray(body.sessions) || body.sessions.length === 0) {
      sendJson(res, 400, { error: 'sessions[] is required and must be non-empty', code: ErrorCode.INVALID_REQUEST });
      return;
    }

    const results = await Promise.all(body.sessions.map(async (entry, index) => {
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
            code: ErrorCode.SESSION_CREATE_FAILED,
            message: err instanceof Error ? err.message : 'Failed to create session',
          },
        };
      }
    }));

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
    const body = await readJsonBody<BatchPromptRequest>(req);
    if (!body || !Array.isArray(body.prompts) || body.prompts.length === 0) {
      sendJson(res, 400, { error: 'prompts[] is required and must be non-empty', code: ErrorCode.INVALID_REQUEST });
      return;
    }

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

        const beginInput = {
          sessionId: entry.sessionId,
          runtime: reg.sdkType as SessionRuntime,
          executionInstanceId: resolveExecutionInstanceId(reg),
          model: reg.model,
          message: entry.message,
          mode: 'prompt' as const,
          verbosity: 'answers' as const,
          detach: false,
          idempotencyKey: entry.idempotencyKey,
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
                  code: ErrorCode.SESSION_BUSY,
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
        const busyAfterReservation = reg.sdkType === 'claude'
          ? claudeService.isRunning(entry.sessionId)
          : reg.sdkType === 'opencode'
            ? opencodeService.isRunning(entry.sessionId)
            : false;
        if (busyAfterReservation) {
          await runReceipts.finish(runId, { status: 'cancelled', errorCode: ErrorCode.SESSION_BUSY });
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: { code: ErrorCode.SESSION_BUSY, message: 'Session is currently busy' },
          };
        }
        try {
          await runReceipts.markStarted(runId);
        } catch (error) {
          await runReceipts.finish(runId, { status: 'failed', errorCode: ErrorCode.INTERNAL_ERROR }).catch(() => undefined);
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
        await executePromptWithReceipt(
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
        );
        if (collector.error) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            runId,
            error: { code: ErrorCode.RUNTIME_ERROR, message: collector.error.message },
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
      } catch (err) {
        return {
          index,
          sessionId: entry.sessionId,
          success: false,
          runId: reservedRunId,
          error: {
            code: ErrorCode.RUNTIME_ERROR,
            message: err instanceof Error ? err.message : 'Prompt failed',
          },
        };
      }
    };

    const results = parallel
      ? await Promise.all(body.prompts.map((p, i) => runOne(p, i)))
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

    // The runtime services do not currently expose a public accessor for
    // the in-flight permission map. Pending approvals must be observed via
    // the /events stream as they arise. We return an empty list with the
    // session status so callers can poll without error and switch to the
    // event stream when they need live approvals.
    let status: 'idle' | 'running' = 'idle';
    if (entry.sdkType === 'claude') status = claudeService.isRunning(sessionId) ? 'running' : 'idle';
    else if (entry.sdkType === 'opencode') status = opencodeService.isRunning(sessionId) ? 'running' : 'idle';
    else if (entry.sdkType === 'antigravity') status = antigravityService.isRunning(sessionId) ? 'running' : 'idle';

    sendJson(res, 200, {
      sessionId,
      runtime: entry.sdkType as SessionRuntime,
      status,
      approvals: [],
      note: 'Pending approvals must be observed via GET /sessions/:id/events. The runtime services do not yet expose a synchronous pending list.',
    });
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

  return {
    handleCreateSession,
    handleListSessions,
    handleGetSession,
    handleGetSessionInfo,
    handleGetRunReceipt,
    handleGetSessionHistory,
    handleDeleteSession,
    handleSendPrompt,
    handleAbort,
    handleSessionControl,
    handleRespondApproval,
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

async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        if (!raw.trim()) {
          resolve(null);
          return;
        }
        resolve(JSON.parse(raw) as T);
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

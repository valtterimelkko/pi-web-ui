/**
 * Internal API: Session Routes
 *
 * Handles session CRUD, prompt execution, control operations, replay access,
 * and approval responses for all three runtimes.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { detectPromptInjection } from '../../security/prompt-injection.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { AntigravityService } from '../../antigravity/antigravity-service.js';
import type { MultiSessionManager } from '../../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../../session-registry.js';
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
  Verbosity,
  PromptMode,
  SessionRuntime,
  SessionControlRequest,
  ApprovalResponseRequest,
  TransferSessionRequest,
  TransferSessionResponse,
  BatchCreateRequest,
  BatchCreateResponse,
  BatchPromptRequest,
  BatchPromptResponse,
  AggregateUsageRequest,
  AggregateUsageResponse,
  PendingApprovalsResponse,
  WaitResponse,
  TranscriptResponse,
} from '../types.js';
import { InternalApiEventBroker } from '../event-broker.js';
import {
  createEventCollector,
  collectAnswerEvent,
  writeTaskEvent,
  writeFullEvent,
} from '../event-filter.js';
import { createSSEStream } from '../sse-stream.js';
import { TransferService } from '../../session-transfer/transfer-service.js';
import {
  extractPiTranscript,
  extractClaudeTranscript,
  extractOpenCodeTranscript,
} from '../../session-transfer/index.js';

export interface SessionRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  antigravityService: AntigravityService;
  multiSessionManager: MultiSessionManager;
  sessionRegistry: SessionRegistryManager;
  piService: PiService;
  /** Internal API client ID prefix for Pi SDK sessions */
  internalClientId: string;
  /** Callback to notify WebSocket clients of new sessions */
  onSessionCreated?: (sessionId: string, sessionPath: string, runtime: string) => void;
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

  /**
   * Per-session event broker. Long-lived: subscribers added via
   * `GET /sessions/:id/events` persist across prompts and across clients.
   * Every Internal-API prompt path publishes events here so any open
   * subscriber sees them in real time.
   */
  const broker = new InternalApiEventBroker({ replayBufferSize: 100 });

  /** Track Pi sessions we have already attached a long-lived observer to. */
  const piObservedSessions = new Set<string>();

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

  async function handleCreateSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBody<CreateSessionRequest>(req);
    if (!body || !body.runtime) {
      sendJson(res, 400, { error: 'runtime is required', code: 'INVALID_REQUEST' });
      return;
    }

    const runtime: SessionRuntime = body.runtime;
    const cwd = body.cwd || process.cwd();

    try {
      switch (runtime) {
        case 'claude': {
          if (!(await claudeService.isAvailable())) {
            sendJson(res, 503, { error: 'Claude runtime is not available', code: 'RUNTIME_UNAVAILABLE' });
            return;
          }
          const { sessionId } = await claudeService.createSession(cwd, body.model || 'sonnet', body.thinkingLevel);
          sendJson(res, 201, {
            sessionId,
            sessionPath: sessionId,
            runtime: 'claude',
            model: body.model || 'sonnet',
            cwd,
            createdAt: new Date().toISOString(),
          } satisfies CreateSessionResponse);
          onSessionCreated?.(sessionId, sessionId, 'claude');
          return;
        }

        case 'opencode': {
          if (!(await opencodeService.isAvailable())) {
            sendJson(res, 503, { error: 'OpenCode runtime is not available', code: 'RUNTIME_UNAVAILABLE' });
            return;
          }
          const { sessionId } = await opencodeService.createSession(cwd);
          if (body.model) {
            await opencodeService.setModel?.(sessionId, body.model).catch(() => { /* non-fatal */ });
          }
          sendJson(res, 201, {
            sessionId,
            sessionPath: sessionId,
            runtime: 'opencode',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          } satisfies CreateSessionResponse);
          onSessionCreated?.(sessionId, sessionId, 'opencode');
          return;
        }

        case 'antigravity': {
          if (!(await antigravityService.isAvailable())) {
            sendJson(res, 503, { error: 'Antigravity runtime is not available', code: 'RUNTIME_UNAVAILABLE' });
            return;
          }
          const { sessionId } = await antigravityService.createSession(cwd, body.model);
          sendJson(res, 201, {
            sessionId,
            sessionPath: sessionId,
            runtime: 'antigravity',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          } satisfies CreateSessionResponse);
          onSessionCreated?.(sessionId, sessionId, 'antigravity');
          return;
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
          sendJson(res, 201, {
            sessionId: status.sessionId,
            sessionPath: status.sessionPath,
            runtime: 'pi',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          } satisfies CreateSessionResponse);
          onSessionCreated?.(status.sessionId, status.sessionPath, 'pi');
          return;
        }
      }
    } catch (err) {
      console.error('[InternalAPI] Failed to create session:', err);
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Failed to create session',
        code: 'SESSION_CREATE_FAILED',
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
      console.error('[InternalAPI] Failed to list sessions:', err);
      sendJson(res, 500, { error: 'Failed to list sessions', code: 'INTERNAL_ERROR' });
    }
  }

  async function buildSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const entry = await sessionRegistry.get(sessionId);
    if (!entry) return null;

    const detail: SessionDetail = {
      sessionId: entry.id,
      sessionPath: entry.path,
      runtime: entry.sdkType as SessionRuntime,
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
      detail.status = claudeService.isRunning(sessionId) ? 'running' : detail.status;
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
      detail.status = opencodeService.isRunning(sessionId) ? 'running' : detail.status;
      if (stats) {
        detail.nativeSessionId = stats.sessionId;
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
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      sendJson(res, 200, detail);
    } catch (err) {
      console.error('[InternalAPI] Failed to get session:', err);
      sendJson(res, 500, { error: 'Failed to get session', code: 'INTERNAL_ERROR' });
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
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }
      sendJson(res, 200, detail);
    } catch (err) {
      console.error('[InternalAPI] Failed to get session info:', err);
      sendJson(res, 500, { error: 'Failed to get session info', code: 'INTERNAL_ERROR' });
    }
  }

  async function handleGetSessionHistory(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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
        sendJson(res, 501, { error: `Replay history not supported for runtime: ${entry.sdkType}`, code: 'NOT_IMPLEMENTED' });
        return;
      }

      sendJson(res, 200, {
        sessionId,
        runtime: entry.sdkType,
        events,
      } satisfies SessionHistoryResponse);
    } catch (err) {
      console.error('[InternalAPI] Failed to get session history:', err);
      sendJson(res, 500, { error: 'Failed to get session history', code: 'INTERNAL_ERROR' });
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
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      if (entry.sdkType === 'claude') {
        claudeService.abort(sessionId);
      } else if (entry.sdkType === 'opencode') {
        opencodeService.abort(sessionId);
      } else {
        const agentSession = multiSessionManager.getAgentSession(entry.path);
        if (agentSession) {
          await agentSession.abort().catch(() => { /* non-fatal */ });
        }
      }

      await sessionRegistry.delete(sessionId);
      sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[InternalAPI] Failed to delete session:', err);
      sendJson(res, 500, { error: 'Failed to delete session', code: 'INTERNAL_ERROR' });
    }
  }

  async function handleSendPrompt(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await readJsonBody<SendPromptRequest>(req);
    if (!body || !body.message) {
      sendJson(res, 400, { error: 'message is required', code: 'INVALID_REQUEST' });
      return;
    }

    const injectionCheck = detectPromptInjection(body.message);
    if (injectionCheck.recommendation === 'block') {
      sendJson(res, 400, {
        error: 'Prompt contains potentially malicious content',
        code: 'PROMPT_INJECTION',
      });
      return;
    }

    const verbosity: Verbosity = body.verbosity || parseVerbosityHeader(req.headers['x-verbosity'] as string | undefined) || 'answers';
    const mode: PromptMode = body.mode ?? 'prompt';

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    if (mode === 'steer' && entry.sdkType !== 'pi') {
      sendJson(res, 400, { error: `Prompt mode '${mode}' is not supported for ${entry.sdkType}`, code: 'UNSUPPORTED_OPERATION' });
      return;
    }

    const runtime = entry.sdkType;
    const isBusy = runtime === 'claude'
      ? claudeService.isRunning(sessionId)
      : runtime === 'opencode'
        ? opencodeService.isRunning(sessionId)
        : false;

    if (isBusy && mode === 'prompt') {
      sendJson(res, 409, { error: 'Session is currently busy', code: 'SESSION_BUSY' });
      return;
    }

    try {
      if (verbosity === 'full' || verbosity === 'tasks') {
        await handleStreamingPrompt(req, res, sessionId, runtime, body.message, verbosity, mode);
        return;
      }

      await handleAnswersPrompt(res, sessionId, runtime, body.message, mode);
    } catch (err) {
      console.error('[InternalAPI] Prompt failed:', err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : 'Prompt execution failed',
          code: 'RUNTIME_ERROR',
        });
      }
    }
  }

  async function handleAnswersPrompt(
    res: ServerResponse,
    sessionId: string,
    runtime: SessionRuntime,
    message: string,
    mode: PromptMode,
  ): Promise<void> {
    const collector = createEventCollector();

    await executePrompt(
      sessionId,
      runtime,
      message,
      mode,
      (event) => {
        collectAnswerEvent(collector, event);
      },
      (error) => {
        if (error) {
          collector.error = error;
        }
        collector.complete = true;
      },
    );

    if (collector.error) {
      sendJson(res, 500, {
        error: collector.error.message,
        code: 'RUNTIME_ERROR',
      });
      return;
    }

    sendJson(res, 200, {
      sessionId,
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
  ): Promise<void> {
    const sse = createSSEStream(res);

    req.on('close', () => {
      if (runtime === 'claude') claudeService.abort(sessionId);
      else if (runtime === 'opencode') opencodeService.abort(sessionId);
    });

    await executePrompt(
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
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

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
      console.error('[InternalAPI] Abort failed:', err);
      sendJson(res, 500, { error: 'Failed to abort session', code: 'INTERNAL_ERROR' });
    }
  }

  async function handleSessionControl(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await readJsonBody<SessionControlRequest>(req);
    if (!body?.action) {
      sendJson(res, 400, { error: 'action is required', code: 'INVALID_REQUEST' });
      return;
    }

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    try {
      let response: SessionControlResponse;
      switch (body.action) {
        case 'set_model': {
          if (!body.modelId) {
            sendJson(res, 400, { error: 'modelId is required for set_model', code: 'INVALID_REQUEST' });
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
            sendJson(res, 400, { error: 'level is required for set_thinking_level', code: 'INVALID_REQUEST' });
            return;
          }

          if (entry.sdkType === 'claude') {
            claudeService.setThinkingLevel(sessionId, body.level);
          } else if (entry.sdkType === 'opencode') {
            await opencodeService.setThinkingLevel(sessionId, body.level);
          } else if (entry.sdkType === 'pi') {
            const agentSession = multiSessionManager.getAgentSession(entry.path);
            if (!agentSession) {
              sendJson(res, 404, { error: 'Pi session not loaded', code: 'SESSION_NOT_FOUND' });
              return;
            }
            agentSession.setThinkingLevel(body.level);
          } else {
            sendJson(res, 400, { error: 'Thinking level not supported for this runtime', code: 'UNSUPPORTED_OPERATION' });
            return;
          }

          response = { success: true, action: 'set_thinking_level', level: body.level };
          break;
        }

        case 'pin': {
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
          response = { success: unpinned, action: 'unpin', pinned: false };
          break;
        }

        default:
          sendJson(res, 400, { error: `Unsupported action '${(body as { action?: string }).action}'`, code: 'INVALID_REQUEST' });
          return;
      }

      sendJson(res, 200, response);
    } catch (err) {
      console.error('[InternalAPI] Session control failed:', err);
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'Session control failed', code: 'INTERNAL_ERROR' });
    }
  }

  async function handleRespondApproval(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const body = await readJsonBody<ApprovalResponseRequest>(req);
    if (!body || typeof body.approved !== 'boolean') {
      sendJson(res, 400, { error: 'approved is required', code: 'INVALID_REQUEST' });
      return;
    }

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    try {
      if (entry.sdkType === 'claude') {
        claudeService.sendPermissionResponse(sessionId, requestId, body.approved);
      } else if (entry.sdkType === 'opencode') {
        await opencodeService.replyPermission(sessionId, requestId, body.approved);
      } else {
        sendJson(res, 400, { error: 'Approval responses are not supported for Pi sessions', code: 'UNSUPPORTED_OPERATION' });
        return;
      }

      sendJson(res, 200, {
        success: true,
        approved: body.approved,
      } satisfies ApprovalResponseResult);
    } catch (err) {
      console.error('[InternalAPI] Approval response failed:', err);
      sendJson(res, 500, { error: 'Approval response failed', code: 'INTERNAL_ERROR' });
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
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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

    req.on('close', () => {
      unsub();
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
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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

  async function handleSessionTranscript(
    _req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    query: URLSearchParams,
  ): Promise<void> {
    try {
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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
        const events = await antigravityService.getReplayEvents(sessionId);
        const { replayEventsToVisibleItems, buildVisibleTranscript } = await import('../../session-transfer/visible-transcript.js');
        const items = replayEventsToVisibleItems(events);
        transcriptResult = buildVisibleTranscript(items, source, scope);
      } else {
        sendJson(res, 501, { error: `Transcript not supported for runtime: ${entry.sdkType}`, code: 'NOT_IMPLEMENTED' });
        return;
      }

      if (transcriptError && transcriptResult.itemCount === 0) {
        sendJson(res, 404, { error: transcriptError, code: 'EMPTY_TRANSCRIPT' });
        return;
      }

      const t = transcriptResult;
      sendJson(res, 200, {
        sessionId,
        runtime: entry.sdkType as SessionRuntime,
        scope: t.scope,
        itemCount: t.itemCount,
        truncated: t.truncated,
        items: t.items,
        source: t.source,
      } satisfies TranscriptResponse);
    } catch (err) {
      console.error('[InternalAPI] Failed to build transcript:', err);
      sendJson(res, 500, { error: 'Failed to build transcript', code: 'INTERNAL_ERROR' });
    }
  }

  async function handleSessionTransfer(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const body = await readJsonBody<TransferSessionRequest>(req);
    if (!body) {
      sendJson(res, 400, { error: 'Request body required', code: 'INVALID_REQUEST' });
      return;
    }

    const targetSdk = body.createNew && !body.targetRuntime ? undefined : body.targetRuntime;
    if (body.createNew && !body.targetRuntime) {
      sendJson(res, 400, { error: 'targetRuntime is required when createNew is true', code: 'INVALID_REQUEST' });
      return;
    }

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { error: 'Source session not found', code: 'SESSION_NOT_FOUND' });
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
      piSessionDir,
      createPiSession: async (cwd: string) => {
        const status = await multiSessionManager.createAndSubscribe(internalClientId, cwd);
        return { sessionId: status.sessionId, sessionPath: status.sessionPath };
      },
      sendPiPrompt: async (sessionPath: string, message: string) => {
        await multiSessionManager.prompt(sessionPath, message);
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
      console.error('[InternalAPI] Transfer failed:', err);
      sendJson(res, 500, {
        success: false,
        sourceSessionId: sessionId,
        createdNewSession: false,
        error: {
          code: 'TRANSFER_DISPATCH_FAILED',
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
      sendJson(res, 400, { error: 'sessions[] is required and must be non-empty', code: 'INVALID_REQUEST' });
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
        return {
          index,
          success: true,
          sessionId: created.sessionId,
          sessionPath: created.sessionPath,
          runtime: created.runtime,
          model: created.model,
          cwd: created.cwd,
        };
      } catch (err) {
        return {
          index,
          success: false,
          runtime: entry.runtime,
          error: {
            code: 'SESSION_CREATE_FAILED',
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
      sendJson(res, 400, { error: 'prompts[] is required and must be non-empty', code: 'INVALID_REQUEST' });
      return;
    }

    const parallel = body.parallel !== false;

    const runOne = async (entry: { sessionId: string; message: string }, index: number) => {
      const injection = detectPromptInjection(entry.message);
      if (injection.recommendation === 'block') {
        return {
          index,
          sessionId: entry.sessionId,
          success: false,
          error: { code: 'PROMPT_INJECTION', message: 'Prompt blocked by safety filter' },
        };
      }
      try {
        const reg = await sessionRegistry.get(entry.sessionId);
        if (!reg) {
          return {
            index,
            sessionId: entry.sessionId,
            success: false,
            error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
          };
        }
        const collector = createEventCollector();
        await executePrompt(
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
            error: { code: 'RUNTIME_ERROR', message: collector.error.message },
          };
        }
        return {
          index,
          sessionId: entry.sessionId,
          success: true,
          content: collector.textParts.join(''),
          tokens: collector.usage,
        };
      } catch (err) {
        return {
          index,
          sessionId: entry.sessionId,
          success: false,
          error: {
            code: 'RUNTIME_ERROR',
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
      sendJson(res, 400, { error: 'sessionIds[] is required', code: 'INVALID_REQUEST' });
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
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
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

  return {
    handleCreateSession,
    handleListSessions,
    handleGetSession,
    handleGetSessionInfo,
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

/**
 * Internal API: Session Routes
 *
 * Handles session CRUD, prompt execution, and abort for all three runtimes.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { detectPromptInjection } from '../../security/prompt-injection.js';
import type { ClaudeService } from '../../claude/claude-service.js';
import type { OpenCodeService } from '../../opencode/opencode-service.js';
import type { MultiSessionManager } from '../../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../../session-registry.js';
import type {
  CreateSessionRequest,
  SendPromptRequest,
  CreateSessionResponse,
  SessionInfo,
  SessionDetail,
  ListSessionsResponse,
  PromptResponse,
  Verbosity,
  SessionRuntime,
} from '../types.js';
import {
  createEventCollector,
  collectAnswerEvent,
  writeTaskEvent,
  writeFullEvent,
} from '../event-filter.js';
import { createSSEStream } from '../sse-stream.js';

export interface SessionRoutesDeps {
  claudeService: ClaudeService;
  opencodeService: OpenCodeService;
  multiSessionManager: MultiSessionManager;
  sessionRegistry: SessionRegistryManager;
  /** Internal API client ID prefix for Pi SDK sessions */
  internalClientId: string;
}

export function createSessionRoutes(deps: SessionRoutesDeps) {
  const {
    claudeService,
    opencodeService,
    multiSessionManager,
    sessionRegistry,
    internalClientId,
  } = deps;

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
          const { sessionId } = await claudeService.createSession(cwd, body.model || 'sonnet');
          sendJson(res, 201, {
            sessionId,
            sessionPath: sessionId,
            runtime: 'claude',
            model: body.model || 'sonnet',
            cwd,
            createdAt: new Date().toISOString(),
          } satisfies CreateSessionResponse);
          return;
        }

        case 'opencode': {
          if (!(await opencodeService.isAvailable())) {
            sendJson(res, 503, { error: 'OpenCode runtime is not available', code: 'RUNTIME_UNAVAILABLE' });
            return;
          }
          const { sessionId } = await opencodeService.createSession(cwd);
          // Set model if specified
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
          return;
        }

        case 'pi':
        default: {
          const status = await multiSessionManager.createAndSubscribe(internalClientId, cwd);
          sendJson(res, 201, {
            sessionId: status.sessionId,
            sessionPath: status.sessionPath,
            runtime: 'pi',
            model: body.model,
            cwd,
            createdAt: new Date().toISOString(),
          } satisfies CreateSessionResponse);
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
      const registry = sessionRegistry;
      const all = await registry.listAll();

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

  async function handleGetSession(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      // Try to get richer stats from the runtime
      let tokens: SessionDetail['tokens'] | undefined;
      let cost: number | undefined;

      if (entry.sdkType === 'claude') {
        const stats = await claudeService.getSessionStats(sessionId);
        if (stats) {
          tokens = {
            input: stats.tokens.input,
            output: stats.tokens.output,
            total: stats.tokens.total,
          };
          cost = stats.cost;
        }
      } else if (entry.sdkType === 'opencode') {
        const ctxUsage = opencodeService.getContextUsage(sessionId);
        if (ctxUsage) {
          tokens = { input: 0, output: ctxUsage.tokens, total: ctxUsage.tokens };
        }
      }

      const isRunning =
        entry.sdkType === 'claude' ? claudeService.isRunning(sessionId) :
        entry.sdkType === 'opencode' ? opencodeService.isRunning(sessionId) :
        false;

      const isPinned =
        entry.sdkType === 'claude' ? claudeService.isSessionPinned(sessionId) :
        entry.sdkType === 'opencode' ? opencodeService.isSessionPinned(sessionId) :
        false;

      const detail: SessionDetail = {
        sessionId: entry.id,
        sessionPath: entry.path,
        runtime: entry.sdkType as SessionRuntime,
        cwd: entry.cwd,
        model: entry.model,
        status: isRunning ? 'running' : (entry.status === 'error' ? 'error' : 'idle'),
        messageCount: entry.messageCount,
        firstMessage: entry.firstMessage,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
        pinned: isPinned,
        tokens,
        cost,
      };

      sendJson(res, 200, detail);
    } catch (err) {
      console.error('[InternalAPI] Failed to get session:', err);
      sendJson(res, 500, { error: 'Failed to get session', code: 'INTERNAL_ERROR' });
    }
  }

  async function handleDeleteSession(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    try {
      const entry = await sessionRegistry.get(sessionId);
      if (!entry) {
        sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
        return;
      }

      // Abort if running
      if (entry.sdkType === 'claude') {
        claudeService.abort(sessionId);
      } else if (entry.sdkType === 'opencode') {
        opencodeService.abort(sessionId);
      } else {
        // Pi SDK: abort via MultiSessionManager
        const agentSession = multiSessionManager.getAgentSession(entry.path);
        if (agentSession) {
          await agentSession.abort().catch(() => { /* non-fatal */ });
        }
      }

      // Remove from registry
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

    // Prompt injection check
    const injectionCheck = detectPromptInjection(body.message);
    if (injectionCheck.recommendation === 'block') {
      sendJson(res, 400, {
        error: 'Prompt contains potentially malicious content',
        code: 'PROMPT_INJECTION',
      });
      return;
    }

    // Determine verbosity from header or body
    const verbosity: Verbosity = body.verbosity ||
      parseVerbosityHeader(req.headers['x-verbosity'] as string | undefined) ||
      'answers';

    const entry = await sessionRegistry.get(sessionId);
    if (!entry) {
      sendJson(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const runtime = entry.sdkType;

    // Check if session is busy
    const isBusy =
      runtime === 'claude' ? claudeService.isRunning(sessionId) :
      runtime === 'opencode' ? opencodeService.isRunning(sessionId) :
      false; // Pi: we'll let it queue

    if (isBusy) {
      sendJson(res, 409, { error: 'Session is currently busy', code: 'SESSION_BUSY' });
      return;
    }

    try {
      if (verbosity === 'full' || verbosity === 'tasks') {
        // Streaming mode — use SSE
        handleStreamingPrompt(req, res, sessionId, runtime, body.message, verbosity);
        return;
      }

      // Non-streaming mode (verbosity=answers) — collect and return
      await handleAnswersPrompt(res, sessionId, runtime, body.message);
    } catch (err) {
      console.error('[InternalAPI] Prompt failed:', err);
      // If headers not yet sent, send error response
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
    runtime: string,
    message: string,
  ): Promise<void> {
    const collector = createEventCollector();

    await executePrompt(
      sessionId,
      runtime,
      message,
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

    const content = collector.textParts.join('');
    sendJson(res, 200, {
      sessionId,
      messageId: collector.lastMessageId,
      content,
      tokens: collector.usage,
      turnComplete: true,
    } satisfies PromptResponse);
  }

  async function handleStreamingPrompt(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    runtime: string,
    message: string,
    verbosity: Verbosity,
  ): Promise<void> {
    const sse = createSSEStream(res);

    // Set up abort on client disconnect
    req.on('close', () => {
      if (runtime === 'claude') claudeService.abort(sessionId);
      else if (runtime === 'opencode') opencodeService.abort(sessionId);
    });

    await executePrompt(
      sessionId,
      runtime,
      message,
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

  /**
   * Execute a prompt on the appropriate runtime, streaming events.
   */
  async function executePrompt(
    sessionId: string,
    runtime: string,
    message: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    switch (runtime) {
      case 'claude': {
        // For Claude, we use the native callback pattern
        await claudeService.sendPrompt(sessionId, message, onEvent, onComplete);
        break;
      }

      case 'opencode': {
        await opencodeService.sendPrompt(sessionId, message, onEvent, onComplete);
        break;
      }

      case 'pi':
      default: {
        const entry = await sessionRegistry.get(sessionId);
        if (!entry) {
          throw new Error(`Pi session not found: ${sessionId}`);
        }

        const sessionPath = entry.path;
        // Ensure the session is loaded and subscribed
        const status = await multiSessionManager.subscribeClient(internalClientId, sessionPath);
        const agentSession = multiSessionManager.getAgentSession(sessionPath);
        if (!agentSession) {
          throw new Error(`Pi session not loaded: ${sessionId}`);
        }

        // Set up event observation for this specific session
        const eventObserver = (event: unknown) => {
          try { onEvent(event as NormalizedEvent); } catch { /* non-fatal */ }
        };
        multiSessionManager.addApiObserver(sessionPath, eventObserver);

        // Detect end of turn
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

        // Send the prompt
        try {
          await agentSession.prompt(message);
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

  return {
    handleCreateSession,
    handleListSessions,
    handleGetSession,
    handleDeleteSession,
    handleSendPrompt,
    handleAbort,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

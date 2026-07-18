/**
 * Claude SDK Backend Service
 *
 * Manages Claude sessions through the Claude Agent SDK (`query()`).
 * This is the preferred backend for Claude profiles: it provides
 * `canUseTool` permission callbacks, AbortController-based cancellation,
 * structured SDK messages, and session resume.
 *
 * Architecture:
 *   ClaudeService → ClaudeSdkService → @anthropic-ai/claude-agent-sdk query()
 *                                          → claude binary (subscription or provider profile)
 *
 * The SDK spawns the Claude Code binary underneath.  Profile env vars
 * (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model aliases) are passed
 * via Options.env which REPLACES the subprocess environment entirely.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSessionStore } from './claude-session-store.js';
import { ClaudeSdkEventAdapter } from './claude-sdk-event-adapter.js';
import {
  ClaudeProfileManager,
  resolveProfile,
  mapThinkingLevelToEffort,
  type ClaudeProfile,
  type ResolvedClaudeLaunch,
} from './claude-profiles.js';
import { resolveClaudeSessionPath } from './claude-process-pool.js';
import {
  isTransientClaudeError,
  getTransientRetryConfig,
  computeBackoffMs,
} from './claude-transient-errors.js';
import { getSessionRegistry, type SessionRegistryManager } from '../session-registry.js';
import {
  CLAUDE_AUTH_EXPIRED_CODE,
  isClaudeAuthError,
  buildReauthMessage,
  reauthContextFromProfile,
} from './claude-auth-errors.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('ClaudeSdkService');


// ─── Types ───────────────────────────────────────────────────────────────────

export interface SdkSessionState {
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  profileId?: string;
  model: string;
  isRunning: boolean;
  abortController?: AbortController;
  hasHistory: boolean;
}

export interface ClaudeSdkServiceConfig {
  claudeSessionDir: string;
  registryPath: string;
  profilesPath: string;
  defaultProfileId?: string;
}

/**
 * Structured resolution for an in-flight `AskUserQuestion` request.
 * - `answers` (keyed by exact question text) is forwarded back into the SDK as
 *   `updatedInput.answers`; multi-select answers are comma-separated labels.
 * - `cancelled`/absent answers map to a graceful allow-with-no-answers so Claude
 *   sees its own "user did not answer" behaviour instead of a permission denial.
 */
export interface AskUserQuestionResolution {
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
  cancelled?: boolean;
}

/**
 * Why a pending AskUserQuestion was resolved for a NON-answer reason. When a
 * request closes for any of these reasons the server emits an
 * `ask_user_question_closed` normalized event (→ `extension_ui_cancel` over
 * WebSocket) so the browser dialog can switch to an expired state instead of
 * hanging open as a zombie. The user's own answer/cancel NEVER triggers this.
 */
export type AskUserQuestionCloseReason = 'timeout' | 'aborted' | 'turn_end' | 'disconnected';

/** In-flight AskUserQuestion awaiting a browser/Internal API response. */
interface PendingAskUserQuestion {
  sessionId: string;
  toolCallId: string;
  originalInput: Record<string, unknown>;
  resolve: (result: AskUserQuestionResolution) => void;
  timeout: NodeJS.Timeout;
  abortListener: () => void;
  signal: AbortSignal;
  /** Emit a normalized event to subscribers (WebSocket + Internal API broker). */
  onEvent: (event: NormalizedEvent) => void;
}

/**
 * Wall-clock safety net before an unanswered AskUserQuestion gives up.
 *
 * This is NOT the primary abandonment signal — that is the disconnect grace
 * timer (see `connection.ts`): when the last subscriber for a session goes away
 * and does not come back, the pending question is cancelled for reason
 * `disconnected`. The wall clock here only guards against a query that somehow
 * kept a subscriber yet was never answered (e.g. a leaked/orphaned dialog), so
 * it is deliberately long (30 min — comfortably longer than any realistic
 * human answer time, yet finite so a leaked query cannot pin an SDK subprocess
 * forever). Override with `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS` (positive int,
 * ms); an invalid/zero/non-numeric value falls back to this default.
 */
const DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long a resolved AskUserQuestion's requestId is remembered as "recently
 * resolved", so a late browser/Internal-API answer arriving after the dialog
 * closed can be recognized and surfaced to the user instead of silently dropped.
 * Generous (matches the safety-net timeout) so any answer within the realistic
 * ask-user window is recognized; entries are TTL-evicted so the set is bounded.
 */
const RESOLVED_ASK_USER_TRACKING_TTL_MS = 30 * 60 * 1000;

// ─── Service ─────────────────────────────────────────────────────────────────

export class ClaudeSdkService {
  private sessionStore: ClaudeSessionStore;
  private registry: SessionRegistryManager;
  private profileManager: ClaudeProfileManager;
  private sessions = new Map<string, SdkSessionState>();
  private adapter = new ClaudeSdkEventAdapter();
  /** Active prompt count per profileId (for maxConcurrent enforcement). */
  private activePerProfile = new Map<string, number>();
  /** In-flight AskUserQuestion requests keyed by their dialog requestId. */
  private pendingAskUserQuestions = new Map<string, PendingAskUserQuestion>();
  /** Recently-resolved AskUserQuestion requestIds (TTL-evicted) so a late answer
   * can be recognized and surfaced instead of silently dropped (D3). */
  private resolvedAskUserQuestions = new Set<string>();

  constructor(cfg: ClaudeSdkServiceConfig) {
    this.sessionStore = new ClaudeSessionStore(cfg.claudeSessionDir);
    this.registry = getSessionRegistry(cfg.registryPath);
    this.profileManager = new ClaudeProfileManager({ profilesPath: cfg.profilesPath });
  }

  get profiles(): ClaudeProfileManager {
    return this.profileManager;
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  /**
   * Create a new SDK-backed Claude session.
   * If a profileId is provided, resolve and validate it.
   * Otherwise, fall back to the default profile or a plain subscription session.
   */
  async createSession(
    cwd: string,
    model: string = 'sonnet',
    thinkingLevel?: string,
    profileId?: string,
  ): Promise<{ sessionId: string; claudeSessionId: string; profile?: ClaudeProfile }> {
    const sessionId = randomUUID();
    const claudeSessionId = randomUUID();

    // Resolve profile if provided or if a default exists
    let profile: ClaudeProfile | undefined;
    if (profileId) {
      profile = this.profileManager.requireProfile(profileId);
    } else {
      const defaultId = this.profileManager.getDefaultProfileId();
      if (defaultId) {
        try {
          profile = this.profileManager.requireProfile(defaultId);
        } catch {
          // default profile not available — continue without profile
        }
      }
    }

    // Determine the effective model
    const effectiveModel = profile?.model ?? model;

    // Persist to JSONL store
    await this.sessionStore.initSession(sessionId, claudeSessionId, cwd, effectiveModel);

    // Register in the shared session registry
    const filePath = this.sessionStore.getFilePath(sessionId);
    await this.registry.upsert({
      id: sessionId,
      sdkType: 'claude',
      path: filePath,
      claudeSessionId,
      cwd,
      model: effectiveModel,
      thinkingLevel,
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
    });

    // Track in-memory
    this.sessions.set(sessionId, {
      sessionId,
      claudeSessionId,
      cwd,
      profileId: profile?.id,
      model: effectiveModel,
      isRunning: false,
      hasHistory: false,
    });

    return { sessionId, claudeSessionId, profile };
  }

  // ── Prompt execution ────────────────────────────────────────────────────

  /**
   * Run a prompt via the Claude Agent SDK.
   * Streams NormalizedEvents to onEvent, calls onComplete when done.
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`Claude SDK session not found: ${sessionId}`);
    }

    // Use in-memory state or fall back to registry data
    const claudeSessionId = state?.claudeSessionId ?? entry.claudeSessionId ?? randomUUID();
    const cwd = state?.cwd ?? entry.cwd;
    const profileId = state?.profileId;
    const model = state?.model ?? entry.model ?? 'sonnet';
    // Reasoning effort: read the session's current thinking level from the
    // registry each turn so Settings changes take effect on the next prompt.
    const thinkingLevel = entry.thinkingLevel;
    const isFollowUp = state?.hasHistory === true ||
      (entry.messageCount != null && entry.messageCount > 0) ||
      existsSync(resolveClaudeSessionPath(cwd, claudeSessionId));

    // Resolve the profile (if any)
    let resolved: ResolvedClaudeLaunch | undefined;
    let profile: ClaudeProfile | undefined;
    if (profileId) {
      profile = this.profileManager.requireProfile(profileId);
      resolved = resolveProfile(profile);

      // ── Concurrency limit enforcement ──────────────────────────────────
      const max = profile.maxConcurrent ?? 2;
      const active = this.activePerProfile.get(profileId) ?? 0;
      if (active >= max) {
        throw new Error(
          `Profile '${profileId}' has reached its maxConcurrent limit (${max}). ` +
          `Wait for an active session to finish or increase maxConcurrent in the profile config.`,
        );
      }
      this.activePerProfile.set(profileId, active + 1);
    }

    // Persist the user prompt
    await this.sessionStore.appendEntry(sessionId, {
      type: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    // Update registry status
    await this.registry.updateStatus(sessionId, 'running');

    // Emit agent_start
    const agentStart: NormalizedEvent = {
      type: 'agent_start',
      sessionId,
      timestamp: Date.now(),
      data: { sessionId, claudeSessionId },
    };
    try { onEvent(agentStart); } catch { /* non-fatal */ }

    // ── Execute with bounded transient-failure retries ──────────────────────
    // Anthropic/z.ai occasionally return transient capacity failures (model
    // "temporarily unavailable", overload, gateway/socket errors) or a silent
    // empty result (a result message with no content and zero tokens). We retry
    // those a bounded number of times with exponential backoff, but ONLY while
    // nothing has streamed yet, so a successful turn is never duplicated.
    // Permanent errors (auth, invalid model, prompt rejection) and user aborts
    // are surfaced immediately. See `claude-transient-errors.ts`.
    const retryCfg = getTransientRetryConfig();
    let attempt = 0;

    try {
      for (;;) {
        const abortController = new AbortController();
        if (state) {
          state.isRunning = true;
          state.abortController = abortController;
        }

        const sdkOptions = this.buildSdkOptions({
          resolved, cwd, model, thinkingLevel, claudeSessionId, isFollowUp, abortController,
          sessionId, onEvent,
        });

        let capturedClaudeSessionId: string | undefined;
        let sawContent = false;
        let resultSeen = false;
        let resultIsError = false;
        let resultText: string | undefined;
        let resultHasTokens = false;
        let attemptError: Error | undefined;

        try {
          const q = query({ prompt, options: sdkOptions });
          for await (const sdkMessage of q) {
            const events = this.adapter.adapt(sdkMessage as never, sessionId);

            // Capture the confirmed session ID from any message that carries one
            if (!capturedClaudeSessionId) {
              const sid = (sdkMessage as { type: string; session_id?: string }).session_id;
              if (sid && sid !== claudeSessionId) capturedClaudeSessionId = sid;
            }

            for (const event of events) {
              if (event.type === 'message_update' || event.type === 'tool_execution_start') {
                sawContent = true;
              }
              if (event.type === 'claude_result') {
                resultSeen = true;
                const d = event.data as Record<string, unknown> | undefined;
                resultIsError = d?.isError === true;
                resultText = typeof d?.result === 'string' ? (d.result as string) : undefined;
                const usage = d?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
                resultHasTokens = !!usage && ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)) > 0;
                if (resultText && resultText.trim()) sawContent = true;
              }
              try {
                await this.persistEvent(sessionId, event);
              } catch (persistErr) {
                logger.warn('[ClaudeSdkService] Failed to persist event:', persistErr);
              }
              try { onEvent(event); } catch { /* non-fatal */ }
            }
          }
        } catch (err) {
          attemptError = err instanceof Error ? err : new Error(String(err));
        }

        // Persist the confirmed claudeSessionId as soon as we have one.
        if (capturedClaudeSessionId && capturedClaudeSessionId !== claudeSessionId) {
          logger.info(`[ClaudeSdkService] Updating claudeSessionId: ${claudeSessionId} → ${capturedClaudeSessionId}`);
          await this.registry.upsert({
            id: sessionId, sdkType: 'claude', cwd, claudeSessionId: capturedClaudeSessionId,
          });
          if (state) state.claudeSessionId = capturedClaudeSessionId;
        }

        const aborted = abortController.signal.aborted;
        // A result message that came back with no content and zero tokens — the
        // exact "Opus never answered" symptom.
        const emptyResult = !sawContent && resultSeen && !resultHasTokens && !resultIsError;
        // The generator ended without ever producing a result message.
        const noResult = !resultSeen && !attemptError;
        const failed = !!attemptError || resultIsError || emptyResult || noResult;

        if (!failed) {
          if (state) state.hasHistory = true;
          try {
            onEvent({ type: 'agent_end', sessionId, timestamp: Date.now(), data: {} });
          } catch { /* non-fatal */ }
          await this.registry.updateStatus(sessionId, 'idle');
          await this.registry.upsert({
            id: sessionId, sdkType: 'claude', cwd, lastActivity: new Date().toISOString(),
          });
          onComplete();
          return;
        }

        const failMessage = attemptError?.message
          ?? (resultIsError
            ? (resultText && resultText.trim() ? resultText : 'Claude returned an error result.')
            : emptyResult
              ? 'Claude returned an empty response (no output, 0 tokens) — the model may be temporarily unavailable or overloaded.'
              : 'Claude produced no result (the session ended without a response).');

        // Retry only transient failures, only while nothing has streamed, and
        // never after a user abort. An empty zero-token result is treated as
        // transient (it is the capacity-failure fingerprint).
        const transient = !aborted && (isTransientClaudeError(failMessage) || emptyResult);
        const canRetry = transient && !sawContent && attempt < retryCfg.maxRetries;

        if (canRetry) {
          attempt += 1;
          const delay = computeBackoffMs(attempt, retryCfg.baseDelayMs, retryCfg.maxDelayMs);
          logger.warn(
            `[ClaudeSdkService] Transient failure on ${sessionId} ` +
            `(attempt ${attempt}/${retryCfg.maxRetries}): ${failMessage} — retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Surface as a real, persisted error.
        if (state) state.hasHistory = true; // partial history counts

        // Distinguish auth-expiry from other failures so the client can show a
        // profile-aware "re-authenticate" affordance (native: `claude auth
        // login`; provider profile: refresh token). See `claude-auth-errors.ts`.
        const authExpired = isClaudeAuthError(failMessage);
        const clientMessage = authExpired
          ? buildReauthMessage(reauthContextFromProfile(profile))
          : failMessage;
        const errorCode = authExpired ? CLAUDE_AUTH_EXPIRED_CODE : undefined;

        const error = new Error(failMessage) as Error & {
          code?: string;
          sessionEventAlreadyEmitted?: boolean;
        };
        if (authExpired) error.code = CLAUDE_AUTH_EXPIRED_CODE;
        await this.registry.updateStatus(sessionId, 'error');
        try {
          await this.sessionStore.appendEntry(sessionId, {
            type: 'error', content: clientMessage, isError: true,
            code: errorCode, reauthRequired: authExpired || undefined,
            timestamp: Date.now(),
          });
        } catch (persistErr) {
          logger.warn('[ClaudeSdkService] Failed to persist error entry:', persistErr);
        }
        try {
          onEvent({
            type: 'error', sessionId, timestamp: Date.now(),
            data: { error: failMessage, message: clientMessage, code: errorCode, reauthRequired: authExpired || undefined },
          });
        } catch { /* non-fatal */ }
        // For auth-expiry, emit our own agent_end and mark the session event as
        // already emitted so connection.ts does not also push a generic
        // CLAUDE_ERROR or a duplicate agent_end on top.
        if (authExpired) {
          try {
            onEvent({ type: 'agent_end', sessionId, timestamp: Date.now(), data: { reason: 'auth_expired' } });
          } catch { /* non-fatal */ }
          error.sessionEventAlreadyEmitted = true;
        }
        onComplete(error);
        return;
      }
    } finally {
      // Resolve + remove any AskUserQuestion dialogs still awaiting an answer
      // for this session. If the turn ended here (success, error, or abort),
      // the SDK will not consume their result, so cancelling them now (reason
      // `turn_end`) prevents a leak that would otherwise wait out the full
      // ask-user timeout, and tells any open browser dialog to retire.
      this.cancelPendingAskUserQuestionsForSession(sessionId, 'turn_end');
      if (state) {
        state.isRunning = false;
        state.abortController = undefined;
      }
      // Decrement concurrency counter
      if (profileId) {
        const current = this.activePerProfile.get(profileId) ?? 0;
        if (current > 0) {
          this.activePerProfile.set(profileId, current - 1);
        }
      }
    }
  }

  // ── Abort ───────────────────────────────────────────────────────────────

  abort(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.abortController) {
      state.abortController.abort();
    }
  }

  dispose(): void {
    for (const [sessionId, state] of this.sessions) {
      state.abortController?.abort();
      this.cancelPendingAskUserQuestionsForSession(sessionId, 'aborted');
    }
    this.resolvedAskUserQuestions.clear();
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isRunning ?? false;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionState(sessionId: string): SdkSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  // ── AskUserQuestion bridge ─────────────────────────────────────────────

  /** True iff an AskUserQuestion dialog with this requestId is still pending. */
  isPendingAskUserQuestion(requestId: string): boolean {
    return this.pendingAskUserQuestions.has(requestId);
  }

  /**
   * Resolve a pending AskUserQuestion request with structured answers, a
   * freeform response, annotations, or a cancellation. Returns false (no-op)
   * if no pending request exists for `requestId` (e.g. already timed out or
   * aborted).
   */
  respondToAskUserQuestion(requestId: string, response: AskUserQuestionResolution): boolean {
    if (!this.pendingAskUserQuestions.has(requestId)) return false;
    return this.resolvePendingAskUserQuestion(requestId, response);
  }

  /**
   * Resolve every still-pending AskUserQuestion for a session as cancelled,
   * emitting one `ask_user_question_closed` event per request with the given
   * reason. This is the abandonment surface used by the connection layer's
   * disconnect grace timer (reason `disconnected`) and by turn-end cleanup
   * (reason `turn_end`). Leaves other sessions' pending questions untouched.
   * Harmless no-op when the session has nothing pending.
   */
  cancelPendingAskUserQuestionsForSession(sessionId: string, reason: AskUserQuestionCloseReason): void {
    for (const [requestId, pending] of this.pendingAskUserQuestions) {
      if (pending.sessionId === sessionId) {
        this.resolvePendingAskUserQuestion(requestId, { cancelled: true }, { notifyClient: true, reason });
      }
    }
  }

  /** True iff any AskUserQuestion is currently pending for `sessionId`. */
  hasPendingAskUserQuestionForSession(sessionId: string): boolean {
    for (const pending of this.pendingAskUserQuestions.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Record a requestId as a recently-resolved AskUserQuestion (TTL-evicted), so
   * a late answer arriving after the dialog closed can be recognized.
   */
  private markAskUserQuestionResolved(requestId: string): void {
    this.resolvedAskUserQuestions.add(requestId);
    const timer = setTimeout(() => {
      this.resolvedAskUserQuestions.delete(requestId);
    }, RESOLVED_ASK_USER_TRACKING_TTL_MS);
    timer.unref?.();
  }

  /** True iff `requestId` was an AskUserQuestion that recently closed (not pending). */
  wasRecentlyResolvedAskUserQuestion(requestId: string): boolean {
    return this.resolvedAskUserQuestions.has(requestId);
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * The SDK backend is healthy if the claude binary is available and
   * (when profiles are used) at least one profile is enabled.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const { execSync } = await import('node:child_process');
      execSync('which claude', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  async getBackendMode(): Promise<'sdk'> {
    return 'sdk';
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private buildSdkOptions(opts: {
    resolved?: ResolvedClaudeLaunch;
    cwd: string;
    model: string;
    thinkingLevel?: string;
    claudeSessionId: string;
    isFollowUp: boolean;
    abortController: AbortController;
    sessionId: string;
    onEvent: (event: NormalizedEvent) => void;
  }): Options {
    const { resolved, cwd, model, thinkingLevel, claudeSessionId, isFollowUp, abortController, sessionId, onEvent } = opts;

    // Map the Web UI thinking level to a Claude effort level. Applies to both
    // native Claude and GLM (Z.ai maps Claude-native effort levels itself).
    const effort = mapThinkingLevelToEffort(thinkingLevel);

    // Always resolve the system claude binary to an absolute path.
    // The SDK ships its own bundled binary, but it may not match the host's
    // libc (e.g. musl vs glibc).  Using the system-installed claude avoids this.
    const claudePath = this.resolveClaudeBinary();

    const askUserTimeoutMs = this.getAskUserTimeoutMs();

    // If we have a resolved profile, use its env and settings
    if (resolved) {
      const sdkOpts: Options = {
        cwd,
        model: resolved.model,
        ...(effort ? { effort } : {}),
        env: resolved.env,
        abortController,
        pathToClaudeCodeExecutable: claudePath,
        settingSources: resolved.sdkOptions.settingSources as Array<'user' | 'project' | 'local'>,
        skills: resolved.sdkOptions.skills === 'all' ? 'all' : resolved.sdkOptions.skills,
        // dontAsk would deny AskUserQuestion before canUseTool can answer it;
        // default routes tool decisions through canUseTool (the real policy gate).
        permissionMode: this.buildEffectivePermissionMode(resolved.sdkOptions.permissionMode),
        allowedTools: this.withAskUserQuestionTool(resolved.sdkOptions.allowedTools),
        disallowedTools: resolved.sdkOptions.disallowedTools,
        ...(isFollowUp
          ? { resume: claudeSessionId }
          : {}),
        canUseTool: this.createCanUseTool({
          sessionId,
          allowedTools: resolved.sdkOptions.allowedTools,
          onEvent,
          askUserTimeoutMs,
        }),
        includePartialMessages: false,
      };
      return sdkOpts;
    }

    // No profile: native subscription session (strip API keys)
    const cleanEnv = { ...process.env };
    delete cleanEnv.ANTHROPIC_API_KEY;
    delete cleanEnv.ANTHROPIC_AUTH_TOKEN;

    const nativeAllowedTools = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'Skill', 'TodoWrite'];

    return {
      cwd,
      model,
      ...(effort ? { effort } : {}),
      env: cleanEnv,
      abortController,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: ['user', 'project'],
      skills: 'all',
      // See buildEffectivePermissionMode: default lets AskUserQuestion reach canUseTool.
      permissionMode: this.buildEffectivePermissionMode('dontAsk'),
      allowedTools: this.withAskUserQuestionTool(nativeAllowedTools),
      ...(isFollowUp
        ? { resume: claudeSessionId }
        : {}),
      canUseTool: this.createCanUseTool({
        sessionId,
        allowedTools: nativeAllowedTools,
        onEvent,
        askUserTimeoutMs,
      }),
      includePartialMessages: false,
    };
  }

  /**
   * Resolve the system-installed claude binary to an absolute path.
   * Cached after first resolution.
   */
  private _claudePath: string | null = null;
  private resolveClaudeBinary(): string {
    if (this._claudePath) return this._claudePath;
    try {
      this._claudePath = execSync('which claude', { encoding: 'utf-8', timeout: 2000 }).trim();
    } catch {
      this._claudePath = 'claude';
    }
    return this._claudePath;
  }

  /** Include AskUserQuestion in the SDK tool allowlist so Claude advertises it. */
  private withAskUserQuestionTool(allowedTools: string[] | undefined): string[] | undefined {
    if (!allowedTools) return allowedTools;
    return allowedTools.includes('AskUserQuestion') ? allowedTools : [...allowedTools, 'AskUserQuestion'];
  }

  /**
   * Resolve the effective SDK permission mode for a profile.
   *
   * `dontAsk` short-circuits `AskUserQuestion` to a permission denial before
   * `canUseTool` can supply answers, so SDK sessions with AskUserQuestion
   * support must NOT run in dontAsk. We prefer `default`, which routes every
   * tool decision through `canUseTool` (the real server-side policy gate).
   * Non-dontAsk profile modes (acceptEdits, plan, …) are passed through.
   */
  private buildEffectivePermissionMode(profileMode: string | undefined): Options['permissionMode'] {
    if (profileMode === 'dontAsk') return 'default';
    return (profileMode ?? 'default') as Options['permissionMode'];
  }

  /** Read the configurable AskUserQuestion timeout (env-overridable for ops/tests). */
  private getAskUserTimeoutMs(): number {
    const raw = process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS;
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS;
  }

  /**
   * Create a canUseTool callback that:
   *  - intercepts `AskUserQuestion`, emits an `ask_user_question_request`, and
   *    awaits a structured answer before returning `updatedInput.answers`;
   *  - auto-allows allowlisted tools and denies everything else
   *    (server-side, non-interactive).
   *
   * `AskUserQuestion` is also added to `options.allowedTools` so Claude Code
   * advertises the tool to the model; this callback remains the place where the
   * server supplies the structured answers via `updatedInput.answers`.
   */
  private createCanUseTool(params: {
    sessionId: string;
    allowedTools?: string[];
    onEvent: (event: NormalizedEvent) => void;
    askUserTimeoutMs: number;
  }) {
    const { sessionId, allowedTools, onEvent, askUserTimeoutMs } = params;
    const allowed = new Set(allowedTools ?? []);

    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string },
    ): Promise<PermissionResult> => {
      if (toolName === 'AskUserQuestion') {
        return this.handleAskUserQuestion({
          sessionId,
          input,
          options,
          onEvent,
          askUserTimeoutMs,
        });
      }

      if (allowed.size === 0 || allowed.has(toolName)) {
        return { behavior: 'allow' as const, updatedInput: input };
      }
      return {
        behavior: 'deny' as const,
        message: `Tool '${toolName}' is not in the allowed tools list for this profile`,
      };
    };
  }

  /**
   * Drive a single AskUserQuestion tool call: validate the questions, emit a
   * normalized request, await the browser/Internal API answer (or timeout /
   * abort), and return the matching PermissionResult.
   */
  private async handleAskUserQuestion(params: {
    sessionId: string;
    input: Record<string, unknown>;
    options: { signal: AbortSignal; toolUseID: string };
    onEvent: (event: NormalizedEvent) => void;
    askUserTimeoutMs: number;
  }): Promise<PermissionResult> {
    const { sessionId, input, options, onEvent, askUserTimeoutMs } = params;
    const toolCallId = options.toolUseID;

    // Defensively validate the questions payload before opening a pending
    // browser/Internal API dialog. Invalid tool inputs should fail fast with a
    // clear permission denial rather than leaving a modal that can never produce
    // a valid SDK answer.
    const validationError = this.validateAskUserQuestionInput(input);
    if (validationError) {
      logger.warn(
        `[ClaudeSdkService] Invalid AskUserQuestion input ` +
        `(toolCallId=${toolCallId}): ${validationError}`,
      );
      return {
        behavior: 'deny' as const,
        message: `Invalid AskUserQuestion input: ${validationError}`,
      };
    }
    const questions = input.questions as unknown[];

    const requestId = randomUUID();

    // Register the pending entry BEFORE emitting so a fast responder is never
    // racing an absent map entry.
    const resolution = new Promise<AskUserQuestionResolution>((resolve) => {
      const abortListener = () => {
        logger.info(`[ClaudeSdkService] AskUserQuestion aborted by SDK signal (requestId=${requestId})`);
        this.resolvePendingAskUserQuestion(requestId, { cancelled: true }, { notifyClient: true, reason: 'aborted' });
      };
      const timeout = setTimeout(() => {
        logger.info(`[ClaudeSdkService] AskUserQuestion timed out (requestId=${requestId})`);
        this.resolvePendingAskUserQuestion(requestId, { cancelled: true }, { notifyClient: true, reason: 'timeout' });
      }, askUserTimeoutMs);

      this.pendingAskUserQuestions.set(requestId, {
        sessionId,
        toolCallId,
        originalInput: input,
        resolve,
        timeout,
        abortListener,
        signal: options.signal,
        onEvent,
      });

      options.signal.addEventListener('abort', abortListener, { once: true });
      if (options.signal.aborted) {
        this.resolvePendingAskUserQuestion(requestId, { cancelled: true }, { notifyClient: true, reason: 'aborted' });
      }
    });

    // Surface the request to the browser (WebSocket) and Internal API (broker).
    try {
      onEvent({
        type: 'ask_user_question_request',
        sessionId,
        timestamp: Date.now(),
        data: {
          requestId,
          toolCallId,
          toolName: 'AskUserQuestion',
          questions,
          timeoutMs: askUserTimeoutMs,
        },
      });
    } catch (err) {
      logger.warn('[ClaudeSdkService] Failed to emit AskUserQuestion request; cancelling pending dialog:', err);
      this.resolvePendingAskUserQuestion(requestId, { cancelled: true });
    }

    const result = await resolution;

    // Cancelled / no-answer: allow with the original input so Claude receives
    // its own graceful "user did not answer" tool result, not a denial.
    if (result.cancelled || !result.answers) {
      return { behavior: 'allow' as const, updatedInput: input };
    }

    return {
      behavior: 'allow' as const,
      updatedInput: {
        ...input,
        answers: result.answers,
        ...(result.annotations ? { annotations: result.annotations } : {}),
      },
    };
  }

  /** Validate the subset of Claude SDK AskUserQuestionInput this UI supports. */
  private validateAskUserQuestionInput(input: Record<string, unknown>): string | null {
    const questions = input.questions;
    if (!Array.isArray(questions)) return 'questions must be an array';
    if (questions.length < 1 || questions.length > 4) return 'questions must contain 1 to 4 items';

    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      if (!q || typeof q !== 'object') return `questions[${i}] must be an object`;
      const qr = q as Record<string, unknown>;
      if (typeof qr.question !== 'string' || qr.question.trim().length === 0) return `questions[${i}].question must be a non-empty string`;
      if (typeof qr.header !== 'string' || qr.header.trim().length === 0) return `questions[${i}].header must be a non-empty string`;
      if (typeof qr.multiSelect !== 'boolean') return `questions[${i}].multiSelect must be a boolean`;
      if (!Array.isArray(qr.options) || qr.options.length < 2 || qr.options.length > 4) {
        return `questions[${i}].options must contain 2 to 4 items`;
      }
      for (let j = 0; j < qr.options.length; j += 1) {
        const opt = qr.options[j];
        if (!opt || typeof opt !== 'object') return `questions[${i}].options[${j}] must be an object`;
        const or = opt as Record<string, unknown>;
        if (typeof or.label !== 'string' || or.label.trim().length === 0) return `questions[${i}].options[${j}].label must be a non-empty string`;
        if (typeof or.description !== 'string') return `questions[${i}].options[${j}].description must be a string`;
        if (or.preview !== undefined && typeof or.preview !== 'string') return `questions[${i}].options[${j}].preview must be a string when provided`;
      }
    }

    return null;
  }

  /**
   * Resolve and clean up a pending AskUserQuestion. Idempotent: a second call
   * for an already-resolved requestId is a no-op returning false.
   *
   * `opts.notifyClient` (with a `reason`) emits an `ask_user_question_closed`
   * normalized event so the browser can retire the dialog. Because the entry is
   * deleted before the emit and this method is the single resolution path, the
   * notification fires AT MOST ONCE per request — regardless of how many
   * resolution signals (timeout, abort, turn-end, disconnect) race.
   */
  private resolvePendingAskUserQuestion(
    requestId: string,
    result: AskUserQuestionResolution,
    opts?: { notifyClient?: boolean; reason?: AskUserQuestionCloseReason },
  ): boolean {
    const pending = this.pendingAskUserQuestions.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    try { pending.signal.removeEventListener('abort', pending.abortListener); } catch { /* noop */ }
    this.pendingAskUserQuestions.delete(requestId);
    // Remember this requestId was a (now-closed) AskUserQuestion so a late answer
    // can be recognized and surfaced instead of silently dropped (D3).
    this.markAskUserQuestionResolved(requestId);
    if (opts?.notifyClient && opts.reason) {
      try {
        pending.onEvent({
          type: 'ask_user_question_closed',
          sessionId: pending.sessionId,
          timestamp: Date.now(),
          data: { requestId, reason: opts.reason },
        });
      } catch (err) {
        logger.warn('[ClaudeSdkService] Failed to emit ask_user_question_closed:', err);
      }
    }
    pending.resolve(result);
    return true;
  }

  /**
   * Persist selected NormalizedEvents to the JSONL session store.
   * Mirrors the logic in ClaudeService.persistEvent.
   */
  private async persistEvent(sessionId: string, event: NormalizedEvent): Promise<void> {
    const data = event.data as Record<string, unknown> | null | undefined;

    switch (event.type) {
      case 'message_update': {
        const msgEvent = data?.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (msgEvent?.type === 'text_delta' && msgEvent.delta) {
          await this.sessionStore.appendEntry(sessionId, {
            type: 'assistant',
            content: msgEvent.delta,
            timestamp: event.timestamp,
          });
        }
        break;
      }

      case 'tool_execution_start': {
        await this.sessionStore.appendEntry(sessionId, {
          type: 'tool',
          toolName: data?.toolName as string | undefined,
          toolCallId: data?.toolCallId as string | undefined,
          toolInput: data?.args,
          timestamp: event.timestamp,
        });
        break;
      }

      case 'tool_execution_end': {
        const resultContent = data?.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const textContent = resultContent?.content
          ? resultContent.content.map((c) => c.text ?? '').join('')
          : '';
        await this.sessionStore.appendEntry(sessionId, {
          type: 'tool_result',
          toolCallId: data?.toolCallId as string | undefined,
          toolOutput: textContent,
          isError: data?.isError as boolean | undefined,
          timestamp: event.timestamp,
        });
        break;
      }

      case 'agent_end': {
        // Try to extract usage from the last claude_result
        // (persisted as meta for cost/token tracking)
        break;
      }

      case 'claude_result': {
        // Persist usage AND the outcome (isError + a truncated result string),
        // so a failed/empty turn leaves a diagnostic trail instead of a silent
        // empty meta. See `claude-sdk-opus-silent-fail`.
        const rawResult = typeof data?.result === 'string' ? (data.result as string) : undefined;
        await this.sessionStore.appendEntry(sessionId, {
          type: 'meta',
          usage: data?.usage,
          isError: data?.isError === true ? true : undefined,
          content: rawResult ? rawResult.slice(0, 2000) : undefined,
          timestamp: event.timestamp,
        });
        break;
      }

      default:
        break;
    }
  }
}

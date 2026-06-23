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
import { getSessionRegistry, type SessionRegistryManager } from '../session-registry.js';
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

// ─── Service ─────────────────────────────────────────────────────────────────

export class ClaudeSdkService {
  private sessionStore: ClaudeSessionStore;
  private registry: SessionRegistryManager;
  private profileManager: ClaudeProfileManager;
  private sessions = new Map<string, SdkSessionState>();
  private adapter = new ClaudeSdkEventAdapter();
  /** Active prompt count per profileId (for maxConcurrent enforcement). */
  private activePerProfile = new Map<string, number>();

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

    // Build SDK options from the resolved profile
    const abortController = new AbortController();
    if (state) {
      state.isRunning = true;
      state.abortController = abortController;
    }

    const sdkOptions = this.buildSdkOptions({
      resolved,
      cwd,
      model,
      thinkingLevel,
      claudeSessionId,
      isFollowUp,
      abortController,
    });

    try {
      // Run the SDK query
      const q = query({
        prompt,
        options: sdkOptions,
      });

      // Iterate the async generator, adapting each SDK message
      let capturedClaudeSessionId: string | undefined;
      for await (const sdkMessage of q) {
        const events = this.adapter.adapt(sdkMessage as never, sessionId);

        // Capture the confirmed session ID from init
        if (!capturedClaudeSessionId) {
          const initData = (sdkMessage as { type: string; session_id?: string }).session_id;
          if (initData && initData !== claudeSessionId) {
            capturedClaudeSessionId = initData;
          }
        }

        for (const event of events) {
          // Persist interesting events
          try {
            await this.persistEvent(sessionId, event);
          } catch (persistErr) {
            logger.warn('[ClaudeSdkService] Failed to persist event:', persistErr);
          }
          try { onEvent(event); } catch { /* non-fatal */ }
        }
      }

      // Update claudeSessionId if the SDK used a different one
      if (capturedClaudeSessionId && capturedClaudeSessionId !== claudeSessionId) {
        logger.info(`[ClaudeSdkService] Updating claudeSessionId: ${claudeSessionId} → ${capturedClaudeSessionId}`);
        await this.registry.upsert({
          id: sessionId, sdkType: 'claude', cwd, claudeSessionId: capturedClaudeSessionId,
        });
        if (state) state.claudeSessionId = capturedClaudeSessionId;
      }

      // Mark session as having history
      if (state) state.hasHistory = true;

      // Emit agent_end (the query generator finishing is the true completion)
      try {
        onEvent({
          type: 'agent_end',
          sessionId,
          timestamp: Date.now(),
          data: {},
        });
      } catch { /* non-fatal */ }

      await this.registry.updateStatus(sessionId, 'idle');
      await this.registry.upsert({
        id: sessionId, sdkType: 'claude', cwd, lastActivity: new Date().toISOString(),
      });

      onComplete();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.registry.updateStatus(sessionId, 'error');
      try {
        onEvent({
          type: 'error',
          sessionId,
          timestamp: Date.now(),
          data: { error: error.message, message: error.message },
        });
      } catch { /* non-fatal */ }
      if (state) state.hasHistory = true; // partial history counts
      onComplete(error);
    } finally {
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

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isRunning ?? false;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionState(sessionId: string): SdkSessionState | undefined {
    return this.sessions.get(sessionId);
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
  }): Options {
    const { resolved, cwd, model, thinkingLevel, claudeSessionId, isFollowUp, abortController } = opts;

    // Map the Web UI thinking level to a Claude effort level. Applies to both
    // native Claude and GLM (Z.ai maps Claude-native effort levels itself).
    const effort = mapThinkingLevelToEffort(thinkingLevel);

    // Always resolve the system claude binary to an absolute path.
    // The SDK ships its own bundled binary, but it may not match the host's
    // libc (e.g. musl vs glibc).  Using the system-installed claude avoids this.
    const claudePath = this.resolveClaudeBinary();

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
        permissionMode: resolved.sdkOptions.permissionMode as Options['permissionMode'],
        allowedTools: resolved.sdkOptions.allowedTools,
        disallowedTools: resolved.sdkOptions.disallowedTools,
        ...(isFollowUp
          ? { resume: claudeSessionId }
          : {}),
        canUseTool: this.createCanUseTool(resolved.sdkOptions.allowedTools),
        includePartialMessages: false,
      };
      return sdkOpts;
    }

    // No profile: native subscription session (strip API keys)
    const cleanEnv = { ...process.env };
    delete cleanEnv.ANTHROPIC_API_KEY;
    delete cleanEnv.ANTHROPIC_AUTH_TOKEN;

    return {
      cwd,
      model,
      ...(effort ? { effort } : {}),
      env: cleanEnv,
      abortController,
      pathToClaudeCodeExecutable: claudePath,
      settingSources: ['user', 'project'],
      skills: 'all',
      permissionMode: 'dontAsk',
      allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'Skill', 'TodoWrite'],
      ...(isFollowUp
        ? { resume: claudeSessionId }
        : {}),
      canUseTool: this.createCanUseTool(['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'Skill', 'TodoWrite']),
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

  /**
   * Create a canUseTool callback that auto-allows tools in the allowlist
   * and denies everything else (server-side, non-interactive).
   */
  private createCanUseTool(allowedTools?: string[]) {
    const allowed = new Set(allowedTools ?? []);
    return async (_toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      if (allowed.size === 0 || allowed.has(_toolName)) {
        return { behavior: 'allow' as const, updatedInput: input };
      }
      return {
        behavior: 'deny' as const,
        message: `Tool '${_toolName}' is not in the allowed tools list for this profile`,
      };
    };
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
        await this.sessionStore.appendEntry(sessionId, {
          type: 'meta',
          usage: data?.usage,
          timestamp: event.timestamp,
        });
        break;
      }

      default:
        break;
    }
  }
}

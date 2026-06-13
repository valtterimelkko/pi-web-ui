/**
 * Claude Service
 * Orchestrates Claude CLI subprocess management, session persistence, and
 * event routing for the Dual-SDK feature.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { ClaudeProcessPool, resolveClaudeSessionPath } from './claude-process-pool.js';
import { ClaudeSessionStore } from './claude-session-store.js';
import { SessionRegistryManager, getSessionRegistry } from '../session-registry.js';
import { config } from '../config.js';
import { ClaudeChannelService } from './claude-channel-service.js';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface ClaudeAuthStatus {
  ok: boolean;
  error?: string;
  email?: string;
  subscriptionType?: string;
}

// ─── ClaudeService ────────────────────────────────────────────────────────────

function normalizeClaudeModelAlias(model: string): 'opus' | 'sonnet' | 'haiku' {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  return 'sonnet';
}

export class ClaudeService {
  private processPool: ClaudeProcessPool;
  private sessionStore: ClaudeSessionStore;
  private registry: SessionRegistryManager;
  private sessionsWithHistory: Set<string> = new Set();
  private pinnedSessions: Set<string> = new Set();
  private static readonly MAX_PINNED_SESSIONS = 2;
  private channelService: ClaudeChannelService | null = null;

  constructor(cfg: {
    claudeSessionDir: string;
    registryPath: string;
    maxProcesses?: number;
    useChannel?: boolean;
    channelPluginDir?: string;
    channelWsPort?: number;
    channelHookPort?: number;
  }) {
    this.processPool = new ClaudeProcessPool(cfg.maxProcesses ?? 10);
    this.sessionStore = new ClaudeSessionStore(cfg.claudeSessionDir);
    this.registry = getSessionRegistry(cfg.registryPath);

    if (cfg.useChannel && cfg.channelPluginDir) {
      this.channelService = new ClaudeChannelService({
        claudeSessionDir: cfg.claudeSessionDir,
        registryPath: cfg.registryPath,
        pluginDir: cfg.channelPluginDir,
        wsPort: cfg.channelWsPort ?? 3100,
        hookPort: cfg.channelHookPort ?? 3101,
        cwd: process.cwd(),
      });
    }
  }

  async startChannel(): Promise<void> {
    if (this.channelService) {
      await this.channelService.start();
    }
  }

  sendPermissionResponse(sessionId: string, requestId: string, allowed: boolean): void {
    if (this.channelService) {
      this.channelService.sendPermissionResponse(sessionId, requestId, allowed);
    }
  }

  // ── Auth & availability ───────────────────────────────────────────────────

  /**
   * Check whether Claude Code CLI is authenticated and using subscription auth.
   */
  async validateAuth(): Promise<ClaudeAuthStatus> {
    try {
      const result = execSync('claude auth status --json', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const status = JSON.parse(result) as {
        loggedIn?: boolean;
        email?: string;
        subscriptionType?: string;
        apiProvider?: string;
      };

      if (!status.loggedIn) {
        return {
          ok: false,
          error: 'Claude Code not logged in. Run: claude auth login',
        };
      }

      // Warn (but don't fail) if a pay-per-use API key is present in the
      // environment — Claude Direct sessions will strip it at spawn time.
      if (process.env.ANTHROPIC_API_KEY) {
        console.warn(
          '[ClaudeService] WARNING: ANTHROPIC_API_KEY detected in env — ' +
            'Claude Direct sessions will strip it to force subscription auth',
        );
      }

      return {
        ok: true,
        email: status.email,
        subscriptionType: status.subscriptionType,
      };
    } catch {
      return {
        ok: false,
        error: 'Claude Code not installed or auth check failed',
      };
    }
  }

  /**
   * Return true if the `claude` CLI binary is accessible on PATH.
   */
  async isAvailable(): Promise<boolean> {
    try {
      execSync('which claude', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new Claude session: allocate IDs, register in the registry and
   * session store, and return the IDs.
   */
  async createSession(
    cwd: string,
    model: string = 'sonnet',
  ): Promise<{ sessionId: string; claudeSessionId: string }> {
    if (this.channelService && await this.channelService.isHealthy()) {
      return this.channelService.createSession(cwd, model);
    }

    const sessionId = randomUUID();
    const claudeSessionId = randomUUID();

    // Persist to JSONL store
    await this.sessionStore.initSession(sessionId, claudeSessionId, cwd, model);

    // Register in the shared session registry
    const filePath = this.sessionStore.getFilePath(sessionId);
    await this.registry.upsert({
      id: sessionId,
      sdkType: 'claude',
      path: filePath,
      claudeSessionId,
      cwd,
      model,
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
    });

    return { sessionId, claudeSessionId };
  }

  // ── Prompt execution ──────────────────────────────────────────────────────

  /**
   * Run a prompt against an existing Claude session.
   * Streams normalised events to `onEvent` and calls `onComplete` when done.
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    if (this.channelService && await this.channelService.isHealthy()) {
      return this.channelService.sendPrompt(sessionId, prompt, onEvent, onComplete);
    }

    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`Claude session not found: ${sessionId}`);
    }
    if (!entry.claudeSessionId) {
      throw new Error(`Registry entry for ${sessionId} is missing claudeSessionId`);
    }

    // Persist the user prompt
    await this.sessionStore.appendEntry(sessionId, {
      type: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    // Update registry status to running
    await this.registry.updateStatus(sessionId, 'running');

    // Emit agent_start before spawning
    const agentStartEvent: NormalizedEvent = {
      type: 'agent_start',
      sessionId,
      timestamp: Date.now(),
      data: { sessionId, claudeSessionId: entry.claudeSessionId },
    };
    try {
      onEvent(agentStartEvent);
    } catch { /* non-fatal */ }

    // Check if this session has had a previous turn (for --resume vs --session-id)
    // 1. In-memory tracker (accurate within a single process lifetime)
    // 2. messageCount from registry (may be stale if never updated)
    // 3. Existence of Claude's own session JSONL file (survives restarts)
    const claudeSessionFile = resolveClaudeSessionPath(entry.cwd, entry.claudeSessionId);
    const isFollowUp = this.sessionsWithHistory.has(sessionId)
      || (entry.messageCount != null && entry.messageCount > 0)
      || existsSync(claudeSessionFile);

    // Spawn the process
    await this.processPool.spawn(
      {
        sessionId,
        claudeSessionId: entry.claudeSessionId,
        cwd: entry.cwd,
        model: entry.model ?? 'sonnet',
        prompt,
        isFollowUp,
      },
      // onEvent: persist interesting events, capture confirmed session_id, and forward to caller
      async (event: NormalizedEvent) => {
        // On first turn, capture the session_id Claude actually used so --resume targets it correctly
        if (event.type === 'session_init' && !this.sessionsWithHistory.has(sessionId)) {
          const confirmedSid = (event.data as Record<string, unknown>)?.sessionId as string | undefined;
          if (confirmedSid && confirmedSid !== entry.claudeSessionId) {
            console.log(`[ClaudeService] Updating claudeSessionId for ${sessionId}: ${entry.claudeSessionId} → ${confirmedSid}`);
            await this.registry.upsert({ id: sessionId, sdkType: 'claude', cwd: entry.cwd, claudeSessionId: confirmedSid });
            // Mutate entry so onComplete and future sends use the confirmed id
            entry.claudeSessionId = confirmedSid;
          }
        }
        try {
          await this.persistEvent(sessionId, event);
        } catch (persistErr) {
          console.warn('[ClaudeService] Failed to persist event:', persistErr);
        }
        try {
          onEvent(event);
        } catch { /* non-fatal */ }
      },
      // onComplete
      async (error?: Error) => {
        // Mark session as having history so future turns use --resume
        if (!error) {
          this.sessionsWithHistory.add(sessionId);
        }
        try {
          await this.registry.updateStatus(sessionId, error ? 'error' : 'idle');
          // Update lastActivity
          await this.registry.upsert({
            id: sessionId,
            sdkType: 'claude',
            cwd: entry.cwd,
            lastActivity: new Date().toISOString(),
          });
        } catch (regErr) {
          console.warn('[ClaudeService] Failed to update registry on complete:', regErr);
        }
        onComplete(error);
      },
    );
  }

  // ── Control ───────────────────────────────────────────────────────────────

  /** Abort the running prompt for a session. */
  abort(sessionId: string): void {
    if (this.channelService) {
      this.channelService.abort(sessionId);
      return;
    }
    this.processPool.abort(sessionId);
  }

  /** Return true if a prompt is currently running for the session. */
  isRunning(sessionId: string): boolean {
    if (this.channelService) {
      return this.channelService.isRunning(sessionId);
    }
    return this.processPool.isActive(sessionId);
  }

  async loadSessionHistory(sessionId: string) {
    if (this.channelService) {
      return this.channelService.loadSessionHistory(sessionId);
    }
    return this.sessionStore.loadHistory(sessionId);
  }

  async getBackendMode(): Promise<'direct' | 'channel'> {
    if (this.channelService && await this.channelService.isHealthy()) {
      return 'channel';
    }
    return 'direct';
  }

  async getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const { historyToReplayEvents } = await import('./claude-history-replay.js');
    const history = await this.loadSessionHistory(sessionId);
    return historyToReplayEvents(history);
  }

  async setModel(sessionId: string, model: string): Promise<'opus' | 'sonnet' | 'haiku'> {
    if (this.channelService) {
      const result = await this.channelService.setModel(sessionId, model);
      return normalizeClaudeModelAlias(result);
    }

    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`Claude session not found: ${sessionId}`);
    }
    const normalizedModel = normalizeClaudeModelAlias(model);
    await this.registry.patchSessionMeta(sessionId, { model: normalizedModel });
    return normalizedModel;
  }

  setThinkingLevel(sessionId: string, level: string): void {
    if (this.channelService) {
      this.channelService.setThinkingLevel(sessionId, level);
      return;
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getSession(sessionId: string) {
    if (this.channelService) {
      return this.channelService.getSession(sessionId);
    }
    return this.registry.get(sessionId);
  }

  async listSessions() {
    if (this.channelService) {
      return this.channelService.listSessions();
    }
    return this.registry.listBySdkType('claude');
  }

  // ── Pinning ─────────────────────────────────────────────────────────────

  pinSession(sessionId: string): boolean {
    if (this.channelService) {
      return this.channelService.pinSession(sessionId);
    }
    if (!this.hasSession(sessionId)) return false;
    if (this.pinnedSessions.has(sessionId)) return true;
    if (this.pinnedSessions.size >= ClaudeService.MAX_PINNED_SESSIONS) return false;
    this.pinnedSessions.add(sessionId);
    return true;
  }

  unpinSession(sessionId: string): boolean {
    if (this.channelService) {
      return this.channelService.unpinSession(sessionId);
    }
    return this.pinnedSessions.delete(sessionId);
  }

  isSessionPinned(sessionId: string): boolean {
    if (this.channelService) {
      return this.channelService.isSessionPinned(sessionId);
    }
    return this.pinnedSessions.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    if (this.channelService) {
      return this.channelService.hasSession(sessionId);
    }
    return this.pinnedSessions.has(sessionId)
      || this.processPool.isActive(sessionId)
      || this.sessionsWithHistory.has(sessionId);
  }

  /**
   * Check if a session exists in the registry (async, for thorough lookups).
   */
  async sessionExistsInRegistry(sessionId: string): Promise<boolean> {
    const entry = await this.registry.get(sessionId);
    return entry?.sdkType === 'claude';
  }

  /**
   * Build session stats for the session info modal.
   */
  async getSessionStats(sessionId: string): Promise<{
    sessionId: string;
    cwd: string;
    sessionFile?: string;
    model: string | undefined;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    pinned: boolean;
    lastActivityAt: number | null;
  } | null> {
    if (this.channelService) {
      return this.channelService.getSessionStats(sessionId);
    }

    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'claude') return null;

    const history = await this.sessionStore.loadHistory(sessionId);

    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    for (const entry of history) {
      switch (entry.type) {
        case 'user': userMessages++; break;
        case 'assistant': assistantMessages++; break;
        case 'tool': toolCalls++; break;
        case 'tool_result': toolResults++; break;
        case 'meta': {
          const usage = entry.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          if (usage) {
            totalTokens.input += usage.input_tokens ?? 0;
            totalTokens.output += usage.output_tokens ?? 0;
            totalTokens.cacheRead += usage.cache_read_input_tokens ?? 0;
            totalTokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
          }
          break;
        }
      }
    }
    totalTokens.total = totalTokens.input + totalTokens.output + totalTokens.cacheRead + totalTokens.cacheWrite;

    return {
      sessionId,
      cwd: entry.cwd,
      sessionFile: entry.path,
      model: entry.model,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: userMessages + assistantMessages + toolCalls + toolResults,
      tokens: totalTokens,
      cost: 0,
      pinned: this.pinnedSessions.has(sessionId),
      lastActivityAt: (this.channelService as ClaudeChannelService | null)?.getLastActivityAt?.() ?? null,
    };
  }

  async getContextUsage(sessionId: string): Promise<{ contextWindow: number; tokens: number; percent: number } | null> {
    if (this.channelService) {
      return this.channelService.getContextUsage(sessionId);
    }
    return null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Persist selected normalised events to the JSONL session store.
   */
  private async persistEvent(sessionId: string, event: NormalizedEvent): Promise<void> {
    const data = event.data as Record<string, unknown> | null | undefined;

    switch (event.type) {
      case 'message_update': {
        // Persist assistant text deltas as assistant entries
        const msgEvent = data?.assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
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
        // Extract the text content from the result for persistence
        const resultContent = data?.result as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const textContent =
          resultContent?.content
            ? (resultContent.content as Array<{ type?: string; text?: string }>)
                .map((c) => c.text ?? '')
                .join('')
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
        await this.sessionStore.appendEntry(sessionId, {
          type: 'meta',
          usage: data?.usage,
          timestamp: event.timestamp,
        });
        break;
      }

      default:
        // Other events are not persisted individually
        break;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let claudeServiceInstance: ClaudeService | null = null;

export function getClaudeService(): ClaudeService {
  if (claudeServiceInstance === null) {
    claudeServiceInstance = new ClaudeService({
      claudeSessionDir: config.claudeSessionDir,
      registryPath: config.sessionRegistryPath,
      maxProcesses: config.maxClaudeProcesses,
      useChannel: config.claudeChannelEnabled,
      channelPluginDir: config.claudeChannelPluginDir,
      channelWsPort: config.claudeChannelWsPort,
      channelHookPort: config.claudeChannelHookPort,
    });
  }
  return claudeServiceInstance;
}

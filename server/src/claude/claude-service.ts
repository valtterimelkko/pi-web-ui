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
  /** Track sessions that have completed at least one turn */
  private sessionsWithHistory: Set<string> = new Set();

  constructor(cfg: {
    claudeSessionDir: string;
    registryPath: string;
    maxProcesses?: number;
  }) {
    this.processPool = new ClaudeProcessPool(cfg.maxProcesses ?? 10);
    this.sessionStore = new ClaudeSessionStore(cfg.claudeSessionDir);
    this.registry = getSessionRegistry(cfg.registryPath);
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
    this.processPool.abort(sessionId);
  }

  /** Return true if a prompt is currently running for the session. */
  isRunning(sessionId: string): boolean {
    return this.processPool.isActive(sessionId);
  }

  /** Update the model for a session (persisted in registry). */
  async setModel(sessionId: string, model: string): Promise<'opus' | 'sonnet' | 'haiku'> {
    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`Claude session not found: ${sessionId}`);
    }
    const normalizedModel = normalizeClaudeModelAlias(model);
    await this.registry.upsert({
      id: sessionId,
      sdkType: 'claude',
      cwd: entry.cwd,
      model: normalizedModel,
    });
    return normalizedModel;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getSession(sessionId: string) {
    return this.registry.get(sessionId);
  }

  async listSessions() {
    return this.registry.listBySdkType('claude');
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
    });
  }
  return claudeServiceInstance;
}

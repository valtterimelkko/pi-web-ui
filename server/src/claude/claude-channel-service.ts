import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { ClaudeChannelProcessManager } from './claude-channel-process-manager.js';
import { ClaudeChannelWsClient } from './claude-channel-ws-client.js';
import type { ChannelEvent, ChannelClientRequest } from './claude-channel-ws-client.js';
import { ClaudeChannelEventAdapter } from './claude-channel-event-adapter.js';
import { ClaudeChannelHooksConfig } from './claude-channel-hooks-config.js';
import { ClaudeSessionStore } from './claude-session-store.js';
import { SessionRegistryManager, getSessionRegistry } from '../session-registry.js';
import type { ClaudeAuthStatus } from './claude-service.js';

export interface ClaudeChannelServiceConfig {
  claudeSessionDir: string;
  registryPath: string;
  pluginDir: string;
  wsPort: number;
  hookPort: number;
  cwd: string;
  claudePath?: string;
  permissionMode?: string;
}

interface PendingPrompt {
  /** Unique id for this turn — used to keep events/logs unambiguous across turns. */
  promptId: string;
  onEvent: (event: NormalizedEvent) => void;
  onComplete: (error?: Error) => void;
  sentAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp of the most recent channel event forwarded to this prompt. */
  lastEventAt: number;
}

interface LatePromptListener {
  onEvent: (event: NormalizedEvent) => void;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_PINNED_SESSIONS = 2;
const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
const LATE_PROMPT_LISTENER_TTL_MS = 30 * 60 * 1000;
const IDLE_DETECTION_GRACE_MS = 3_000;
/**
 * How recently a channel event must have arrived for the PTY idle handler
 * to leave the turn alone. Channel/MCP prompts may not produce PTY busy
 * indicators at all, and Claude's thinking phase can last 10-30 seconds
 * with zero events.  Only force-complete if the channel has been truly
 * silent for this long.
 */
const IDLE_EVENT_SILENCE_MS = 60_000;
/**
 * Minimum time to wait after an agent_end before writing PTY slash commands
 * (/model, /effort). Claude Code's agent_end can fire before the PTY has
 * finished rendering the response, and slash commands written during
 * rendering are silently lost. This settle window ensures commands are
 * processed correctly.
 */
const POST_TURN_SETTLE_MS = 3_000;

type PromptCompletionError = Error & {
  code?: string;
  sessionEventAlreadyEmitted?: boolean;
};

const CLAUDE_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  sonnet: 200_000,
  haiku: 200_000,
  opus: 200_000,
};

interface SessionContextMeta {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class ClaudeChannelService {
  private processManager: ClaudeChannelProcessManager;
  private wsClient: ClaudeChannelWsClient;
  private eventAdapter: ClaudeChannelEventAdapter;
  private sessionStore: ClaudeSessionStore;
  private registry: SessionRegistryManager;
  private hooksConfig: ClaudeChannelHooksConfig;
  private cfg: ClaudeChannelServiceConfig;

  private pendingPrompts: Map<string, PendingPrompt> = new Map();
  private latePromptListeners: Map<string, LatePromptListener> = new Map();
  private claudeToInternal: Map<string, string> = new Map();
  private internalToClaude: Map<string, string> = new Map();
  private pinnedSessions: Set<string> = new Set();
  private sessionsWithHistory: Set<string> = new Set();
  private sessionContextMeta: Map<string, SessionContextMeta> = new Map();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** Timestamp of the most recent agent_end event. */
  private lastAgentEndAt = 0;
  /** Session whose turn was dispatched most recently — owns the shared PTY. */
  private lastActiveSessionId: string | null = null;
  /**
   * Sessions whose turn was explicitly aborted by the user. Late events from
   * Claude's ongoing (but now unwanted) response are silently dropped until the
   * next intentional sendPrompt() clears the flag.
   */
  private abortedSessions: Set<string> = new Set();

  constructor(cfg: ClaudeChannelServiceConfig) {
    this.cfg = cfg;
    this.processManager = new ClaudeChannelProcessManager({
      pluginDir: cfg.pluginDir,
      wsPort: cfg.wsPort,
      hookPort: cfg.hookPort,
      cwd: cfg.cwd,
      claudePath: cfg.claudePath,
      permissionMode: cfg.permissionMode,
    });
    this.wsClient = new ClaudeChannelWsClient(`ws://127.0.0.1:${cfg.wsPort}`, {
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      heartbeatInterval: 30000,
    });
    this.eventAdapter = new ClaudeChannelEventAdapter();
    this.sessionStore = new ClaudeSessionStore(cfg.claudeSessionDir);
    this.registry = getSessionRegistry(cfg.registryPath);
    this.hooksConfig = new ClaudeChannelHooksConfig({ hookPort: cfg.hookPort });
  }

  /** Tracks the most recent tool name for enriched stream_activity pings. */
  private lastKnownToolName: string | null = null;

  /**
   * The internal session ID that currently "owns" Claude's context.
   * When a different session sends its first prompt, we `/clear` first
   * to prevent context bleeding between sessions.
   */
  private contextOwnerSessionId: string | null = null;

  async start(): Promise<void> {
    if (this.started) return;

    await this.hooksConfig.writeHooksConfig();

    await this.processManager.start();

    this.wireUpEventHandler();

    this.processManager.on('idle', () => {
      this.handlePtyIdle();
    });

    this.processManager.on('activity', () => {
      this.handlePtyActivity();
    });

    this.processManager.on('auth_error', (payload: { message?: string } | undefined) => {
      this.handlePtyAuthError(payload?.message);
    });

    await this.wsClient.connect();

    await this.reconcileOrphanedRunningSessions();

    this.started = true;

    this.healthCheckInterval = setInterval(async () => {
      const healthy = await this.processManager.healthCheck();
      if (!healthy && this.processManager.isRunning()) {
        try {
          await this.restartProcess();
        } catch (err) {
          console.error('[ClaudeChannelService] Health check restart failed:', err);
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.wsClient.disconnect();

    await this.processManager.stop();

    try {
      await this.hooksConfig.removeHooksConfig();
    } catch { /* non-fatal */ }

    for (const [, pending] of this.pendingPrompts) {
      clearTimeout(pending.timer);
      pending.onComplete(new Error('Service shutting down'));
    }
    this.pendingPrompts.clear();
    for (const [, late] of this.latePromptListeners) {
      clearTimeout(late.timer);
    }
    this.latePromptListeners.clear();

    this.started = false;
  }

  async isHealthy(): Promise<boolean> {
    return this.started
      && this.processManager.isRunning()
      && this.wsClient.isConnected();
  }

  private wireUpEventHandler(): void {
    this.wsClient.onEvent((channelEvent: ChannelEvent) => {
      // Handle prompt_ack — a lightweight acknowledgment from the plugin
      // that it received and processed our prompt before forwarding to Claude.
      if (channelEvent.type === 'prompt_ack') {
        const ackSid = channelEvent.sessionId as string;
        console.log(`[ClaudeChannelService] Prompt ack received for session ${ackSid}`);
        return;
      }

      const normalizedEvents = this.eventAdapter.normalize(channelEvent);
      for (const ne of normalizedEvents) {
        const claudeSid = ne.sessionId ?? '';
        const mappedInternalSid = this.claudeToInternal.get(claudeSid);
        const internalSid = mappedInternalSid ?? claudeSid;
        const pending = this.pendingPrompts.get(internalSid);
        const late = this.latePromptListeners.get(internalSid);

        // Native Claude Code hooks report the interactive Claude session id, not
        // the Web UI chat id. If the id is unknown to this bridge, do not create
        // orphan Pi Web UI session files such as "419f...jsonl".
        if (!mappedInternalSid && !pending && !late) {
          continue;
        }

        // Suppress late events from a turn that the user explicitly aborted.
        // Without this, Claude's ongoing (but unwanted) response events would
        // keep arriving via latePromptListeners or the channel adapter, setting
        // isStreaming back to true in the frontend and making the stop button
        // vanish almost immediately after pressing it.
        if (this.abortedSessions.has(internalSid)) {
          // Allow agent_end through so the abort is cleanly finalized, but
          // drop everything else (message updates, tool events, etc.).
          if (ne.type === 'agent_end') {
            this.abortedSessions.delete(internalSid);
            // Fall through to the normal agent_end handler below.
          } else {
            continue;
          }
        }

        const eventTarget = pending ?? late;
        if (eventTarget) {
          // Track when the last channel event arrived so handlePtyIdle
          // can avoid force-completing turns where events are still flowing
          // (PTY busy indicators may not appear for channel/MCP prompts).
          if (pending) {
            pending.lastEventAt = Date.now();
          }
          try {
            eventTarget.onEvent(ne);
          } catch { /* non-fatal */ }
        }

        // Track the most recent tool name so stream_activity pings can carry it.
        if (ne.type === 'tool_execution_start' && ne.data) {
          const toolName = (ne.data as Record<string, unknown>).toolName as string | undefined;
          if (toolName) this.lastKnownToolName = toolName;
        }

        this.persistEvent(internalSid, ne).catch((err) => {
          console.warn('[ClaudeChannelService] Failed to persist event:', err);
        });

        if (ne.type === 'agent_end' && internalSid) {
          this.lastAgentEndAt = Date.now();
          const usage = (ne.data as Record<string, unknown> | undefined)?.usage as
            | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
            | undefined;
          if (usage) {
            this.registry.get(internalSid).then((entry) => {
              const existing = this.sessionContextMeta.get(internalSid);
              this.sessionContextMeta.set(internalSid, {
                inputTokens: (existing?.inputTokens ?? 0) + (usage.input_tokens ?? 0),
                outputTokens: (existing?.outputTokens ?? 0) + (usage.output_tokens ?? 0),
                model: entry?.model ?? existing?.model ?? 'sonnet',
              });
            }).catch(() => {});
          }
          this.registry.updateStatus(internalSid, 'idle').catch(() => {});
          this.sessionsWithHistory.add(internalSid);
          const p = this.pendingPrompts.get(internalSid);
          if (p) {
            clearTimeout(p.timer);
            this.pendingPrompts.delete(internalSid);
            this.processManager.markPromptComplete();
            p.onComplete();
          } else if (late) {
            this.clearLatePromptListener(internalSid);
          }
        }

        if (ne.type === 'error' && internalSid) {
          const data = ne.data as Record<string, unknown> | null | undefined;
          const msg = (data?.message as string) || 'Unknown channel error';
          const p = this.pendingPrompts.get(internalSid);
          if (p) {
            clearTimeout(p.timer);
            this.pendingPrompts.delete(internalSid);
            this.registry.updateStatus(internalSid, 'error').catch(() => {});
            p.onComplete(new Error(msg));
          }
        }

        if (ne.type === 'usage_report' && internalSid) {
          const data = ne.data as { inputTokens?: number; outputTokens?: number } | undefined;
          if (data?.inputTokens || data?.outputTokens) {
            this.registry.get(internalSid).then((entry) => {
              const existing = this.sessionContextMeta.get(internalSid);
              this.sessionContextMeta.set(internalSid, {
                inputTokens: (existing?.inputTokens ?? 0) + (data.inputTokens ?? 0),
                outputTokens: (existing?.outputTokens ?? 0) + (data.outputTokens ?? 0),
                model: entry?.model ?? existing?.model ?? 'sonnet',
              });
            }).catch(() => {});
          }
        }
      }
    });

    this.wsClient.onDisconnected(() => {
      console.warn('[ClaudeChannelService] WS client disconnected');
    });

    this.wsClient.onError((err: Error) => {
      console.error('[ClaudeChannelService] WS client error:', err.message);
    });
  }

  private async restartProcess(): Promise<void> {
    this.wsClient.disconnect();
    await this.processManager.stop();
    await this.processManager.start();
    await this.wsClient.connect();
  }

  private async reconcileOrphanedRunningSessions(): Promise<void> {
    try {
      const sessions = await this.registry.listBySdkType('claude');
      for (const session of sessions) {
        if (session.status === 'running') {
          await this.registry.updateStatus(session.id, 'idle');
          this.sessionsWithHistory.add(session.id);
        }
      }
    } catch (err) {
      console.warn('[ClaudeChannelService] Failed to reconcile orphaned running sessions:', err instanceof Error ? err.message : String(err));
    }
  }

  async createSession(
    cwd: string,
    model: string = 'sonnet',
  ): Promise<{ sessionId: string; claudeSessionId: string }> {
    const sessionId = randomUUID();
    const claudeSessionId = randomUUID();

    await this.sessionStore.initSession(sessionId, claudeSessionId, cwd, model);

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

    this.claudeToInternal.set(claudeSessionId, sessionId);
    this.internalToClaude.set(sessionId, claudeSessionId);

    this.processManager.switchModel(model);

    return { sessionId, claudeSessionId };
  }

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

    // Enforce at most one in-flight prompt per session. The channel drives a
    // single shared Claude process; allowing a second prompt while the first
    // turn is still running let the first turn's agent_end complete the WRONG
    // pending prompt (turn misattribution).
    if (this.pendingPrompts.has(sessionId)) {
      const busyErr = new Error(
        `A prompt is already in progress for session ${sessionId}`,
      ) as PromptCompletionError;
      busyErr.code = 'SESSION_BUSY';
      throw busyErr;
    }

    this.clearLatePromptListener(sessionId);
    // Clear any abort flag from a previous stop — the user is intentionally
    // sending a new prompt, so events from this turn should flow normally.
    this.abortedSessions.delete(sessionId);

    // ── Wait for PTY to settle after the previous turn ──
    // Claude Code's agent_end can fire before the PTY has finished rendering
    // the response. PTY slash commands (/model, /effort) written during
    // rendering are silently lost. We wait for both the busy indicator to
    // clear AND a minimum settle window after the last agent_end.
    await this.waitForPtySettle();

    // ── Restore session model & thinking level on the shared PTY ──
    // The channel architecture shares a single Claude Code process across
    // all sessions.  Another session's createSession() or setModel() may
    // have changed the PTY model.  Before dispatching this prompt we restore
    // the model and thinking level registered for THIS session so Claude
    // always uses the correct settings.
    const registeredModel = entry.model ?? 'sonnet';
    const registeredThinking = entry.thinkingLevel ?? 'medium';
    const modelChanged = this.processManager.switchModel(registeredModel);
    const thinkingChanged = this.processManager.setThinkingLevel(registeredThinking);

    // When the model or thinking level actually changed, Claude Code needs
    // time to process the /model and /effort PTY commands before the
    // WebSocket prompt arrives via MCP.  Without this delay, Claude may
    // process the prompt using the old model.
    if (modelChanged || thinkingChanged) {
      console.log(
        `[ClaudeChannelService] Model/thinking switch: model=${registeredModel}${modelChanged ? ' (changed)' : ''} thinking=${registeredThinking}${thinkingChanged ? ' (changed)' : ''}`,
      );
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── Context isolation: clear Claude's context when switching sessions ──
    // The channel architecture shares a single Claude Code process. Without
    // this gate, a new session would inherit context from a prior session.
    // We clear only when the session differs from the current context owner
    // AND the new session hasn't had a turn yet (first prompt = fresh start).
    const needsClear = this.contextOwnerSessionId !== sessionId
      && !this.sessionsWithHistory.has(sessionId);
    if (needsClear) {
      console.log(
        `[ClaudeChannelService] Context isolation: clearing Claude context for new session ${sessionId}` +
        (this.contextOwnerSessionId ? ` (was owned by ${this.contextOwnerSessionId})` : ' (first session)'),
      );
      await this.processManager.clearContext();
      this.contextOwnerSessionId = sessionId;
    } else if (!this.contextOwnerSessionId) {
      this.contextOwnerSessionId = sessionId;
    }

    const promptId = randomUUID();

    await this.sessionStore.appendEntry(sessionId, {
      type: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    await this.registry.updateStatus(sessionId, 'running');

    this.lastActiveSessionId = sessionId;
    this.processManager.markPromptSent();

    const agentStartEvent: NormalizedEvent = {
      type: 'agent_start',
      sessionId,
      timestamp: Date.now(),
      data: { sessionId, claudeSessionId: entry.claudeSessionId, promptId },
    };
    try {
      onEvent(agentStartEvent);
    } catch { /* non-fatal */ }

    this.pendingPrompts.set(sessionId, {
      promptId,
      onEvent,
      onComplete,
      sentAt: Date.now(),
      lastEventAt: Date.now(),
      timer: setTimeout(() => {
        this.handlePromptTimeout(sessionId);
      }, PROMPT_TIMEOUT_MS),
    });
    this.claudeToInternal.set(entry.claudeSessionId, sessionId);
    this.internalToClaude.set(sessionId, entry.claudeSessionId);

    const request: ChannelClientRequest = {
      type: 'prompt',
      sessionId: entry.claudeSessionId,
      content: prompt,
      cwd: entry.cwd,
    };
    this.wsClient.send(request);
  }

  abort(sessionId: string): void {
    const claudeSid = this.internalToClaude.get(sessionId);
    if (claudeSid) {
      this.wsClient.send({ type: 'abort', sessionId: claudeSid });
    }

    // Send Escape to the PTY to interrupt Claude Code's current turn.
    // This is the mechanism Claude Code interactive mode actually responds to.
    this.processManager.sendInterrupt();

    // Mark this session as aborted so late events from Claude's dying response
    // are suppressed instead of reviving the streaming state in the frontend.
    this.abortedSessions.add(sessionId);

    // Clear any late listener that would forward stale events.
    this.clearLatePromptListener(sessionId);

    const pending = this.pendingPrompts.get(sessionId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingPrompts.delete(sessionId);
      this.processManager.markPromptComplete();
      this.registry.updateStatus(sessionId, 'idle').catch(() => {});
      pending.onComplete(new Error('Aborted'));
    }
  }

  /**
   * Whether a turn is genuinely in flight for this session. Reflects the real
   * PTY busy state, not just bookkeeping: a pending prompt always counts, and
   * as a safety net the session that owns the most recent turn also counts
   * while the PTY still shows Claude working (e.g. after a prompt timeout).
   */
  isRunning(sessionId: string): boolean {
    if (this.pendingPrompts.has(sessionId)) return true;
    if (this.lastActiveSessionId === sessionId && this.processManager.isBusy()) {
      return true;
    }
    return false;
  }

  async loadSessionHistory(sessionId: string) {
    return this.sessionStore.loadHistory(sessionId);
  }

  async setModel(sessionId: string, model: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`Claude session not found: ${sessionId}`);
    }
    // Use patchSessionMeta to update ONLY the model field — this eliminates the
    // race condition where a concurrent setThinkingLevel upsert could overwrite
    // the model back to its stale value.
    await this.registry.patchSessionMeta(sessionId, { model });
    this.processManager.switchModel(model);
    if (entry.claudeSessionId) {
      this.wsClient.send({ type: 'set_model', sessionId: entry.claudeSessionId, model });
    }
    return model;
  }

  setThinkingLevel(sessionId: string, level: string): void {
    this.processManager.setThinkingLevel(level);
    // Use patchSessionMeta to update ONLY the thinkingLevel field — this
    // eliminates the race condition where this method's async upsert could
    // overwrite the model back to its stale value.
    this.registry.patchSessionMeta(sessionId, { thinkingLevel: level }).catch(() => {});
  }

  async getSession(sessionId: string) {
    return this.registry.get(sessionId);
  }

  async listSessions() {
    return this.registry.listBySdkType('claude');
  }

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
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'claude') return null;

    const history = await this.sessionStore.loadHistory(sessionId);

    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    for (const h of history) {
      switch (h.type) {
        case 'user': userMessages++; break;
        case 'assistant': assistantMessages++; break;
        case 'tool': toolCalls++; break;
        case 'tool_result': toolResults++; break;
        case 'meta': {
          const usage = h.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
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
      lastActivityAt: this.processManager.getLastBusyAt(),
    };
  }

  private claudeProjectsDir = join(homedir(), '.claude', 'projects');

  private encodeCwdForClaude(cwd: string): string {
    return cwd.split(sep).join('-').replace(/^-/, '');
  }

  private async findClaudeSessionFile(cwd: string, claudeSessionId?: string): Promise<string | null> {
    const encodedCwd = this.encodeCwdForClaude(cwd);
    const projectDir = join(this.claudeProjectsDir, `-${encodedCwd}`);
    try {
      const files = await readdir(projectDir);
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      if (jsonlFiles.length === 0) return null;
      if (claudeSessionId) {
        const match = jsonlFiles.find(f => f === `${claudeSessionId}.jsonl`);
        if (match) return join(projectDir, match);
      }
      let latest: string | null = null;
      let latestMtime = 0;
      for (const f of jsonlFiles) {
        const stat = await import('node:fs').then(fs => fs.promises.stat(join(projectDir, f)));
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latest = join(projectDir, f);
        }
      }
      return latest;
    } catch {
      return null;
    }
  }

  private async getClaudeSessionUsage(cwd: string, model: string, claudeSessionId?: string): Promise<{ contextWindow: number; tokens: number; percent: number } | null> {
    const sessionFile = await this.findClaudeSessionFile(cwd, claudeSessionId);
    if (!sessionFile) return null;

    try {
      const content = await readFile(sessionFile, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      let lastUsage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
      let contextWindow = CLAUDE_MODEL_CONTEXT_WINDOWS[model] ?? 200_000;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.usage) {
            lastUsage = entry.message.usage;
          }
          if (entry.type === 'result' && entry.modelUsage) {
            for (const [, mu] of Object.entries(entry.modelUsage)) {
              const m = mu as { contextWindow?: number };
              if (m.contextWindow && m.contextWindow > 0) {
                contextWindow = m.contextWindow;
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }

      if (!lastUsage) return null;
      const input = (lastUsage.input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0);
      const output = lastUsage.output_tokens ?? 0;
      if (input === 0 && output === 0) return null;
      const tokens = input + output;
      const percent = Math.min(Math.round((tokens / contextWindow) * 100), 100);
      return { contextWindow, tokens, percent };
    } catch {
      return null;
    }
  }

  async getContextUsage(sessionId: string): Promise<{ contextWindow: number; tokens: number; percent: number } | null> {
    const entry = await this.registry.get(sessionId).catch(() => null);
    if (!entry) return null;
    const cwd = entry.cwd || process.cwd();
    let result = await this.getClaudeSessionUsage(cwd, entry.model ?? 'sonnet', entry.claudeSessionId);
    if (!result && cwd !== process.cwd()) {
      result = await this.getClaudeSessionUsage(process.cwd(), entry.model ?? 'sonnet', entry.claudeSessionId);
    }
    return result;
  }

  pinSession(sessionId: string): boolean {
    if (!this.hasSession(sessionId)) return false;
    if (this.pinnedSessions.has(sessionId)) return true;
    if (this.pinnedSessions.size >= MAX_PINNED_SESSIONS) return false;
    this.pinnedSessions.add(sessionId);
    return true;
  }

  unpinSession(sessionId: string): boolean {
    return this.pinnedSessions.delete(sessionId);
  }

  isSessionPinned(sessionId: string): boolean {
    return this.pinnedSessions.has(sessionId);
  }

  /** Expose the PTY last-busy timestamp for session info display. */
  getLastActivityAt(): number | null {
    return this.processManager.getLastBusyAt();
  }

  hasSession(sessionId: string): boolean {
    return this.pinnedSessions.has(sessionId)
      || this.pendingPrompts.has(sessionId)
      || this.sessionsWithHistory.has(sessionId);
  }

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

      if (process.env.ANTHROPIC_API_KEY) {
        console.warn(
          '[ClaudeChannelService] WARNING: ANTHROPIC_API_KEY detected in env — ' +
            'Claude Channel sessions will strip it to force subscription auth',
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

  async isAvailable(): Promise<boolean> {
    try {
      execSync('which claude', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  sendPermissionResponse(sessionId: string, requestId: string, allowed: boolean): void {
    this.wsClient.send({ type: 'permission_response', requestId, allowed });
  }

  /**
   * Wait until it is safe to write PTY slash commands (/model, /effort, /clear).
   * Two conditions must be met:
   * 1. The PTY busy indicator must be clear (Claude is not actively generating).
   * 2. At least POST_TURN_SETTLE_MS must have elapsed since the last agent_end,
   *    because agent_end can fire before the PTY finishes rendering.
   */
  private async waitForPtySettle(): Promise<void> {
    // 1. If the PTY shows a busy indicator, wait for it to clear (max 30s).
    if (this.processManager.isBusy()) {
      const idle = await this.processManager.waitForIdle(30_000);
      if (!idle) {
        console.warn('[ClaudeChannelService] Timed out waiting for PTY idle before slash commands');
      }
    }
    // 2. Ensure the minimum settle window after the last agent_end.
    //    Skip if no turn has completed yet (lastAgentEndAt === 0).
    if (this.lastAgentEndAt > 0) {
      const settleRemaining = (this.lastAgentEndAt + POST_TURN_SETTLE_MS) - Date.now();
      if (settleRemaining > 0) {
        await new Promise(r => setTimeout(r, settleRemaining));
      }
    }
  }

  /**
   * Forward a lightweight liveness ping to every in-flight turn. The Web UI
   * heartbeat uses this to show genuine progress while Claude is mid-turn but
   * not emitting send_event tool calls. Not persisted to the JSONL store.
   */
  private handlePtyActivity(): void {
    if (this.pendingPrompts.size === 0) return;
    const timestamp = Date.now();
    for (const [sessionId, pending] of this.pendingPrompts) {
      const activityData: Record<string, unknown> = { promptId: pending.promptId };
      if (this.lastKnownToolName) {
        activityData.currentToolName = this.lastKnownToolName;
      }
      const activityEvent: NormalizedEvent = {
        type: 'stream_activity',
        sessionId,
        timestamp,
        data: activityData,
      };
      try {
        pending.lastEventAt = Date.now();
        pending.onEvent(activityEvent);
      } catch { /* non-fatal */ }
    }
  }

  private handlePtyIdle(): void {
    if (this.pendingPrompts.size === 0) return;

    const now = Date.now();
    for (const [sessionId, pending] of this.pendingPrompts) {
      // Only force-complete if NO channel events have arrived recently.
      // Channel/MCP prompts may never produce PTY busy indicators, and
      // Claude's thinking phase can last 10-30 seconds with zero events.
      // If events were flowing recently, the turn is alive — let it
      // complete normally via agent_end or the 15-minute prompt timeout.
      const sinceLastEvent = now - pending.lastEventAt;
      if (sinceLastEvent < IDLE_EVENT_SILENCE_MS) continue;

      const elapsed = now - pending.sentAt;
      console.warn(`[ClaudeChannelService] PTY idle detected while session ${sessionId} (turn ${pending.promptId}) is pending — force-completing (elapsed=${elapsed}ms, sinceLastEvent=${sinceLastEvent}ms)`);
      clearTimeout(pending.timer);
      this.pendingPrompts.delete(sessionId);
      // Register a late listener so any events from Claude's still-running
      // turn are forwarded to the UI instead of being silently dropped.
      // This mirrors handlePromptTimeout() behavior.
      this.startLatePromptListener(sessionId, pending.onEvent);
      this.registry.updateStatus(sessionId, 'idle').catch(() => {});
      this.sessionsWithHistory.add(sessionId);

      const agentEndEvent: NormalizedEvent = {
        type: 'agent_end',
        sessionId,
        timestamp: Date.now(),
        data: { reason: 'pty_idle_detected' },
      };
      try {
        pending.onEvent(agentEndEvent);
      } catch { /* non-fatal */ }
      this.persistEvent(sessionId, agentEndEvent).catch(() => {});
      pending.onComplete();
    }
  }

  private handlePromptTimeout(sessionId: string): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending) return;

    console.warn(`[ClaudeChannelService] Prompt timeout for session ${sessionId} after ${PROMPT_TIMEOUT_MS / 1000}s`);
    clearTimeout(pending.timer);
    this.pendingPrompts.delete(sessionId);
    this.startLatePromptListener(sessionId, pending.onEvent);
    this.registry.updateStatus(sessionId, 'idle').catch(() => {});
    this.sessionsWithHistory.add(sessionId);

    const errorMessage = `Claude Direct prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s. If Claude Code was waiting on re-authentication, run /login or \`claude auth login\` and the queued reply may still arrive.`;
    this.emitPromptError(sessionId, pending, errorMessage, 'CLAUDE_PROMPT_TIMEOUT', 'prompt_timeout', false);
    const error = new Error(errorMessage) as PromptCompletionError;
    error.code = 'CLAUDE_PROMPT_TIMEOUT';
    error.sessionEventAlreadyEmitted = true;
    pending.onComplete(error);
  }

  private handlePtyAuthError(message?: string): void {
    if (this.pendingPrompts.size === 0) return;

    const errorMessage = message || 'Claude Code authentication expired. Please run /login or `claude auth login` on the server, then retry.';
    console.warn(`[ClaudeChannelService] Claude auth expired while ${this.pendingPrompts.size} prompt(s) pending`);

    for (const [sessionId, pending] of [...this.pendingPrompts.entries()]) {
      clearTimeout(pending.timer);
      this.pendingPrompts.delete(sessionId);
      this.startLatePromptListener(sessionId, pending.onEvent);
      this.registry.updateStatus(sessionId, 'error').catch(() => {});
      this.sessionsWithHistory.add(sessionId);
      this.emitPromptError(sessionId, pending, errorMessage, 'CLAUDE_AUTH_EXPIRED', 'auth_expired', true);
      const error = new Error(errorMessage) as PromptCompletionError;
      error.code = 'CLAUDE_AUTH_EXPIRED';
      error.sessionEventAlreadyEmitted = true;
      pending.onComplete(error);
    }
  }

  private emitPromptError(
    sessionId: string,
    pending: Pick<PendingPrompt, 'onEvent'>,
    message: string,
    code: string,
    endReason: string,
    reauthRequired: boolean,
  ): void {
    const timestamp = Date.now();
    const errorEvent: NormalizedEvent = {
      type: 'error',
      sessionId,
      timestamp,
      data: { message, code, reauthRequired },
    };
    const agentEndEvent: NormalizedEvent = {
      type: 'agent_end',
      sessionId,
      timestamp,
      data: { reason: endReason },
    };

    try {
      pending.onEvent(errorEvent);
      pending.onEvent(agentEndEvent);
    } catch { /* non-fatal */ }
    this.persistEvent(sessionId, errorEvent).catch(() => {});
    this.persistEvent(sessionId, agentEndEvent).catch(() => {});
  }

  private startLatePromptListener(sessionId: string, onEvent: (event: NormalizedEvent) => void): void {
    this.clearLatePromptListener(sessionId);
    const timer = setTimeout(() => {
      this.latePromptListeners.delete(sessionId);
    }, LATE_PROMPT_LISTENER_TTL_MS);
    this.latePromptListeners.set(sessionId, {
      onEvent,
      expiresAt: Date.now() + LATE_PROMPT_LISTENER_TTL_MS,
      timer,
    });
  }

  private clearLatePromptListener(sessionId: string): void {
    const existing = this.latePromptListeners.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.latePromptListeners.delete(sessionId);
    }
  }

  private async persistEvent(sessionId: string, event: NormalizedEvent): Promise<void> {
    if (!sessionId) return;

    const data = event.data as Record<string, unknown> | null | undefined;

    switch (event.type) {
      case 'message_update': {
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
        const rawResult = data?.result;
        let textContent = '';
        if (typeof rawResult === 'string') {
          textContent = rawResult;
        } else if (rawResult && typeof rawResult === 'object') {
          const resultContent = rawResult as { content?: Array<{ type?: string; text?: string }> };
          textContent = resultContent.content
            ? resultContent.content
                .map((c) => c.text ?? '')
                .join('')
            : JSON.stringify(rawResult);
        }
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

      case 'error': {
        await this.sessionStore.appendEntry(sessionId, {
          type: 'error',
          content: (data?.message as string | undefined) || 'Claude Direct error',
          code: data?.code as string | undefined,
          reauthRequired: data?.reauthRequired as boolean | undefined,
          timestamp: event.timestamp,
        });
        break;
      }
    }
  }
}

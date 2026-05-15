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
  onEvent: (event: NormalizedEvent) => void;
  onComplete: (error?: Error) => void;
}

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_PINNED_SESSIONS = 2;

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
  private claudeToInternal: Map<string, string> = new Map();
  private internalToClaude: Map<string, string> = new Map();
  private pinnedSessions: Set<string> = new Set();
  private sessionsWithHistory: Set<string> = new Set();
  private sessionContextMeta: Map<string, SessionContextMeta> = new Map();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;

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

  async start(): Promise<void> {
    if (this.started) return;

    await this.hooksConfig.writeHooksConfig();

    await this.processManager.start();

    this.wireUpEventHandler();

    await this.wsClient.connect();

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
      pending.onComplete(new Error('Service shutting down'));
    }
    this.pendingPrompts.clear();

    this.started = false;
  }

  async isHealthy(): Promise<boolean> {
    return this.started
      && this.processManager.isRunning()
      && this.wsClient.isConnected();
  }

  private wireUpEventHandler(): void {
    this.wsClient.onEvent((channelEvent: ChannelEvent) => {
      const normalizedEvents = this.eventAdapter.normalize(channelEvent);
      for (const ne of normalizedEvents) {
        const claudeSid = ne.sessionId ?? '';
        const internalSid = this.claudeToInternal.get(claudeSid) ?? claudeSid;
        const pending = this.pendingPrompts.get(internalSid);
        if (pending) {
          try {
            pending.onEvent(ne);
          } catch { /* non-fatal */ }
        }
        this.persistEvent(internalSid, ne).catch((err) => {
          console.warn('[ClaudeChannelService] Failed to persist event:', err);
        });

        if (ne.type === 'agent_end' && internalSid) {
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
          const p = this.pendingPrompts.get(internalSid);
          if (p) {
            this.pendingPrompts.delete(internalSid);
            this.registry.updateStatus(internalSid, 'idle').catch(() => {});
            this.sessionsWithHistory.add(internalSid);
            p.onComplete();
          }
        }

        if (ne.type === 'error' && internalSid) {
          const data = ne.data as Record<string, unknown> | null | undefined;
          const msg = (data?.message as string) || 'Unknown channel error';
          const p = this.pendingPrompts.get(internalSid);
          if (p) {
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

    await this.sessionStore.appendEntry(sessionId, {
      type: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    await this.registry.updateStatus(sessionId, 'running');

    const agentStartEvent: NormalizedEvent = {
      type: 'agent_start',
      sessionId,
      timestamp: Date.now(),
      data: { sessionId, claudeSessionId: entry.claudeSessionId },
    };
    try {
      onEvent(agentStartEvent);
    } catch { /* non-fatal */ }

    this.pendingPrompts.set(sessionId, { onEvent, onComplete });
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
    const pending = this.pendingPrompts.get(sessionId);
    if (pending) {
      this.pendingPrompts.delete(sessionId);
      this.registry.updateStatus(sessionId, 'idle').catch(() => {});
      pending.onComplete(new Error('Aborted'));
    }
  }

  isRunning(sessionId: string): boolean {
    return this.pendingPrompts.has(sessionId);
  }

  async loadSessionHistory(sessionId: string) {
    return this.sessionStore.loadHistory(sessionId);
  }

  async setModel(sessionId: string, model: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`Claude session not found: ${sessionId}`);
    }
    await this.registry.upsert({
      id: sessionId,
      sdkType: 'claude',
      cwd: entry.cwd,
      model,
    });
    this.processManager.switchModel(model);
    if (entry.claudeSessionId) {
      this.wsClient.send({ type: 'set_model', sessionId: entry.claudeSessionId, model });
    }
    return model;
  }

  setThinkingLevel(_sessionId: string, level: string): void {
    this.processManager.setThinkingLevel(level);
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
      let totalInput = 0;
      let totalOutput = 0;
      let contextWindow = CLAUDE_MODEL_CONTEXT_WINDOWS[model] ?? 200_000;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.usage) {
            const u = entry.message.usage;
            totalInput += (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.input_tokens ?? 0);
            totalOutput += u.output_tokens ?? 0;
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

      if (totalInput === 0 && totalOutput === 0) return null;
      const tokens = totalInput + totalOutput;
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
        const resultContent = data?.result as
          | { content?: Array<{ type?: string; text?: string }> }
          | undefined;
        const textContent = resultContent?.content
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
    }
  }
}

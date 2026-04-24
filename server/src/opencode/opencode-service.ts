import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { OpenCodeProcessManager } from './opencode-process-manager.js';
import { OpenCodeClient } from './opencode-client.js';
import { OpenCodeEventAdapter } from './opencode-event-adapter.js';
import { opencodeMessagesToReplayEvents } from './opencode-history-replay.js';
import { OpenCodeSessionSubscribers } from './opencode-session-subscribers.js';
import type { OpenCodeConfig, OpenCodeSSEEvent, OpenCodePermissionRule } from './opencode-types.js';
import { getSessionRegistry } from '../session-registry.js';
import { config } from '../config.js';

interface ActiveSessionMeta {
  lastActivity: number;
  lastEventTimestamp: number;
  pinned: boolean;
  status: 'idle' | 'streaming' | 'error';
  contextUsed: number;
  contextWindow: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  perMessageTokens: Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }>;
}

export interface OpenCodeSessionStatus {
  sessionId: string;
  status: string;
  lastActivity: Date;
  pinned: boolean;
}

export interface OpenCodeLifecycleConfig {
  maxSessions: number;
  idleTimeoutMs: number;
  staleStreamingMs: number;
  maxPinnedSessions: number;
  cleanupIntervalMs: number;
  serverMaxUptimeMs: number;
}

const DEFAULT_LIFECYCLE: OpenCodeLifecycleConfig = {
  maxSessions: 4,
  idleTimeoutMs: 30 * 60 * 1000,
  staleStreamingMs: 15 * 60 * 1000,
  maxPinnedSessions: 2,
  cleanupIntervalMs: 60 * 1000,
  serverMaxUptimeMs: 24 * 60 * 60 * 1000,
};

export const TRUSTED_OPENCODE_PERMISSION_RULES: OpenCodePermissionRule[] = [
  { permission: '*', action: 'allow', pattern: '*' },
  // Keep catastrophic disk/system operations blocked even in trusted unattended mode.
  { permission: 'bash', action: 'deny', pattern: 'mkfs *' },
  { permission: 'bash', action: 'deny', pattern: 'dd *' },
  { permission: 'bash', action: 'deny', pattern: 'shutdown *' },
  { permission: 'bash', action: 'deny', pattern: 'reboot *' },
  { permission: 'bash', action: 'deny', pattern: 'rm -rf /' },
  { permission: 'bash', action: 'deny', pattern: 'rm -rf /*' },
];

export class OpenCodeService {
  private processManager: OpenCodeProcessManager;
  private client: OpenCodeClient;
  private eventAdapter: OpenCodeEventAdapter;
  private subscribers: OpenCodeSessionSubscribers;
  private registry;
  private runningSessions: Set<string> = new Set();
  private pendingPermissions: Map<string, string> = new Map();
  private sseUnsubscribe: (() => void) | null = null;
  private sseStarted: boolean = false;
  private promptCallbacks: Map<string, {
    onEvent: (event: NormalizedEvent) => void;
    onComplete: (error?: Error) => void;
  }> = new Map();
  private opencodeSessionIds: Map<string, string> = new Map();
  private piSessionByOpencodeId: Map<string, string> = new Map();

  private lifecycle: OpenCodeLifecycleConfig;
  private sessionMeta: Map<string, ActiveSessionMeta> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: { registryPath: string; lifecycle?: Partial<OpenCodeLifecycleConfig> }) {
    const opencodeConfig: OpenCodeConfig = {
      host: config.opencodeServerHost,
      port: config.opencodeServerPort,
      password: config.opencodeServerPassword,
      workingDir: config.opencodeWorkingDir,
      enabled: config.opencodeServerEnabled,
    };

    this.processManager = new OpenCodeProcessManager(opencodeConfig);
    this.client = new OpenCodeClient(
      this.processManager.getBaseUrl(),
      this.processManager.getAuthHeaders(),
    );
    this.eventAdapter = new OpenCodeEventAdapter();
    this.subscribers = new OpenCodeSessionSubscribers();
    this.registry = getSessionRegistry(cfg.registryPath);

    this.lifecycle = {
      maxSessions: config.opencodeMaxSessions ?? DEFAULT_LIFECYCLE.maxSessions,
      idleTimeoutMs: config.opencodeIdleTimeoutMs ?? DEFAULT_LIFECYCLE.idleTimeoutMs,
      staleStreamingMs: config.opencodeStaleStreamingMs ?? DEFAULT_LIFECYCLE.staleStreamingMs,
      maxPinnedSessions: config.opencodeMaxPinnedSessions ?? DEFAULT_LIFECYCLE.maxPinnedSessions,
      cleanupIntervalMs: config.opencodeCleanupIntervalMs ?? DEFAULT_LIFECYCLE.cleanupIntervalMs,
      serverMaxUptimeMs: config.opencodeServerMaxUptimeMs ?? DEFAULT_LIFECYCLE.serverMaxUptimeMs,
    };
    if (cfg.lifecycle) {
      Object.assign(this.lifecycle, cfg.lifecycle);
    }

    this.startCleanupInterval();
  }

  private startCleanupInterval(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions();
      void this.recycleServerIfNeeded();
    }, this.lifecycle.cleanupIntervalMs);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();

    for (const [sessionId, meta] of this.sessionMeta) {
      if (meta.status === 'streaming' && now - meta.lastEventTimestamp > this.lifecycle.staleStreamingMs) {
        if (meta.pinned) {
          meta.status = 'idle';
          this.runningSessions.delete(sessionId);
          const callback = this.promptCallbacks.get(sessionId);
          if (callback) {
            this.promptCallbacks.delete(sessionId);
            callback.onComplete(new Error('Session stale-streaming reset (pinned session kept alive)'));
          }
          void this.registry.updateStatus(sessionId, 'idle');
        } else {
          meta.status = 'idle';
          this.runningSessions.delete(sessionId);
          const callback = this.promptCallbacks.get(sessionId);
          if (callback) {
            this.promptCallbacks.delete(sessionId);
            callback.onComplete(new Error('Session stale-streaming reset'));
          }
          void this.registry.updateStatus(sessionId, 'idle');
        }
      }
    }

    for (const [sessionId, meta] of this.sessionMeta) {
      if (meta.status === 'error') {
        this.removeSession(sessionId);
        continue;
      }

      if (meta.pinned) continue;
      if (this.runningSessions.has(sessionId)) continue;
      if (this.subscribers.getSubscriberCount(sessionId) > 0) continue;

      if (now - meta.lastActivity > this.lifecycle.idleTimeoutMs) {
        this.removeSession(sessionId);
      }
    }

    if (this.sessionMeta.size > this.lifecycle.maxSessions) {
      const candidates = [...this.sessionMeta.entries()]
        .filter(([id, m]) => m.status === 'idle' && !m.pinned && this.subscribers.getSubscriberCount(id) === 0)
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity);

      while (this.sessionMeta.size > this.lifecycle.maxSessions && candidates.length > 0) {
        const [evictId] = candidates.shift()!;
        this.removeSession(evictId);
      }
    }
  }

  private async recycleServerIfNeeded(): Promise<boolean> {
    if (this.lifecycle.serverMaxUptimeMs <= 0) return false;

    const status = this.processManager.getStatus();
    if (!status.uptimeMs || status.uptimeMs < this.lifecycle.serverMaxUptimeMs) return false;

    if (this.runningSessions.size > 0) {
      console.log(
        `[OpenCodeService] OpenCode server uptime ${status.uptimeMs}ms exceeds ${this.lifecycle.serverMaxUptimeMs}ms; recycle deferred for ${this.runningSessions.size} running session(s)`,
      );
      return false;
    }

    if (!status.healthy) return false;

    console.log(
      `[OpenCodeService] Recycling idle OpenCode server after ${status.uptimeMs}ms uptime`,
    );
    this.sseUnsubscribe?.();
    this.sseUnsubscribe = null;
    this.sseStarted = false;
    await this.processManager.recycle(`idle uptime ${status.uptimeMs}ms exceeded ${this.lifecycle.serverMaxUptimeMs}ms`);
    return true;
  }

  private removeSession(sessionId: string): void {
    this.sessionMeta.delete(sessionId);
    this.runningSessions.delete(sessionId);
    this.promptCallbacks.delete(sessionId);
    this.opencodeSessionIds.delete(sessionId);

    for (const [ocId, piId] of this.piSessionByOpencodeId) {
      if (piId === sessionId) {
        this.piSessionByOpencodeId.delete(ocId);
        break;
      }
    }
  }

  async ensureSession(sessionId: string): Promise<boolean> {
    if (this.sessionMeta.has(sessionId)) return true;

    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'opencode') return false;

    if (entry.opencodeSessionId) {
      this.opencodeSessionIds.set(sessionId, entry.opencodeSessionId);
      this.piSessionByOpencodeId.set(entry.opencodeSessionId, sessionId);
    }

    this.sessionMeta.set(sessionId, {
      lastActivity: Date.now(),
      lastEventTimestamp: Date.now(),
      pinned: false,
      status: 'idle',
      contextUsed: 0,
      contextWindow: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      perMessageTokens: new Map(),
    });

    return true;
  }

  async pinSession(sessionId: string): Promise<boolean> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    if (meta.pinned) return true;

    const pinnedCount = this.getPinnedCount();
    if (pinnedCount >= this.lifecycle.maxPinnedSessions) return false;

    meta.pinned = true;
    return true;
  }

  unpinSession(sessionId: string): boolean {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    meta.pinned = false;
    meta.lastActivity = Date.now();
    return true;
  }

  isSessionPinned(sessionId: string): boolean {
    return this.sessionMeta.get(sessionId)?.pinned ?? false;
  }

  getPinnedCount(): number {
    let count = 0;
    for (const meta of this.sessionMeta.values()) {
      if (meta.pinned) count++;
    }
    return count;
  }

  getProcessStatus() {
    return this.processManager.getStatus();
  }

  getSessionStatuses(): OpenCodeSessionStatus[] {
    const statuses: OpenCodeSessionStatus[] = [];
    for (const [sessionId, meta] of this.sessionMeta) {
      statuses.push({
        sessionId,
        status: this.runningSessions.has(sessionId) ? 'streaming' : meta.status,
        lastActivity: new Date(meta.lastActivity),
        pinned: meta.pinned,
      });
    }
    return statuses;
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMeta.has(sessionId);
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      meta.lastActivity = Date.now();
      meta.lastEventTimestamp = Date.now();
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.processManager.isAvailable();
  }

  async validateSetup(): Promise<{ ok: boolean; error?: string }> {
    const available = await this.isAvailable();
    if (!available) {
      return { ok: false, error: 'OpenCode is not installed or not on PATH' };
    }
    if (!config.opencodeServerEnabled) {
      return { ok: false, error: 'OpenCode integration is disabled' };
    }
    try {
      await this.processManager.start();
      const healthy = await this.processManager.isHealthy();
      if (!healthy) {
        return { ok: false, error: 'OpenCode server started but health check failed' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to start OpenCode server' };
    }
  }

  async createSession(cwd: string): Promise<{ sessionId: string; opencodeSessionId: string }> {
    await this.ensureServer();
    await this.cacheModelContextWindows();

    if (this.sessionMeta.size >= this.lifecycle.maxSessions) {
      this.evictOldestIdleSession();
    }

    const permissionRules = config.opencodeTrustedPermissions
      ? TRUSTED_OPENCODE_PERMISSION_RULES
      : undefined;
    const opencodeSession = await this.client.createSession(cwd, permissionRules);
    const sessionId = randomUUID();

    this.opencodeSessionIds.set(sessionId, opencodeSession.id);
    this.piSessionByOpencodeId.set(opencodeSession.id, sessionId);

    this.sessionMeta.set(sessionId, {
      lastActivity: Date.now(),
      lastEventTimestamp: Date.now(),
      pinned: false,
      status: 'idle',
      contextUsed: 0,
      contextWindow: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      perMessageTokens: new Map(),
    });

    await this.registry.upsert({
      id: sessionId,
      sdkType: 'opencode',
      path: sessionId,
      opencodeSessionId: opencodeSession.id,
      cwd,
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
    });

    return { sessionId, opencodeSessionId: opencodeSession.id };
  }

  private evictOldestIdleSession(): boolean {
    const candidates = [...this.sessionMeta.entries()]
      .filter(([, m]) => m.status === 'idle' && !m.pinned)
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity);

    if (candidates.length === 0) {
      console.warn('[OpenCodeService] Cannot evict: all sessions are busy or pinned');
      return false;
    }

    const [evictId] = candidates[0];
    console.log(`[OpenCodeService] Evicting idle session ${evictId} to make room`);
    this.removeSession(evictId);
    return true;
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
    agent?: string,
  ): Promise<void> {
    const entry = await this.registry.get(sessionId);
    if (!entry) {
      throw new Error(`OpenCode session not found: ${sessionId}`);
    }
    const ocSessionId = await this.getOpencodeSessionId(sessionId);
    if (!ocSessionId) {
      throw new Error(`Registry entry for ${sessionId} is missing opencodeSessionId`);
    }
    await this.ensureServer();
    await this.ensureSSESubscription();

    let meta = this.sessionMeta.get(sessionId);
    if (!meta) {
      meta = {
        lastActivity: Date.now(),
        lastEventTimestamp: Date.now(),
        pinned: false,
        status: 'idle',
        contextUsed: 0,
        contextWindow: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        perMessageTokens: new Map(),
      };
      this.sessionMeta.set(sessionId, meta);
    }
    meta.status = 'streaming';
    meta.lastActivity = Date.now();
    meta.lastEventTimestamp = Date.now();

    await this.registry.updateStatus(sessionId, 'running');
    this.runningSessions.add(sessionId);
    this.promptCallbacks.set(sessionId, { onEvent, onComplete });

    const agentStartEvent: NormalizedEvent = {
      type: 'agent_start',
      sessionId,
      timestamp: Date.now(),
      data: { sessionId, opencodeSessionId: ocSessionId },
    };
    try { onEvent(agentStartEvent); } catch { /* non-fatal */ }

    try {
      await this.client.promptAsync(ocSessionId, entry.cwd, prompt, entry.model, agent);
    } catch (err) {
      console.error(`[OpenCodeService] promptAsync failed:`, err instanceof Error ? err.message : String(err));
      this.completeSession(sessionId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private completeSession(sessionId: string, error?: Error): void {
    this.runningSessions.delete(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      meta.status = error ? 'error' : 'idle';
      meta.lastActivity = Date.now();
    }
    const callback = this.promptCallbacks.get(sessionId);
    if (callback) {
      this.promptCallbacks.delete(sessionId);
      callback.onComplete(error);
    }
    void this.registry.updateStatus(sessionId, error ? 'error' : 'idle');
  }

  abort(sessionId: string): void {
    void this.registry.get(sessionId).then((entry) => {
      if (!entry) return;
      return this.getOpencodeSessionId(sessionId).then((ocSessionId) => {
        if (!ocSessionId) return;
        return this.client.abort(ocSessionId, entry.cwd).catch((err) => {
          console.error('[OpenCodeService] Abort failed:', err);
        });
      });
    });
    this.completeSession(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId);
  }

  async getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const entry = await this.registry.get(sessionId);
    if (!entry) return [];

    const ocSessionId = await this.getOpencodeSessionId(sessionId);
    if (!ocSessionId) return [];

    try {
      await this.ensureServer();
      const messages = await this.client.getMessages(ocSessionId, entry.cwd);
      return opencodeMessagesToReplayEvents(messages, sessionId);
    } catch (err) {
      console.error('[OpenCodeService] Failed to get replay events:', err);
      return [];
    }
  }

  async replyPermission(
    sessionId: string,
    permissionId: string,
    approved: boolean,
  ): Promise<void> {
    const entry = await this.registry.get(sessionId);
    if (!entry) return;
    const ocSessionId = await this.getOpencodeSessionId(sessionId);
    if (!ocSessionId) return;
    await this.client.replyPermission(
      ocSessionId,
      entry.cwd,
      permissionId,
      approved,
      config.opencodePermissionApproveMode,
    );
  }

  async listSessions() {
    return this.registry.listBySdkType('opencode');
  }

  async getSession(sessionId: string) {
    return this.registry.get(sessionId);
  }

  async getSessionStats(sessionId: string): Promise<{
    sessionId: string;
    cwd: string;
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
    if (!entry || entry.sdkType !== 'opencode') return null;

    const events = await this.getReplayEvents(sessionId);

    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;

    for (const evt of events) {
      const type = (evt as Record<string, unknown>).type as string;
      switch (type) {
        case 'message_start':
        case 'message_end': {
          const msg = (evt as Record<string, unknown>).message as { role?: string } | undefined;
          if (msg?.role === 'user') userMessages++;
          else if (msg?.role === 'assistant') assistantMessages++;
          break;
        }
        case 'tool_execution_start': toolCalls++; break;
        case 'tool_execution_end': toolResults++; break;
      }
    }

    const meta = this.sessionMeta.get(sessionId);

    return {
      sessionId,
      cwd: entry.cwd,
      model: entry.model,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: userMessages + assistantMessages + toolCalls + toolResults,
      tokens: meta?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: meta?.cost ?? 0,
      pinned: meta?.pinned ?? false,
    };
  }

  getSubscriberTracker(): OpenCodeSessionSubscribers {
    return this.subscribers;
  }

  async getAvailableModels(): Promise<Array<{
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
    maxTokens: number;
    description: string;
  }>> {
    await this.ensureServer();
    const providers = await this.client.getProviders();
    const raw = (providers as { providers?: unknown }).providers ?? [];

    let providerList: Array<{ id?: string; name?: string; models?: unknown }>;
    if (Array.isArray(raw)) {
      providerList = raw as Array<{ id?: string; name?: string; models?: unknown }>;
    } else if (raw && typeof raw === 'object') {
      providerList = Object.entries(raw as Record<string, unknown>)
        .map(([id, val]) => ({ id, ...(val as Record<string, unknown>) }));
    } else {
      providerList = [];
    }

    const models = providerList.flatMap((provider) => {
      const providerId = provider.id ?? '';
      if (providerId !== 'zai-coding-plan') return [];

      let modelEntries: Array<{ id?: string; name?: string; limit?: { context?: number; output?: number }; status?: string }>;
      const rawModels = provider.models;
      if (Array.isArray(rawModels)) {
        modelEntries = rawModels as Array<{ id?: string; name?: string; limit?: { context?: number; output?: number }; status?: string }>;
      } else if (rawModels && typeof rawModels === 'object') {
        modelEntries = Object.values(rawModels as Record<string, unknown>) as Array<{ id?: string; name?: string; limit?: { context?: number; output?: number }; status?: string }>;
      } else {
        modelEntries = [];
      }

      return modelEntries
        .filter((model) => model.status !== 'deprecated')
        .map((model) => ({
          id: model.id ?? '',
          name: model.name ?? (model.id ?? ''),
          provider: providerId,
          contextWindow: model.limit?.context ?? 0,
          maxTokens: model.limit?.output ?? 0,
          description: 'OpenCode Direct via Z.AI Coding Plan',
        }))
        .filter((model) => model.id !== '');
    });

    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  async setModel(sessionId: string, modelId: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`OpenCode session not found: ${sessionId}`);
    await this.registry.upsert({
      ...entry,
      id: entry.id,
      sdkType: 'opencode',
      cwd: entry.cwd,
      model: modelId,
      opencodeSessionId: entry.opencodeSessionId,
    });
    return modelId;
  }

  private async ensureServer(): Promise<void> {
    if (!await this.processManager.isHealthy()) {
      await this.processManager.start();
    }
  }

  private async ensureSSESubscription(): Promise<void> {
    if (this.sseStarted) return;
    this.sseStarted = true;

    this.sseUnsubscribe = this.client.subscribeEvents((event) => {
      void this.handleSSEEvent(event);
    });
  }

  private async handleSSEEvent(event: OpenCodeSSEEvent): Promise<void> {
    const props = event.properties as Record<string, unknown> | undefined;
    const ocSessionId = (props?.sessionID as string | undefined) ?? (props?.sessionId as string | undefined);
    if (!ocSessionId) return;
    const sessionId = this.piSessionByOpencodeId.get(ocSessionId);
    if (!sessionId) {
      const found = await this.registry.getByOpencodeSessionId(ocSessionId);
      if (found?.opencodeSessionId) {
        this.opencodeSessionIds.set(found.id, found.opencodeSessionId);
        this.piSessionByOpencodeId.set(found.opencodeSessionId, found.id);
      }
      if (!found) return;
      await this.forwardSSEToSession(event, found.id);
      return;
    }
    await this.forwardSSEToSession(event, sessionId);
  }

  private async getOpencodeSessionId(sessionId: string): Promise<string | undefined> {
    const cached = this.opencodeSessionIds.get(sessionId);
    if (cached) return cached;

    const entry = await this.registry.get(sessionId);
    if (!entry?.opencodeSessionId) return undefined;

    this.opencodeSessionIds.set(sessionId, entry.opencodeSessionId);
    this.piSessionByOpencodeId.set(entry.opencodeSessionId, sessionId);
    return entry.opencodeSessionId;
  }

  private async forwardSSEToSession(event: OpenCodeSSEEvent, sessionId: string): Promise<void> {
    const meta = this.sessionMeta.get(sessionId);
    if (meta) {
      meta.lastEventTimestamp = Date.now();
      meta.lastActivity = Date.now();

      this.updateMetaFromSSE(event, meta);
    }

    const normalized = this.eventAdapter.adaptSSEEvent(event, sessionId);

    const callback = this.promptCallbacks.get(sessionId);
    for (const evt of normalized) {
      if (evt.type === 'permission_request' && evt.data) {
        const permId = (evt.data as Record<string, unknown>).permissionId as string;
        if (permId) {
          this.pendingPermissions.set(permId, sessionId);
        }
      }
      if (callback) {
        try { callback.onEvent(evt); } catch { /* non-fatal */ }
      }
    }

    for (const evt of normalized) {
      if (evt.type === 'agent_end') {
        this.completeSession(sessionId);
      }
    }
  }

  private updateMetaFromSSE(event: OpenCodeSSEEvent, meta: ActiveSessionMeta): void {
    const props = event.properties as Record<string, unknown> | undefined;
    if (!props) return;

    if (event.type === 'message.updated') {
      const info = props.info as Record<string, unknown> | undefined;
      if (!info) return;
      const tokens = info.tokens as { total?: number; input?: number; output?: number; reasoning?: number; cache?: { write?: number; read?: number } } | undefined;
      const messageID = info.id as string | undefined;
      if (tokens && messageID) {
        const newMsgTokens = {
          input: tokens.input ?? 0,
          output: tokens.output ?? 0,
          cacheRead: tokens.cache?.read ?? 0,
          cacheWrite: tokens.cache?.write ?? 0,
          total: tokens.total ?? 0,
          cost: (info.cost as number) ?? 0,
        };
        const prev = meta.perMessageTokens.get(messageID);
        meta.perMessageTokens.set(messageID, newMsgTokens);

        if (prev) {
          meta.tokens.input += newMsgTokens.input - prev.input;
          meta.tokens.output += newMsgTokens.output - prev.output;
          meta.tokens.cacheRead += newMsgTokens.cacheRead - prev.cacheRead;
          meta.tokens.cacheWrite += newMsgTokens.cacheWrite - prev.cacheWrite;
          meta.tokens.total += newMsgTokens.total - prev.total;
          meta.cost += newMsgTokens.cost - prev.cost;
        } else {
          meta.tokens.input += newMsgTokens.input;
          meta.tokens.output += newMsgTokens.output;
          meta.tokens.cacheRead += newMsgTokens.cacheRead;
          meta.tokens.cacheWrite += newMsgTokens.cacheWrite;
          meta.tokens.total += newMsgTokens.total;
          meta.cost += newMsgTokens.cost;
        }
        meta.contextUsed = meta.tokens.total;

        const modelID = info.modelID as string | undefined;
        if (modelID && meta.contextWindow === 0) {
          const cw = this.modelContextWindows.get(modelID);
          if (cw) meta.contextWindow = cw;
        }
      }
    }

    if (event.type === 'message.part.updated') {
      const part = props.part as Record<string, unknown> | undefined;
      if (!part) return;
      const partType = part.type as string | undefined;
      if (partType === 'step-finish') {
        const partID = part.id as string | undefined;
        const tokens = part.tokens as { total?: number; input?: number; output?: number; reasoning?: number; cache?: { write?: number; read?: number } } | undefined;
        if (tokens && partID) {
          const newStepTokens = {
            input: tokens.input ?? 0,
            output: tokens.output ?? 0,
            cacheRead: tokens.cache?.read ?? 0,
            cacheWrite: tokens.cache?.write ?? 0,
            total: tokens.total ?? 0,
            cost: (part.cost as number) ?? 0,
          };
          const prev = meta.perMessageTokens.get(partID);
          meta.perMessageTokens.set(partID, newStepTokens);

          if (prev) {
            meta.tokens.input += newStepTokens.input - prev.input;
            meta.tokens.output += newStepTokens.output - prev.output;
            meta.tokens.cacheRead += newStepTokens.cacheRead - prev.cacheRead;
            meta.tokens.cacheWrite += newStepTokens.cacheWrite - prev.cacheWrite;
            meta.tokens.total += newStepTokens.total - prev.total;
            meta.cost += newStepTokens.cost - prev.cost;
          } else {
            meta.tokens.input += newStepTokens.input;
            meta.tokens.output += newStepTokens.output;
            meta.tokens.cacheRead += newStepTokens.cacheRead;
            meta.tokens.cacheWrite += newStepTokens.cacheWrite;
            meta.tokens.total += newStepTokens.total;
            meta.cost += newStepTokens.cost;
          }
          meta.contextUsed = meta.tokens.total;
        }
      }
    }
  }

  getContextUsage(sessionId: string): { contextWindow: number; tokens: number; percent: number } | null {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta || meta.contextWindow === 0) return null;
    const percent = Math.round((meta.contextUsed / meta.contextWindow) * 100);
    return { contextWindow: meta.contextWindow, tokens: meta.contextUsed, percent: Math.min(percent, 100) };
  }

  private modelContextWindows: Map<string, number> = new Map();

  async cacheModelContextWindows(): Promise<void> {
    try {
      const models = await this.getAvailableModels();
      this.modelContextWindows.clear();
      for (const m of models) {
        if (m.contextWindow > 0) {
          this.modelContextWindows.set(m.id, m.contextWindow);
        }
      }
    } catch {
      // ignore — will retry on next getAvailableModels call
    }
  }

  isPendingPermission(permissionId: string): boolean {
    return this.pendingPermissions.has(permissionId);
  }

  getSessionForPermission(permissionId: string): string | undefined {
    return this.pendingPermissions.get(permissionId);
  }

  async resolvePermission(permissionId: string, approved: boolean): Promise<void> {
    const piSessionId = this.pendingPermissions.get(permissionId);
    if (!piSessionId) throw new Error(`Unknown permission: ${permissionId}`);
    await this.replyPermission(piSessionId, permissionId, approved);
    this.pendingPermissions.delete(permissionId);
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.sseUnsubscribe) {
      this.sseUnsubscribe();
      this.sseUnsubscribe = null;
    }
    await this.processManager.stop();
  }
}

let opencodeServiceInstance: OpenCodeService | null = null;

export function getOpenCodeService(): OpenCodeService {
  if (opencodeServiceInstance === null) {
    opencodeServiceInstance = new OpenCodeService({
      registryPath: config.sessionRegistryPath,
    });
  }
  return opencodeServiceInstance;
}

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { OpenCodeProcessManager } from './opencode-process-manager.js';
import { OpenCodeClient } from './opencode-client.js';
import { OpenCodeEventAdapter } from './opencode-event-adapter.js';
import { opencodeMessagesToReplayEvents } from './opencode-history-replay.js';
import { OpenCodeSessionSubscribers } from './opencode-session-subscribers.js';
import type { OpenCodeConfig, OpenCodeSSEEvent, OpenCodePermissionRule } from './opencode-types.js';
import {
  applyThinkingBudget,
  parseModelId,
  resolveReasoningStrategy,
  type ReasoningStrategy,
  type ThinkingLevel,
} from './opencode-config-manager.js';
import {
  buildModelSnapshot,
  diffModelSnapshots,
  readSnapshot,
  writeSnapshot,
  type SnapshotDiff,
} from './opencode-model-refresh.js';
import { getSessionRegistry } from '../session-registry.js';
import { config } from '../config.js';

// ── Goal Engine integration ────────────────────────────────────────────────
// The opencode goal-engine plugin stores per-session state in
// ~/.opencode/goal-engine/<ocSessionId>.goal.json.
// After each agent_end the service reads this file and emits widget_content /
// extension_status events so the frontend can display goal progress.

const GOAL_ENGINE_DIR = path.join(os.homedir(), '.opencode', 'goal-engine');

interface GoalState {
  objective: string;
  planItems: string[];
  planDone: boolean[];
  status: 'idle' | 'running' | 'wrapping-up' | 'paused';
  turnCount: number;
  startedAt: number;
  completedAt: number | null;
  verifyCommand: string | null;
  maxTurns: number | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  progressLabel: string | null;
  consecutiveErrors: number;
  lastErrorMessage: string | null;
  lastErrorAt: number | null;
  compactionCount: number;
  lastCompactedAt: number | null;
  lastCompactionTokens?: number | null;
  lastCompactionEntryId?: string | null;
  showWidget?: boolean;  // toggled by /goal status; defaults to true
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  running: '▶ Running',
  'wrapping-up': '⏸ Wrapping up…',
  paused: '⏸ Paused',
};

function goalStatePath(ocSessionId: string): string {
  return path.join(GOAL_ENGINE_DIR, `${ocSessionId}.goal.json`);
}

async function readGoalState(ocSessionId: string): Promise<GoalState | null> {
  try {
    const raw = await readFile(goalStatePath(ocSessionId), 'utf-8');
    return JSON.parse(raw) as GoalState;
  } catch {
    return null;
  }
}

async function writeGoalState(ocSessionId: string, gs: GoalState): Promise<void> {
  try {
    await mkdir(GOAL_ENGINE_DIR, { recursive: true });
    await writeFile(goalStatePath(ocSessionId), JSON.stringify(gs, null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}

function buildGoalWidgetLines(gs: GoalState): string[] {
  const lines: string[] = [];
  lines.push(`🎯 Goal Status`);
  lines.push(`Status: ${STATUS_LABELS[gs.status] || gs.status}`);
  lines.push(`Objective: ${gs.objective}`);
  lines.push(`Started: ${gs.startedAt ? new Date(gs.startedAt).toLocaleString() : 'n/a'}`);
  lines.push(`Agent runs: ${gs.turnCount}`);
  if (gs.maxTurns !== null) lines.push(`Max runs: ${gs.maxTurns}`);
  if (gs.progressCurrent !== null && gs.progressTotal !== null) {
    const label = gs.progressLabel ?? 'Progress';
    lines.push(`${label}: ${gs.progressCurrent}/${gs.progressTotal}`);
  }
  if (gs.compactionCount > 0) {
    lines.push(`Compactions: ${gs.compactionCount}`);
    if (gs.lastCompactedAt) lines.push(`Last compaction: ${new Date(gs.lastCompactedAt).toLocaleString()}`);
    if (gs.lastCompactionTokens !== null && gs.lastCompactionTokens !== undefined) lines.push(`Last compacted tokens: ${gs.lastCompactionTokens}`);
  }
  if (gs.consecutiveErrors > 0) lines.push(`Errors: ${gs.consecutiveErrors}`);
  if (gs.planItems.length > 0) {
    lines.push('');
    lines.push('Plan:');
    for (let i = 0; i < gs.planItems.length; i++) {
      lines.push(`  ${gs.planDone[i] ? '✓' : '☐'} ${gs.planItems[i]}`);
    }
  }
  if (gs.completedAt) lines.push(`Completed: ${new Date(gs.completedAt).toLocaleString()}`);
  return lines;
}

function goalEngineNormalizedEvents(gs: GoalState, sessionId: string): NormalizedEvent[] {
  const timestamp = Date.now();
  const events: NormalizedEvent[] = [];

  if (gs.status === 'idle' && !gs.objective) return events;

  // Status event for footer/badge display
  const statusText = gs.status !== 'idle'
    ? `🎯 ${STATUS_LABELS[gs.status] || gs.status} — Run ${gs.turnCount}`
    : undefined;
  events.push({
    type: 'extension_status',
    sessionId,
    timestamp,
    data: { status: { key: 'goal-engine', text: statusText } },
  });

  // Widget event for status display above input.
  // showWidget defaults to true; set to false when user toggles off via /goal status.
  const widgetVisible = gs.showWidget !== false;
  if (gs.status !== 'idle' && gs.objective && widgetVisible) {
    events.push({
      type: 'widget_content',
      sessionId,
      timestamp,
      data: { key: 'goal-engine-status', content: buildGoalWidgetLines(gs) },
    });
  } else {
    events.push({
      type: 'widget_cleared',
      sessionId,
      timestamp,
      data: { key: 'goal-engine-status' },
    });
  }

  return events;
}

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
  private apiObservers: Map<string, Set<(event: NormalizedEvent) => void>> = new Map();
  private opencodeSessionIds: Map<string, string> = new Map();
  private piSessionByOpencodeId: Map<string, string> = new Map();

  private lifecycle: OpenCodeLifecycleConfig;
  private sessionMeta: Map<string, ActiveSessionMeta> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private modelProviders: string;

  constructor(cfg: { registryPath: string; lifecycle?: Partial<OpenCodeLifecycleConfig>; modelProviders?: string }) {
    this.modelProviders = cfg.modelProviders ?? config.opencodeModelProviders;
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
    this.apiObservers.delete(sessionId);
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

    if (this.modelContextWindows.size === 0) {
      void this.cacheModelContextWindows();
    }

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
      return this.getOpencodeSessionId(sessionId).then(async (ocSessionId) => {
        if (!ocSessionId) return;
        // Pause any active goal before sending abort so the plugin doesn't
        // auto-continue when the session goes idle after the abort.
        try {
          const gs = await readGoalState(ocSessionId);
          if (gs && (gs.status === 'running' || gs.status === 'wrapping-up')) {
            await writeGoalState(ocSessionId, { ...gs, status: 'paused' });
          }
        } catch { /* non-fatal */ }
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

  /**
   * Return normalized goal-engine events for a session, for injection into
   * replay or initial subscription events.
   */
  async getGoalEngineEvents(sessionId: string): Promise<NormalizedEvent[]> {
    const ocSessionId = await this.getOpencodeSessionId(sessionId);
    if (!ocSessionId) return [];
    try {
      const gs = await readGoalState(ocSessionId);
      if (!gs) return [];
      return goalEngineNormalizedEvents(gs, sessionId);
    } catch {
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

  addApiObserver(sessionId: string, observer: (event: NormalizedEvent) => void): void {
    let observers = this.apiObservers.get(sessionId);
    if (!observers) {
      observers = new Set();
      this.apiObservers.set(sessionId, observers);
    }
    observers.add(observer);
  }

  removeApiObserver(sessionId: string, observer: (event: NormalizedEvent) => void): void {
    const observers = this.apiObservers.get(sessionId);
    if (!observers) return;
    observers.delete(observer);
    if (observers.size === 0) this.apiObservers.delete(sessionId);
  }

  private emitApiObserverEvent(sessionId: string, event: NormalizedEvent): void {
    const observers = this.apiObservers.get(sessionId);
    if (!observers || observers.size === 0) return;
    for (const observer of observers) {
      try { observer(event); } catch { /* non-fatal */ }
    }
  }

  /**
   * Resolve the configured OpenCode model-provider allowlist.
   *
   * OpenCode owns provider credentials (in its own auth.json / opencode.json);
   * Pi Web UI only reads the `/config/providers` catalogue, so this filter
   * decides which already-authenticated providers are surfaced in the picker.
   * "all"/"*" exposes everything OpenCode reports.
   */
  private resolveModelProviderFilter(): { all: boolean; allow: Set<string> } {
    const raw = (this.modelProviders ?? '').trim().toLowerCase();
    if (raw === 'all' || raw === '*') return { all: true, allow: new Set() };
    const allow = new Set(
      raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    return { all: false, allow };
  }

  async getAvailableModels(): Promise<Array<{
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
    maxTokens: number;
    description: string;
    reasoning: boolean;
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

    const { all: allowAll, allow } = this.resolveModelProviderFilter();

    const models = providerList.flatMap((provider) => {
      const providerId = provider.id ?? '';
      if (!providerId) return [];
      if (!allowAll && !allow.has(providerId.toLowerCase())) return [];

      const providerName = (provider as { name?: string }).name ?? providerId;

      type CatalogueModel = { id?: string; name?: string; limit?: { context?: number; output?: number }; status?: string; capabilities?: { reasoning?: boolean } };
      let modelEntries: CatalogueModel[];
      const rawModels = provider.models;
      if (Array.isArray(rawModels)) {
        modelEntries = rawModels as CatalogueModel[];
      } else if (rawModels && typeof rawModels === 'object') {
        modelEntries = Object.values(rawModels as Record<string, unknown>) as CatalogueModel[];
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
          description: providerName,
          // The `reasoning` capability lives under `capabilities` in
          // /config/providers (top-level `reasoning` is absent there).
          reasoning: model.capabilities?.reasoning === true,
        }))
        .filter((model) => model.id !== '');
    });

    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Refresh the OpenCode model catalogue and report what changed.
   *
   * A long-running `opencode serve` serves its catalogue from memory, so this:
   *   1. (optional) warms the on-disk models.dev cache via `opencode models`;
   *   2. (optional, idle-aware) recycles the backend so it reloads the catalogue
   *      and picks up newly-authenticated providers — deferred while any session
   *      is running so live work is never interrupted;
   *   3. reads the resulting model list (allowlist applied) and diffs it against
   *      the previous host-side snapshot (ids only — never any credentials).
   *
   * Intended to be driven on a schedule via the internal API. Safe to call ad hoc.
   */
  async refreshModels(opts: { warmCache?: boolean; recycle?: boolean; snapshotPath?: string } = {}): Promise<{
    available: boolean;
    cacheWarmed: boolean;
    recycled: boolean;
    recycleDeferred: boolean;
    runningSessions: number;
    providerCount: number;
    modelCount: number;
    diff: SnapshotDiff;
    snapshotPath: string;
    generatedAt: string;
  }> {
    const warmCache = opts.warmCache ?? true;
    const recycle = opts.recycle ?? true;
    const snapshotPath = opts.snapshotPath ?? config.opencodeModelSnapshotPath;

    if (!(await this.isAvailable())) {
      throw new Error('OpenCode is not available; cannot refresh models');
    }

    let cacheWarmed = false;
    if (warmCache) {
      cacheWarmed = await this.warmModelCache();
    }

    let recycled = false;
    let recycleDeferred = false;
    if (recycle) {
      const runningBefore = this.runningSessions.size;
      if (runningBefore > 0) {
        recycleDeferred = true;
        console.log(
          `[OpenCodeService] Model-refresh recycle deferred for ${runningBefore} running session(s)`,
        );
      } else {
        this.sseUnsubscribe?.();
        this.sseUnsubscribe = null;
        this.sseStarted = false;
        await this.processManager.recycle('model refresh');
        recycled = true;
      }
    }

    // Read the freshly-served catalogue (ensureServer re-spawns if recycled).
    const models = await this.getAvailableModels();
    const snapshot = buildModelSnapshot(models);
    const prev = await readSnapshot(snapshotPath);
    const diff = diffModelSnapshots(prev, snapshot);
    await writeSnapshot(snapshotPath, snapshot).catch((err) => {
      console.error('[OpenCodeService] Failed to persist model snapshot:', err);
    });

    return {
      available: true,
      cacheWarmed,
      recycled,
      recycleDeferred,
      runningSessions: this.runningSessions.size,
      providerCount: Object.keys(snapshot.providers).length,
      modelCount: models.length,
      diff,
      snapshotPath,
      generatedAt: snapshot.generatedAt,
    };
  }

  /**
   * Warm the on-disk models.dev cache by running `opencode models` in a separate
   * process. Best-effort: failures are non-fatal (the running serve already has a
   * catalogue, and it refreshes on its own timer).
   */
  private async warmModelCache(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const child = execFile('opencode', ['models'], { timeout: 90_000 }, (err) => {
        if (err) {
          console.warn('[OpenCodeService] `opencode models` cache warm failed:', err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
      child.on('error', () => resolve(false));
    });
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

  /**
   * Apply a thinking level for the current session's model.
   *
   * Writes the corresponding thinkingBudget to ~/.config/opencode/opencode.json
   * and recycles the OpenCode server so the new config takes effect.
   * The caller is responsible for ensuring no prompts are in-flight.
   */
  async setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<void> {
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`OpenCode session not found: ${sessionId}`);

    let modelString = entry.model ?? '';
    if (!modelString) {
      throw new Error('Cannot set thinking level: session has no model selected');
    }

    // Resolve the model against the live catalogue to recover both its provider
    // prefix (needed to write the right opencode.json key) and its `reasoning`
    // capability (needed to pick the reasoning strategy). getAvailableModels()
    // surfaces provider + reasoning for every model it lists.
    let providerId = parseModelId(modelString).providerId;
    let supportsReasoning = false;
    try {
      const available = await this.getAvailableModels();
      const found = available.find((m) => `${m.provider}/${m.id}` === modelString)
        ?? available.find((m) => m.id === modelString);
      if (found) {
        providerId = found.provider;
        supportsReasoning = found.reasoning;
        // Canonicalize to `<provider>/<modelId>` so applyThinkingBudget's
        // parseModelId recovers the right keys even when the model id itself
        // contains slashes (gateway ids like `kilo-auto/free` or
        // `meta-llama/llama-3.1-8b-instruct`), where a bare id would otherwise
        // be mis-split into the wrong provider/model.
        modelString = `${found.provider}/${found.id}`;
      }
    } catch {
      // Non-fatal; strategy falls back to the parsed provider id below.
    }

    const strategy: ReasoningStrategy = resolveReasoningStrategy(providerId, supportsReasoning);
    await applyThinkingBudget(modelString, level, strategy);

    await this.registry.upsert({
      ...entry,
      id: entry.id,
      sdkType: 'opencode',
      cwd: entry.cwd,
      thinkingLevel: level,
      opencodeSessionId: entry.opencodeSessionId,
    });

    // Tear down SSE subscription before recycling so it can re-attach cleanly
    if (this.sseUnsubscribe) {
      this.sseUnsubscribe();
      this.sseUnsubscribe = null;
      this.sseStarted = false;
    }

    await this.processManager.recycle(`thinking level changed to ${level}`);
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
      this.emitApiObserverEvent(sessionId, evt);
    }

    for (const evt of normalized) {
      if (evt.type === 'agent_end') {
        this.completeSession(sessionId);

        // Emit goal-engine widget/status events so the frontend reflects current goal state
        void this.emitGoalEventsAfterAgentEnd(event, sessionId, callback);
      }
    }
  }

  private async emitGoalEventsAfterAgentEnd(
    event: OpenCodeSSEEvent,
    sessionId: string,
    callback: { onEvent: (event: NormalizedEvent) => void; onComplete: (error?: Error) => void } | undefined,
  ): Promise<void> {
    const props = event.properties as Record<string, unknown> | undefined;
    const ocSessionId = (props?.sessionID as string | undefined) ?? (props?.sessionId as string | undefined);
    if (!ocSessionId) return;

    try {
      const gs = await readGoalState(ocSessionId);
      if (!gs) return;

      for (const evt of goalEngineNormalizedEvents(gs, sessionId)) {
        if (callback) {
          try { callback.onEvent(evt); } catch { /* non-fatal */ }
        }
        this.emitApiObserverEvent(sessionId, evt);
      }
    } catch {
      // Non-fatal
    }
  }

  private updateMetaFromSSE(event: OpenCodeSSEEvent, meta: ActiveSessionMeta): void {
    const props = event.properties as Record<string, unknown> | undefined;
    if (!props) return;

    if (event.type === 'message.updated') {
      const info = props.info as Record<string, unknown> | undefined;
      if (!info) return;

      const modelID = info.modelID as string | undefined;
      const providerID = info.providerID as string | undefined;
      if (modelID && meta.contextWindow === 0) {
        const cw = this.modelContextWindows.get(modelID)
          ?? (providerID ? this.modelContextWindows.get(`${providerID}/${modelID}`) : undefined);
        if (cw) meta.contextWindow = cw;
      }

      const role = info.role as string | undefined;
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

        if (role === 'assistant') {
          meta.contextUsed = newMsgTokens.input;
        }
      }
    }
  }

  getContextUsage(sessionId: string): { contextWindow: number; tokens: number; percent: number } | null {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return null;
    if (meta.contextWindow === 0) {
      void this.cacheModelContextWindows();
      return null;
    }
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
          const shortId = m.id.includes('/') ? m.id.split('/').slice(1).join('/') : m.id;
          if (shortId !== m.id) {
            this.modelContextWindows.set(shortId, m.contextWindow);
          }
        }
      }
    } catch {
      // ignore — will retry on next call
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

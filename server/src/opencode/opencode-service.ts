import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { OpenCodeProcessManager } from './opencode-process-manager.js';
import { OpenCodeClient } from './opencode-client.js';
import { OpenCodeEventAdapter } from './opencode-event-adapter.js';
import { opencodeMessagesToReplayEvents } from './opencode-history-replay.js';
import { OpenCodeSessionSubscribers } from './opencode-session-subscribers.js';
import type { OpenCodeConfig, OpenCodeSSEEvent } from './opencode-types.js';
import { getSessionRegistry } from '../session-registry.js';
import { config } from '../config.js';

export class OpenCodeService {
  private processManager: OpenCodeProcessManager;
  private client: OpenCodeClient;
  private eventAdapter: OpenCodeEventAdapter;
  private subscribers: OpenCodeSessionSubscribers;
  private registry;
  private runningSessions: Set<string> = new Set();
  private pendingPermissions: Map<string, string> = new Map(); // permissionId → piSessionId
  private sseUnsubscribe: (() => void) | null = null;
  private sseStarted: boolean = false;
  private promptCallbacks: Map<string, {
    onEvent: (event: NormalizedEvent) => void;
    onComplete: (error?: Error) => void;
  }> = new Map();
  private opencodeSessionIds: Map<string, string> = new Map();
  private piSessionByOpencodeId: Map<string, string> = new Map();

  constructor(cfg: { registryPath: string }) {
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

    const opencodeSession = await this.client.createSession(cwd);
    const sessionId = randomUUID();

    this.opencodeSessionIds.set(sessionId, opencodeSession.id);
    this.piSessionByOpencodeId.set(opencodeSession.id, sessionId);

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

  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
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
      await this.client.promptAsync(ocSessionId, entry.cwd, prompt, entry.model);
    } catch (err) {
      console.error(`[OpenCodeService] promptAsync failed:`, err instanceof Error ? err.message : String(err));
      this.completeSession(sessionId, err instanceof Error ? err : new Error(String(err)));
    }
  }

  private completeSession(sessionId: string, error?: Error): void {
    this.runningSessions.delete(sessionId);
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
    await this.client.replyPermission(ocSessionId, entry.cwd, permissionId, approved);
  }

  async listSessions() {
    return this.registry.listBySdkType('opencode');
  }

  async getSession(sessionId: string) {
    return this.registry.get(sessionId);
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
    if (!ocSessionId) {
      return;
    }
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
    const normalized = this.eventAdapter.adaptSSEEvent(event, sessionId);

    const callback = this.promptCallbacks.get(sessionId);
    for (const evt of normalized) {
      // Track pending permissions
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

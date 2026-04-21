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

    const opencodeSession = await this.client.createSession();
    const sessionId = randomUUID();

    this.opencodeSessionIds.set(sessionId, opencodeSession.id);
    this.piSessionByOpencodeId.set(opencodeSession.id, sessionId);

    await this.registry.upsert({
      id: sessionId,
      sdkType: 'opencode',
      path: sessionId,
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

    const ocSessionId = this.opencodeSessionIds.get(sessionId);
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
      await this.client.promptAsync(ocSessionId, prompt);
    } catch (err) {
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
    const ocSessionId = this.opencodeSessionIds.get(sessionId);
    if (!ocSessionId) return;

    this.client.abort(ocSessionId).catch((err) => {
      console.error('[OpenCodeService] Abort failed:', err);
    });
    this.completeSession(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId);
  }

  async getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const ocSessionId = this.opencodeSessionIds.get(sessionId);
    if (!ocSessionId) return [];

    try {
      await this.ensureServer();
      const messages = await this.client.getMessages(ocSessionId);
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
    const ocSessionId = this.opencodeSessionIds.get(sessionId);
    if (!ocSessionId) return;
    await this.client.replyPermission(ocSessionId, permissionId, approved);
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
    const props = (event.properties ?? event.data) as Record<string, unknown> | undefined;
    const ocSessionId = props?.sessionId as string | undefined;
    if (!ocSessionId) return;

    const sessionId = this.piSessionByOpencodeId.get(ocSessionId);
    if (!sessionId) {
      const all = await this.registry.listBySdkType('opencode');
      const found = all.find(e => {
        const entryOcId = this.opencodeSessionIds.get(e.id);
        return entryOcId === ocSessionId;
      });
      if (!found) return;
      await this.forwardSSEToSession(event, found.id);
      return;
    }
    await this.forwardSSEToSession(event, sessionId);
  }

  private async forwardSSEToSession(event: OpenCodeSSEEvent, sessionId: string): Promise<void> {
    const normalized = this.eventAdapter.adaptSSEEvent(event, sessionId);

    const callback = this.promptCallbacks.get(sessionId);
    for (const evt of normalized) {
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

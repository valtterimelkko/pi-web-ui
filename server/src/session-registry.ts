import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { SdkType } from '@pi-web-ui/shared';
import { createLogger } from './logging/logger.js';

const logger = createLogger('SessionRegistry');


export interface RegistryEntry {
  id: string;              // Internal UUID
  sdkType: SdkType;        // 'pi' | 'claude' | 'opencode' | 'antigravity'
  path: string;            // For Pi: session path; For Claude: our JSONL file path
  claudeSessionId?: string; // For Claude: the --session-id
  opencodeSessionId?: string; // For OpenCode: the OpenCode server session ID
  antigravityConversationId?: string; // For Antigravity: the agy --conversation UUID
  commandCodeNativeSessionId?: string; // For Command Code: native resume/session id
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  firstMessage: string;
  messageCount: number;
  createdAt: string;       // ISO string
  lastActivity: string;    // ISO string
  status: 'idle' | 'running' | 'error';
  /** Where this registry entry came from, when known. Legacy entries created
   *  before origin tracking have no value and surface as source 'unknown' in
   *  the Internal API list response.
   *  - 'browser': created through the WebSocket browser UI path.
   *  - 'internal-api': created through the Internal API (single or batch create).
   *  - 'native-discovered': discovered on disk by the Pi SessionWatcher
   *    (a pi CLI session started outside pi-web-ui). */
  origin?: 'browser' | 'internal-api' | 'native-discovered';
  /** Claude-specific: which profile was selected for this session */
  claudeProfileId?: string;
  /** Claude-specific: which backend is handling this session */
  claudeProfileBackend?: 'sdk-subscription' | 'cli-direct' | 'channel';
  /** Contract 1.34.0 child surfacing: parent session linkage when known (display-only). */
  parentSessionId?: string;
  /** Claude-specific: provider id (anthropic, zai, etc.) — never a secret */
  claudeProviderId?: string;
}

export interface SessionRegistry {
  version: number;
  updatedAt: string;
  entries: RegistryEntry[];
}

export type SessionRegistryUnavailableReason = 'unreadable' | 'invalid';

export type SessionRegistryLoadStatus =
  | { state: 'unloaded' }
  | { state: 'missing' }
  | { state: 'available'; source: 'disk' }
  | { state: 'unavailable'; reason: SessionRegistryUnavailableReason; errorCode?: string };

export type SessionRegistryReadFile = (filePath: string, encoding: BufferEncoding) => Promise<string>;

export interface SessionRegistryManagerOptions {
  /**
   * Injectable read boundary for deterministic fault tests. Writes continue to
   * use the real filesystem and retain the manager's atomic-save behaviour.
   */
  readFile?: SessionRegistryReadFile;
}

export class SessionRegistryUnavailableError extends Error {
  readonly code = 'SESSION_REGISTRY_UNAVAILABLE' as const;
  readonly reason: SessionRegistryUnavailableReason;
  readonly causeCode?: string;

  constructor(reason: SessionRegistryUnavailableReason, originalError?: unknown) {
    super(`Session registry unavailable: ${reason}`);
    this.name = 'SessionRegistryUnavailableError';
    this.reason = reason;
    const code = originalError && typeof originalError === 'object' && 'code' in originalError
      ? (originalError as { code?: unknown }).code
      : undefined;
    if (typeof code === 'string') {
      this.causeCode = code;
    }
  }
}

const REGISTRY_VERSION = 1;

export class SessionRegistryManager {
  private registryPath: string;
  private registry: SessionRegistry | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private loadPromise: Promise<SessionRegistry> | null = null;
  private loadStatus: SessionRegistryLoadStatus = { state: 'unloaded' };
  private readonly readFile: SessionRegistryReadFile;

  constructor(registryPath: string, options: SessionRegistryManagerOptions = {}) {
    this.registryPath = registryPath;
    this.readFile = options.readFile ?? ((filePath, encoding) => fs.readFile(filePath, encoding));
  }

  getLoadStatus(): SessionRegistryLoadStatus {
    return { ...this.loadStatus };
  }

  async load(): Promise<SessionRegistry> {
    if (this.registry !== null) {
      return this.registry;
    }

    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this._doLoad();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async _doLoad(): Promise<SessionRegistry> {
    if (this.registry !== null) {
      return this.registry;
    }

    try {
      const raw = await this.readFile(this.registryPath, 'utf-8');
      let parsed: SessionRegistry;
      try {
        parsed = JSON.parse(raw) as SessionRegistry;
      } catch (err: unknown) {
        throw new SessionRegistryUnavailableError('invalid', err);
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number' || !Array.isArray(parsed.entries)
        || parsed.entries.some((entry: unknown) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
        throw new SessionRegistryUnavailableError('invalid', new Error('Invalid registry format'));
      }
      this.registry = parsed;
      this.loadStatus = { state: 'available', source: 'disk' };
      return this.registry;
    } catch (err: unknown) {
      const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (isNotFound) {
        this.registry = {
          version: REGISTRY_VERSION,
          updatedAt: new Date().toISOString(),
          entries: [],
        };
        this.loadStatus = { state: 'missing' };
        return this.registry;
      }

      const unavailable = err instanceof SessionRegistryUnavailableError
        ? err
        : new SessionRegistryUnavailableError('unreadable', err);
      this.loadStatus = {
        state: 'unavailable',
        reason: unavailable.reason,
        ...(unavailable.causeCode ? { errorCode: unavailable.causeCode } : {}),
      };
      logger.warn('[SessionRegistry] Failed to load registry:', err instanceof Error ? err.message : String(err));
      // Leave registry null: callers must not mutate or observe a fabricated
      // healthy-empty registry, and a later retry can recover after repair.
      throw unavailable;
    }
  }

  async save(): Promise<void> {
    const result = this.saveQueue.then(() => this._doSave());
    this.saveQueue = result.then(undefined, () => {});
    await result;
  }

  private async _doSave(): Promise<void> {
    if (this.registry === null) {
      if (this.loadStatus.state === 'unavailable') throw new SessionRegistryUnavailableError(this.loadStatus.reason);
      return;
    }

    this.registry.updatedAt = new Date().toISOString();

    const dir = path.dirname(this.registryPath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.registryPath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(this.registry, null, 2), 'utf-8');
      await fs.rename(tmpPath, this.registryPath);
      this.loadStatus = { state: 'available', source: 'disk' };
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  async get(id: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.id === id);
  }

  async getByPath(sessionPath: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.path === sessionPath);
  }

  async getByClaudeSessionId(claudeSessionId: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.claudeSessionId === claudeSessionId);
  }

  async getByOpencodeSessionId(opencodeSessionId: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.opencodeSessionId === opencodeSessionId);
  }

  async getByCommandCodeNativeSessionId(commandCodeNativeSessionId: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.commandCodeNativeSessionId === commandCodeNativeSessionId);
  }

  async upsert(entry: Partial<RegistryEntry> & { sdkType: SdkType; cwd: string }): Promise<RegistryEntry> {
    const registry = await this.load();

    // Find existing entry by id, path, or claudeSessionId
    let existingIndex = -1;
    if (entry.id) {
      existingIndex = registry.entries.findIndex(e => e.id === entry.id);
    }
    if (existingIndex === -1 && entry.path) {
      existingIndex = registry.entries.findIndex(e => e.path === entry.path);
    }
    if (existingIndex === -1 && entry.claudeSessionId) {
      existingIndex = registry.entries.findIndex(e => e.claudeSessionId === entry.claudeSessionId);
    }
    if (existingIndex === -1 && entry.opencodeSessionId) {
      existingIndex = registry.entries.findIndex(e => e.opencodeSessionId === entry.opencodeSessionId);
    }
    if (existingIndex === -1 && entry.commandCodeNativeSessionId) {
      existingIndex = registry.entries.findIndex(e => e.commandCodeNativeSessionId === entry.commandCodeNativeSessionId);
    }

    if (entry.sdkType === 'commandcode' && entry.commandCodeNativeSessionId) {
      const duplicate = registry.entries.find((candidate) => (
        candidate.sdkType === 'commandcode'
        && candidate.commandCodeNativeSessionId === entry.commandCodeNativeSessionId
        && candidate.id !== entry.id
        && candidate.path !== entry.path
      ));
      if (duplicate) throw new Error(`Command Code native session id is already bound to ${duplicate.id}`);
    }

    const now = new Date().toISOString();

    if (existingIndex !== -1) {
      // Update existing entry
      const existing = registry.entries[existingIndex];
      const updated: RegistryEntry = {
        ...existing,
        ...entry,
        id: existing.id, // preserve original ID
        updatedAt: now,
        lastActivity: entry.lastActivity ?? now,
      } as RegistryEntry;
      registry.entries[existingIndex] = updated;
      await this.save();
      return updated;
    } else {
      // Create new entry
      const newEntry: RegistryEntry = {
        id: entry.id ?? randomUUID(),
        sdkType: entry.sdkType,
        path: entry.path ?? '',
        claudeSessionId: entry.claudeSessionId,
        opencodeSessionId: entry.opencodeSessionId,
        commandCodeNativeSessionId: entry.commandCodeNativeSessionId,
        cwd: entry.cwd,
        model: entry.model,
        thinkingLevel: entry.thinkingLevel,
        firstMessage: entry.firstMessage ?? '',
        messageCount: entry.messageCount ?? 0,
        createdAt: entry.createdAt ?? now,
        lastActivity: entry.lastActivity ?? now,
        status: entry.status ?? 'idle',
        origin: entry.origin,
        claudeProfileId: entry.claudeProfileId,
        claudeProfileBackend: entry.claudeProfileBackend,
        claudeProviderId: entry.claudeProviderId,
      };
      registry.entries.push(newEntry);
      await this.save();
      return newEntry;
    }
  }

  /**
   * Atomically patch only the model and/or thinkingLevel fields of a session.
   * Unlike upsert(), this NEVER touches the other field, eliminating race
   * conditions when setModel and setThinkingLevel run concurrently.
   */
  async patchSessionMeta(
    id: string,
    patch: { model?: string; thinkingLevel?: string; parentSessionId?: string },
  ): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    const entry = registry.entries.find(e => e.id === id);
    if (!entry) return undefined;
    if (patch.model !== undefined) entry.model = patch.model;
    if (patch.thinkingLevel !== undefined) entry.thinkingLevel = patch.thinkingLevel;
    if (patch.parentSessionId !== undefined) entry.parentSessionId = patch.parentSessionId;
    entry.lastActivity = new Date().toISOString();
    await this.save();
    return entry;
  }

  async updateStatus(id: string, status: RegistryEntry['status']): Promise<void> {
    const registry = await this.load();
    const entry = registry.entries.find(e => e.id === id);
    if (entry) {
      entry.status = status;
      entry.lastActivity = new Date().toISOString();
      await this.save();
    }
  }

  async listAll(): Promise<RegistryEntry[]> {
    const registry = await this.load();
    return [...registry.entries];
  }

  async listBySdkType(sdkType: SdkType): Promise<RegistryEntry[]> {
    const registry = await this.load();
    return registry.entries.filter(e => e.sdkType === sdkType);
  }

  async delete(id: string): Promise<void> {
    const registry = await this.load();
    const before = registry.entries.length;
    registry.entries = registry.entries.filter(e => e.id !== id);
    if (registry.entries.length !== before) {
      await this.save();
    }
  }

  async rebuildFromPiSessions(piSessionDir: string): Promise<void> {
    let sessionPaths: string[];
    try {
      const entries = await fs.readdir(piSessionDir, { withFileTypes: true });
      // Pi sessions are directories under piSessionDir
      sessionPaths = entries
        .filter(e => e.isDirectory())
        .map(e => path.join(piSessionDir, e.name));
    } catch (err) {
      logger.warn('[SessionRegistry] rebuildFromPiSessions: could not read session dir:', err instanceof Error ? err.message : String(err));
      return;
    }

    for (const sessionPath of sessionPaths) {
      const existing = await this.getByPath(sessionPath);
      if (existing) {
        continue; // Already in registry
      }

      // Try to read basic info from the session directory
      let firstMessage = '';
      let messageCount = 0;
      let createdAt = new Date().toISOString();
      let lastActivity = new Date().toISOString();

      try {
        const stat = await fs.stat(sessionPath);
        createdAt = stat.birthtime.toISOString();
        lastActivity = stat.mtime.toISOString();
      } catch { /* ignore */ }

      // Try to read the first JSONL file for firstMessage
      try {
        const files = await fs.readdir(sessionPath);
        const jsonlFile = files.find(f => f.endsWith('.jsonl'));
        if (jsonlFile) {
          const content = await fs.readFile(path.join(sessionPath, jsonlFile), 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          messageCount = lines.length;
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              if (msg.role === 'user' && msg.content) {
                const text = typeof msg.content === 'string'
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content.map((c: { text?: string }) => c.text ?? '').join('')
                    : '';
                if (text.trim()) {
                  firstMessage = text.slice(0, 200);
                  break;
                }
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }

      await this.upsert({
        sdkType: 'pi',
        path: sessionPath,
        cwd: sessionPath, // fallback; Pi sessions store cwd in session metadata
        firstMessage,
        messageCount,
        createdAt,
        lastActivity,
        status: 'idle',
      });
    }

    logger.info(`[SessionRegistry] rebuildFromPiSessions: processed ${sessionPaths.length} session(s) from ${piSessionDir}`);
  }
}

// Singleton instances keyed by registry path
const registryInstances = new Map<string, SessionRegistryManager>();

export function getSessionRegistry(registryPath?: string): SessionRegistryManager {
  if (!registryPath) {
    if (registryInstances.size === 1) {
      return Array.from(registryInstances.values())[0];
    }
    throw new Error('getSessionRegistry: registryPath required when no unique registry instance exists');
  }

  let instance = registryInstances.get(registryPath);
  if (!instance) {
    instance = new SessionRegistryManager(registryPath);
    registryInstances.set(registryPath, instance);
  }
  return instance;
}

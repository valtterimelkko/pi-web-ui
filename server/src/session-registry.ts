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
   * Injectable read/write boundaries for deterministic fault and coalescing
   * tests. Writes default to the real filesystem with atomic-save behaviour.
   */
  readFile?: SessionRegistryReadFile;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
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
  private loadPromise: Promise<SessionRegistry> | null = null;
  private loadStatus: SessionRegistryLoadStatus = { state: 'unloaded' };
  private readonly readFile: SessionRegistryReadFile;
  private readonly writeFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  private readonly rename: (from: string, to: string) => Promise<void>;
  /** Exact-key indexes; the ordered entries array remains the source of truth. */
  private readonly indexById = new Map<string, RegistryEntry>();
  private readonly indexByPath = new Map<string, RegistryEntry>();
  private readonly indexByClaudeSessionId = new Map<string, RegistryEntry>();
  private readonly indexByOpencodeSessionId = new Map<string, RegistryEntry>();
  private readonly indexByCommandCodeNativeSessionId = new Map<string, RegistryEntry>();
  private linearScans = 0;
  /** Coalesced-save state: one in-flight write plus at most one trailing follow-up. */
  private inFlightSave: Promise<void> | null = null;
  private followUpNeeded = false;

  constructor(registryPath: string, options: SessionRegistryManagerOptions = {}) {
    this.registryPath = registryPath;
    this.readFile = options.readFile ?? ((filePath, encoding) => fs.readFile(filePath, encoding));
    this.writeFile = options.writeFile ?? ((filePath, data, encoding) => fs.writeFile(filePath, data, encoding));
    this.rename = options.rename ?? ((from, to) => fs.rename(from, to));
  }

  /** Cost witness for exact lookups: counts remaining linear scans over entries. */
  get debugLinearScanCount(): number {
    return this.linearScans;
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
      this.rebuildIndexes();
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
        this.rebuildIndexes();
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
    // Coalesced saves: while a write is in flight, compatible save requests
    // join a single trailing follow-up write instead of queueing one disk
    // snapshot each. A waiter resolves only after a snapshot that was
    // serialised after its mutation has completed, and a failed write
    // rejects the waiters it was carrying (their state stays in memory for
    // a later retry).
    if (this.inFlightSave) {
      const current = this.inFlightSave;
      this.followUpNeeded = true;
      await current;
      if (this.inFlightSave && this.inFlightSave !== current) {
        // A follow-up write already started after ours landed; it covers us.
        return this.inFlightSave;
      }
      if (!this.followUpNeeded) return;
      this.followUpNeeded = false;
      return this.startSave();
    }
    return this.startSave();
  }

  private startSave(): Promise<void> {
    const attempt = this._doSave().finally(() => {
      if (this.inFlightSave === attempt) this.inFlightSave = null;
    });
    this.inFlightSave = attempt;
    return attempt;
  }

  private async _doSave(): Promise<void> {
    if (this.registry === null) {
      if (this.loadStatus.state === 'unavailable') throw new SessionRegistryUnavailableError(this.loadStatus.reason);
      return;
    }

    this.registry.updatedAt = new Date().toISOString();

    const dir = path.dirname(this.registryPath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.registryPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await this.writeFile(tmpPath, JSON.stringify(this.registry, null, 2), 'utf-8');
      await this.rename(tmpPath, this.registryPath);
      this.loadStatus = { state: 'available', source: 'disk' };
    } catch (err) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  async get(id: string): Promise<RegistryEntry | undefined> {
    await this.load();
    return this.indexById.get(id);
  }

  getSync(id: string): RegistryEntry | undefined {
    return this.indexById.get(id);
  }

  async getByPath(sessionPath: string): Promise<RegistryEntry | undefined> {
    await this.load();
    return this.indexByPath.get(sessionPath);
  }

  async getByClaudeSessionId(claudeSessionId: string): Promise<RegistryEntry | undefined> {
    await this.load();
    return this.indexByClaudeSessionId.get(claudeSessionId);
  }

  async getByOpencodeSessionId(opencodeSessionId: string): Promise<RegistryEntry | undefined> {
    await this.load();
    return this.indexByOpencodeSessionId.get(opencodeSessionId);
  }

  async getByCommandCodeNativeSessionId(commandCodeNativeSessionId: string): Promise<RegistryEntry | undefined> {
    await this.load();
    return this.indexByCommandCodeNativeSessionId.get(commandCodeNativeSessionId);
  }

  /** Rebuild all exact-key indexes from the ordered entries (first match wins). */
  private rebuildIndexes(): void {
    this.indexById.clear();
    this.indexByPath.clear();
    this.indexByClaudeSessionId.clear();
    this.indexByOpencodeSessionId.clear();
    this.indexByCommandCodeNativeSessionId.clear();
    for (const entry of this.registry?.entries ?? []) this.addEntryToIndexes(entry);
  }

  private addEntryToIndexes(entry: RegistryEntry): void {
    if (entry.id !== undefined && !this.indexById.has(entry.id)) this.indexById.set(entry.id, entry);
    if (entry.path && !this.indexByPath.has(entry.path)) this.indexByPath.set(entry.path, entry);
    if (entry.claudeSessionId && !this.indexByClaudeSessionId.has(entry.claudeSessionId)) this.indexByClaudeSessionId.set(entry.claudeSessionId, entry);
    if (entry.opencodeSessionId && !this.indexByOpencodeSessionId.has(entry.opencodeSessionId)) this.indexByOpencodeSessionId.set(entry.opencodeSessionId, entry);
    if (entry.commandCodeNativeSessionId && !this.indexByCommandCodeNativeSessionId.has(entry.commandCodeNativeSessionId)) this.indexByCommandCodeNativeSessionId.set(entry.commandCodeNativeSessionId, entry);
  }

  private removeEntryFromIndexes(entry: RegistryEntry): void {
    if (this.indexById.get(entry.id) === entry) this.indexById.delete(entry.id);
    if (entry.path && this.indexByPath.get(entry.path) === entry) this.indexByPath.delete(entry.path);
    if (entry.claudeSessionId && this.indexByClaudeSessionId.get(entry.claudeSessionId) === entry) this.indexByClaudeSessionId.delete(entry.claudeSessionId);
    if (entry.opencodeSessionId && this.indexByOpencodeSessionId.get(entry.opencodeSessionId) === entry) this.indexByOpencodeSessionId.delete(entry.opencodeSessionId);
    if (entry.commandCodeNativeSessionId && this.indexByCommandCodeNativeSessionId.get(entry.commandCodeNativeSessionId) === entry) this.indexByCommandCodeNativeSessionId.delete(entry.commandCodeNativeSessionId);
  }

  /** After deleting an entry, a later duplicate may now be first for its keys. */
  private restoreIndexesAfterDelete(removed: RegistryEntry): void {
    this.linearScans += 1;
    const entries = this.registry?.entries ?? [];
    for (const candidate of entries) {
      if (candidate.id === removed.id || candidate.path === removed.path
        || candidate.claudeSessionId === removed.claudeSessionId
        || candidate.opencodeSessionId === removed.opencodeSessionId
        || candidate.commandCodeNativeSessionId === removed.commandCodeNativeSessionId) {
        this.addEntryToIndexes(candidate);
      }
    }
  }

  async upsert(entry: Partial<RegistryEntry> & { sdkType: SdkType; cwd: string }): Promise<RegistryEntry> {
    const registry = await this.load();

    // Resolve an existing entry by the same precedence as before (id, path,
    // claudeSessionId, opencodeSessionId, commandCodeNativeSessionId), now via
    // exact-key indexes instead of a linear scan per key.
    let existing: RegistryEntry | undefined;
    if (entry.id) existing = this.indexById.get(entry.id);
    if (!existing && entry.path) existing = this.indexByPath.get(entry.path);
    if (!existing && entry.claudeSessionId) existing = this.indexByClaudeSessionId.get(entry.claudeSessionId);
    if (!existing && entry.opencodeSessionId) existing = this.indexByOpencodeSessionId.get(entry.opencodeSessionId);
    if (!existing && entry.commandCodeNativeSessionId) existing = this.indexByCommandCodeNativeSessionId.get(entry.commandCodeNativeSessionId);

    if (entry.sdkType === 'commandcode' && entry.commandCodeNativeSessionId) {
      const duplicate = this.indexByCommandCodeNativeSessionId.get(entry.commandCodeNativeSessionId);
      if (duplicate && duplicate.sdkType === 'commandcode'
        && duplicate.id !== entry.id
        && duplicate.path !== entry.path) {
        throw new Error(`Command Code native session id is already bound to ${duplicate.id}`);
      }
    }

    const now = new Date().toISOString();

    if (existing) {
      const updated: RegistryEntry = {
        ...existing,
        ...entry,
        id: existing.id, // preserve original ID
        updatedAt: now,
        lastActivity: entry.lastActivity ?? now,
      } as RegistryEntry;
      this.removeEntryFromIndexes(existing);
      const existingIndex = registry.entries.indexOf(existing);
      registry.entries[existingIndex] = updated;
      this.addEntryToIndexes(updated);
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
        // Previously dropped on create (only carried on merge) — required by
        // contract 1.40.0 adopt-native so an adopted agy child keeps its
        // conversation id and parent linkage from the first write.
        antigravityConversationId: entry.antigravityConversationId,
        parentSessionId: entry.parentSessionId,
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
      this.addEntryToIndexes(newEntry);
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
    await this.load();
    const entry = this.indexById.get(id);
    if (!entry) return undefined;
    if (patch.model !== undefined) entry.model = patch.model;
    if (patch.thinkingLevel !== undefined) entry.thinkingLevel = patch.thinkingLevel;
    if (patch.parentSessionId !== undefined) entry.parentSessionId = patch.parentSessionId;
    entry.lastActivity = new Date().toISOString();
    await this.save();
    return entry;
  }

  async updateStatus(id: string, status: RegistryEntry['status']): Promise<void> {
    await this.load();
    const entry = this.indexById.get(id);
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
    const entry = this.indexById.get(id);
    if (!entry) return;
    registry.entries = registry.entries.filter(e => e.id !== id);
    this.linearScans += 1;
    this.removeEntryFromIndexes(entry);
    this.restoreIndexesAfterDelete(entry);
    await this.save();
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

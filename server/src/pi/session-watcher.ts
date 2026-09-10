import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import { closeSync, openSync, readSync } from 'node:fs';
import { EventEmitter } from 'events';
import { createLogger } from '../logging/logger.js';
import type { SessionRegistryManager } from '../session-registry.js';
import { archiveStaleDiscoveredSession } from '../session-cleanup.js';
import { config } from '../config.js';

const logger = createLogger('SessionWatcher');


export interface SessionChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  sessionId?: string;
  cwd?: string;
}

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  firstMessage: string;
  messageCount: number;
  name?: string;
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionWatcherOptions {
  /** Test seam for the expensive complete-file metadata read. */
  readSessionInfo?: (filePath: string) => Promise<SessionInfo>;
  /** Optional debounce override for deterministic callers; production remains 500 ms. */
  debounceDelay?: number;
}

interface SessionReadState {
  cached: SessionInfo | null;
  revalidateQueued: boolean;
  inFlight: Promise<SessionInfo | null> | null;
}

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private sessionsDir: string;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sessionIdsByPath = new Map<string, string>();
  private readStateByPath = new Map<string, SessionReadState>();
  /** Compatibility projection for existing lifecycle tests; readStateByPath owns the state. */
  private pendingInfoByPath = new Map<string, Promise<SessionInfo | null>>();
  private debounceDelay = 500; // ms
  /** Number of complete-file metadata reads started by watcher activity. */
  public debugFullReadCount = 0;
  /** Number of bounded 16 KiB header capture attempts. */
  public debugBoundedHeaderReadCount = 0;
  /** Short alias retained for test/debug callers. */
  public get debugHeaderReadCount(): number {
    return this.debugBoundedHeaderReadCount;
  }
  /** True once stop() has run; handleChange becomes a no-op so a stopped watcher never broadcasts. */
  private stopped = false;

  constructor(
    sessionsDir?: string,
    private readonly registry?: Pick<SessionRegistryManager, 'upsert'> & {
      // Optional so older consumers passing only `upsert` keep working; when
      // present it gates origin tagging to genuinely-new sessions.
      getByPath?: SessionRegistryManager['getByPath'];
    },
    options?: SessionWatcherOptions,
  ) {
    super();
    this.sessionsDir = sessionsDir || path.join(process.env.HOME || '/root', '.pi/agent/sessions');
    if (options?.debounceDelay !== undefined) this.debounceDelay = options.debounceDelay;
    if (options?.readSessionInfo) this.readSessionInfo = options.readSessionInfo;
  }

  /**
   * Start watching for session file changes
   */
  start(): void {
    if (this.watcher) {
      logger.warn('SessionWatcher already started');
      return;
    }
    this.stopped = false;

    const pattern = path.join(this.sessionsDir, '**/*.jsonl');
    
    this.watcher = chokidar.watch(pattern, {
      // Incremental-only indexing: existing files are resolved lazily by
      // debug:where and ordinary session listing, not replayed into the
      // registry as a boot-time rescan.
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
      persistent: true,
    });

    this.watcher
      .on('add', (filePath) => this.handleChange('add', filePath))
      .on('change', (filePath) => this.handleChange('change', filePath))
      .on('unlink', (filePath) => this.handleChange('unlink', filePath))
      .on('error', (error) => {
        logger.error('SessionWatcher error:', error);
        this.emit('error', error);
      });

    logger.info(`SessionWatcher started on ${pattern}`);
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    // Clear any pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.sessionIdsByPath.clear();
    this.readStateByPath.clear();
    this.pendingInfoByPath.clear();

    // Symmetric cleanup: remove all EventEmitter listeners registered via
    // start()/on() so repeated initialisation does not multiply them.
    this.removeAllListeners();

    logger.info('SessionWatcher stopped');
  }

  /**
   * Handle file change with debouncing.
   *
   * The header capture remains synchronous and bounded so an add followed by
   * unlink can retain the canonical identity. Complete-file parsing is owned by
   * the per-path read state below and is never started once per notification.
   */
  private handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void {
    // No-op once stopped so a dying watcher cannot broadcast post-shutdown.
    if (this.stopped) return;

    // Clear existing timer for this file
    const hadDebounceTimer = this.debounceTimers.has(filePath);
    const existingTimer = this.debounceTimers.get(filePath);
    if (hadDebounceTimer && existingTimer !== undefined) {
      clearTimeout(existingTimer);
    }

    // For 'unlink', emit immediately. Retire the state before awaiting an
    // in-flight read so a replacement file at the same path gets fresh state.
    if (type === 'unlink') {
      const state = this.readStateByPath.get(filePath);
      const fallbackSessionId = state?.cached?.id ?? this.sessionIdsByPath.get(filePath) ?? this.extractSessionId(filePath);
      this.readStateByPath.delete(filePath);
      this.sessionIdsByPath.delete(filePath);
      void this.emitChange(type, filePath, state, fallbackSessionId);
      return;
    }

    // Capture the header ID synchronously while chokidar still guarantees the
    // path exists; this closes the add→unlink debounce race.
    this.debugBoundedHeaderReadCount += 1;
    try {
      const fd = openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(16 * 1024);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n', 1)[0];
        const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
        if (header.type === 'session' && typeof header.id === 'string' && header.id.trim()) {
          this.sessionIdsByPath.set(filePath, header.id);
        }
      } finally {
        closeSync(fd);
      }
    } catch { /* the async read below will report malformed/missing files */ }

    const state = this.readStateByPath.get(filePath) ?? {
      cached: null,
      revalidateQueued: false,
      inFlight: null,
    };
    this.readStateByPath.set(filePath, state);
    state.revalidateQueued = true;
    // A completed read can cover all notifications in the current debounce
    // window; defer that invalidation to the debounced emit. If a read is
    // already active, ensureRead() simply returns the covering promise.
    if (!hadDebounceTimer || state.inFlight) void this.ensureRead(filePath, state);

    // Debounce add/change events
    const timer = setTimeout(() => {
      if (this.debounceTimers.get(filePath) !== timer || this.stopped) return;
      this.debounceTimers.delete(filePath);
      void this.emitChange(type, filePath, state);
    }, this.debounceDelay);

    this.debounceTimers.set(filePath, timer);
  }

  /** Get or create the sole per-path owner of cached/read metadata. */
  private getOrCreateReadState(filePath: string): SessionReadState {
    const existing = this.readStateByPath.get(filePath);
    if (existing) return existing;
    const state: SessionReadState = { cached: null, revalidateQueued: false, inFlight: null };
    this.readStateByPath.set(filePath, state);
    return state;
  }

  /** Start at most one complete-file read for a path, or return its covering read/cache. */
  private ensureRead(filePath: string, state = this.getOrCreateReadState(filePath)): Promise<SessionInfo | null> {
    if (state.inFlight) return state.inFlight;
    if (!state.revalidateQueued) return Promise.resolve(state.cached);

    state.revalidateQueued = false;
    this.debugFullReadCount += 1;
    let readResult: Promise<SessionInfo>;
    try {
      // Invoke the injectable reader now (rather than in a deferred microtask)
      // so the in-flight state covers the notification that started the read.
      readResult = this.readSessionInfo(filePath);
    } catch (error) {
      readResult = Promise.reject(error);
    }
    const read = readResult
      .then((info) => {
        this.finishRead(filePath, state, info);
        return info;
      })
      .catch(() => {
        this.finishRead(filePath, state, null);
        return null;
      });
    state.inFlight = read;
    // Keep this compatibility map as a projection only; all decisions use the
    // state object, so a trailing read cannot overwrite a newer path state.
    this.pendingInfoByPath.set(filePath, read);
    void read.then(() => {
      if (this.pendingInfoByPath.get(filePath) === read) this.pendingInfoByPath.delete(filePath);
    });
    return read;
  }

  private finishRead(filePath: string, state: SessionReadState, info: SessionInfo | null): void {
    state.inFlight = null;
    if (this.stopped || this.readStateByPath.get(filePath) !== state) return;

    state.cached = info;
    if (info) this.sessionIdsByPath.set(filePath, info.id);
    // A notification that arrived while this read was active invalidated the
    // result. One boolean gives exactly one trailing read without a promise
    // backlog; further changes can set it again while that read is active.
    if (state.revalidateQueued) void this.ensureRead(filePath, state);
  }

  /** Wait for the cached result after any one trailing invalidation read settles. */
  private async waitForSettledRead(filePath: string, state: SessionReadState): Promise<SessionInfo | null> {
    let info = await this.ensureRead(filePath, state);
    while (!this.stopped && this.readStateByPath.get(filePath) === state && (state.inFlight || state.revalidateQueued)) {
      info = await this.ensureRead(filePath, state);
    }
    return info;
  }

  /**
   * Emit the change event with parsed session info
   */
  private async emitChange(
    type: 'add' | 'change' | 'unlink',
    filePath: string,
    stateArg?: SessionReadState,
    fallbackSessionId?: string,
  ): Promise<void> {
    const state = stateArg ?? this.readStateByPath.get(filePath);
    const sessionId = fallbackSessionId ?? state?.cached?.id ?? this.sessionIdsByPath.get(filePath) ?? this.extractSessionId(filePath);
    const cwd = this.extractCwd(filePath);

    if (type === 'unlink') {
      const info = state?.inFlight ? await state.inFlight : state?.cached;
      if (this.stopped) return;
      this.emit('session_update', {
        type,
        path: filePath,
        sessionId: info?.id ?? sessionId,
        cwd,
      } satisfies SessionChangeEvent);
      return;
    }

    // A retired state belongs to an unlinked/replaced file and must not emit
    // stale metadata after a new state has taken over the same path.
    if (state && (this.stopped || this.readStateByPath.get(filePath) !== state)) return;

    const event: SessionChangeEvent = {
      type,
      path: filePath,
      sessionId,
      cwd,
    };

    try {
      const info = state
        ? await this.waitForSettledRead(filePath, state)
        : await this.readSessionInfo(filePath);
      if (state && (this.stopped || this.readStateByPath.get(filePath) !== state)) return;
      if (!info) {
        logger.warn(`Failed to read session info for ${filePath}`);
        this.emit('session_update', event);
        return;
      }

      event.sessionId = info.id;
      event.cwd = info.cwd;
      this.sessionIdsByPath.set(filePath, info.id);
      if (this.registry) {
        try {
          // Contract 1.30.0 origin provenance: a file the registry has never
          // seen is a pi CLI session started outside pi-web-ui; mark it
          // 'native-discovered'. Already-registered sessions (browser or
          // Internal API created) keep their existing origin — the upsert
          // merge never sees an origin key for them.
          let origin: 'native-discovered' | undefined;
          if (type === 'add' && this.registry.getByPath) {
            const existing = await this.registry.getByPath(filePath).catch(() => undefined);
            if (!existing) origin = 'native-discovered';
          }
          await this.registry.upsert({
            id: info.id,
            sdkType: 'pi',
            path: info.path,
            cwd: info.cwd,
            firstMessage: info.firstMessage,
            messageCount: info.messageCount,
            createdAt: info.createdAt.toISOString(),
            lastActivity: info.lastActivity.toISOString(),
            status: 'idle',
            ...(origin ? { origin } : {}),
          });
          // Discovery hygiene (plan Phase 3): a session discovered on disk
          // that is ALREADY older than the discovery threshold is archived
          // upon discovery so historical CLI sessions never flood the active
          // list. Cheap freshness pre-check avoids the prefs lock for normal
          // fresh adds; the helper re-checks authoritatively (pins win).
          if (origin && Date.now() - info.lastActivity.getTime() > config.sessionDiscoveryArchiveDays * 24 * 60 * 60 * 1000) {
            void archiveStaleDiscoveredSession({
              sessionPath: info.path,
              lastActivityMs: info.lastActivity.getTime(),
            }).catch(() => { /* best-effort hygiene */ });
          }
        } catch (error) {
          logger.warn(`Failed to index observed Pi session ${filePath}:`, error);
        }
      }

      // Emit full session info
      this.emit('session_update', { ...event, info });
    } catch (error) {
      logger.warn(`Failed to read session info for ${filePath}:`, error);
      this.emit('session_update', event);
    }
  }

  /**
   * Extract session ID from file path
   * Path format: ~/.pi/agent/sessions/--path--/timestamp_uuid.jsonl
   */
  private extractSessionId(filePath: string): string {
    const basename = path.basename(filePath, '.jsonl');
    return basename;
  }

  /**
   * Extract CWD from file path
   */
  private extractCwd(filePath: string): string {
    // Path contains --path-- which encodes the working directory
    const parts = filePath.split(path.sep);
    const pathIndex = parts.indexOf('--path--');
    
    if (pathIndex >= 0 && pathIndex + 1 < parts.length) {
      // Everything after --path-- until the filename is the encoded cwd
      const cwdParts = parts.slice(pathIndex + 1, -1);
      return cwdParts.join(path.sep);
    }
    
    return '/';
  }

  /**
   * Read session file and extract metadata
   */
  async readSessionInfo(filePath: string): Promise<SessionInfo> {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    
    if (lines.length === 0) {
      throw new Error('Empty session file');
    }

    // Parse entries to extract metadata
    let firstMessage = '';
    let messageCount = 0;
    let createdAt: Date | null = null;
    let lastActivity: Date | null = null;
    let canonicalId = this.extractSessionId(filePath);
    let canonicalCwd = this.extractCwd(filePath);

    // Helper to check if content is an injected skill body. Defect 11 (Part 3):
    // matching the bare substring 'SKILL.md' skipped genuine user prompts that
    // merely reference a skill path — every Agent OS dispatch envelope embeds
    // the skill body verbatim with its canonical path (pivot 6.2), so the
    // registry's firstMessage drifted to a later correction turn. Only the
    // canonical injection markers count (same markers the event-forwarder and
    // multi-session-manager use for skill extraction).
    const isSkillContent = (text: string): boolean => {
      return text.includes('<skill name="') ||
             text.includes('</skill>');
    };

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        if (entry.type === 'session') {
          if (typeof entry.id === 'string' && entry.id.trim()) canonicalId = entry.id;
          if (typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd)) canonicalCwd = path.normalize(entry.cwd);
        }

        // Count messages
        if (entry.type === 'message') {
          messageCount++;
          
          // Extract first non-skill user message (skip /skill:name command content)
          if (!firstMessage && entry.message?.role === 'user') {
            const content = entry.message.content;
            let extractedText = '';
            
            if (typeof content === 'string') {
              extractedText = content.slice(0, 200);
            } else if (Array.isArray(content)) {
              const textPart = content.find((p: { type?: string }) => p.type === 'text');
              if (textPart?.text) {
                extractedText = textPart.text.slice(0, 200);
              }
            }
            
            // Only use this message if it's not skill content
            // Skill content messages are injected by /skill:name commands
            if (extractedText && !isSkillContent(extractedText)) {
              firstMessage = extractedText.slice(0, 100);
            }
            // If it IS skill content, continue looking for the next user message
          }
        }

        // Track timestamps
        if (entry.timestamp) {
          const ts = new Date(entry.timestamp);
          if (!createdAt || ts < createdAt) {
            createdAt = ts;
          }
          if (!lastActivity || ts > lastActivity) {
            lastActivity = ts;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Load custom name from metadata
    const metadata = await this.getSessionMetadata(filePath);

    return {
      id: canonicalId,
      path: filePath,
      cwd: canonicalCwd,
      firstMessage: firstMessage || 'New session',
      messageCount,
      name: metadata.name,
      createdAt: createdAt || new Date(),
      lastActivity: lastActivity || new Date(),
    };
  }

  /**
   * List all existing sessions
   */
  async listSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    
    try {
      const entries = await fs.readdir(this.sessionsDir, { recursive: true, withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const filePath = path.join(entry.path || this.sessionsDir, entry.name);
          try {
            const info = await this.readSessionInfo(filePath);
            sessions.push(info);
          } catch (error) {
            logger.warn(`Failed to read session ${filePath}:`, error);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to list sessions:', error);
    }

    return sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  }

  /**
   * Set a custom name for a session by storing metadata alongside the session file
   */
  async setSessionName(sessionPath: string, name: string): Promise<void> {
    const fs = await import('fs/promises');
    const metadataPath = this.getMetadataPath(sessionPath);

    try {
      // Read existing metadata or create new
      let metadata: { name?: string; updatedAt: string } = { updatedAt: new Date().toISOString() };
      try {
        const existing = await fs.readFile(metadataPath, 'utf-8');
        metadata = JSON.parse(existing);
      } catch {
        // File doesn't exist or is invalid, use defaults
      }

      // Update name
      metadata.name = name;
      metadata.updatedAt = new Date().toISOString();

      // Write back
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (error) {
      logger.error(`Failed to set session name for ${sessionPath}:`, error);
      throw error;
    }
  }

  /**
   * Get session metadata (including custom name)
   */
  async getSessionMetadata(sessionPath: string): Promise<{ name?: string }> {
    const fs = await import('fs/promises');
    const metadataPath = this.getMetadataPath(sessionPath);

    try {
      const content = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(content);
      return { name: metadata.name };
    } catch {
      return {};
    }
  }

  /**
   * Get the metadata file path for a session
   */
  private getMetadataPath(sessionPath: string): string {
    // Store metadata as a .meta.json file alongside the session
    return sessionPath.replace('.jsonl', '.meta.json');
  }
}

// Singleton instance
let sessionWatcher: SessionWatcher | null = null;

export function getSessionWatcher(
  sessionsDir?: string,
  registry?: Pick<SessionRegistryManager, 'upsert'>,
): SessionWatcher {
  if (!sessionWatcher) {
    sessionWatcher = new SessionWatcher(sessionsDir, registry);
  }
  return sessionWatcher;
}

export function startSessionWatcher(
  sessionsDir?: string,
  registry?: Pick<SessionRegistryManager, 'upsert'>,
): SessionWatcher {
  const watcher = getSessionWatcher(sessionsDir, registry);
  watcher.start();
  return watcher;
}

export function stopSessionWatcher(): Promise<void> {
  if (sessionWatcher) {
    const w = sessionWatcher;
    // Null the singleton so a subsequent startSessionWatcher() builds a fresh
    // instance instead of reusing a stopped one (which would carry stale
    // listeners and multiply them across re-initialisation).
    sessionWatcher = null;
    return w.stop();
  }
  return Promise.resolve();
}

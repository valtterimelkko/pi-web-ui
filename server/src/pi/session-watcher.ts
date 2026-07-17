import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import { closeSync, openSync, readSync } from 'node:fs';
import { EventEmitter } from 'events';
import { createLogger } from '../logging/logger.js';

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

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private sessionsDir: string;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private sessionIdsByPath = new Map<string, string>();
  private pendingInfoByPath = new Map<string, Promise<SessionInfo | null>>();
  private debounceDelay = 500; // ms
  /** True once stop() has run; handleChange becomes a no-op so a stopped watcher never broadcasts. */
  private stopped = false;

  constructor(sessionsDir?: string) {
    super();
    this.sessionsDir = sessionsDir || path.join(process.env.HOME || '/root', '.pi/agent/sessions');
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
      ignoreInitial: false, // Emit 'add' for existing files
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
    this.pendingInfoByPath.clear();

    // Symmetric cleanup: remove all EventEmitter listeners registered via
    // start()/on() so repeated initialisation does not multiply them.
    this.removeAllListeners();

    logger.info('SessionWatcher stopped');
  }

  /**
   * Handle file change with debouncing
   */
  private handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void {
    // No-op once stopped so a dying watcher cannot broadcast post-shutdown.
    if (this.stopped) return;

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // For 'unlink', emit immediately
    if (type === 'unlink') {
      this.emitChange(type, filePath);
      return;
    }

    // Capture the header ID synchronously while chokidar still guarantees the
    // path exists; this closes the add→unlink debounce race.
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

    // Begin reading canonical header metadata immediately. If an unlink follows
    // before the debounce fires, the unlink handler can still await this read.
    const pendingInfo = this.readSessionInfo(filePath)
      .then((info) => {
        this.sessionIdsByPath.set(filePath, info.id);
        return info;
      })
      .catch(() => null);
    this.pendingInfoByPath.set(filePath, pendingInfo);

    // Debounce add/change events
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.emitChange(type, filePath);
    }, this.debounceDelay);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Emit the change event with parsed session info
   */
  private async emitChange(type: 'add' | 'change' | 'unlink', filePath: string): Promise<void> {
    const pendingInfo = await this.pendingInfoByPath.get(filePath);
    this.pendingInfoByPath.delete(filePath);
    const sessionId = pendingInfo?.id ?? this.sessionIdsByPath.get(filePath) ?? this.extractSessionId(filePath);
    const cwd = this.extractCwd(filePath);

    const event: SessionChangeEvent = {
      type,
      path: filePath,
      sessionId,
      cwd,
    };

    // For add/change, try to read session info
    if (type !== 'unlink') {
      try {
        const info = pendingInfo ?? await this.readSessionInfo(filePath);
        event.sessionId = info.id;
        event.cwd = info.cwd;
        this.sessionIdsByPath.set(filePath, info.id);
        
        // Emit full session info
        this.emit('session_update', { ...event, info });
      } catch (error) {
        logger.warn(`Failed to read session info for ${filePath}:`, error);
        this.emit('session_update', event);
      }
    } else {
      this.sessionIdsByPath.delete(filePath);
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

    // Helper to check if content contains skill content
    const isSkillContent = (text: string): boolean => {
      return text.includes('<skill name="') ||
             text.includes('</skill>') ||
             text.includes('SKILL.md');
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

export function getSessionWatcher(sessionsDir?: string): SessionWatcher {
  if (!sessionWatcher) {
    sessionWatcher = new SessionWatcher(sessionsDir);
  }
  return sessionWatcher;
}

export function startSessionWatcher(sessionsDir?: string): SessionWatcher {
  const watcher = getSessionWatcher(sessionsDir);
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

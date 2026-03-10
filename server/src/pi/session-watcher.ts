import chokidar, { type FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import { EventEmitter } from 'events';

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
  private debounceDelay = 500; // ms

  constructor(sessionsDir?: string) {
    super();
    this.sessionsDir = sessionsDir || path.join(process.env.HOME || '/root', '.pi/agent/sessions');
  }

  /**
   * Start watching for session file changes
   */
  start(): void {
    if (this.watcher) {
      console.warn('SessionWatcher already started');
      return;
    }

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
        console.error('SessionWatcher error:', error);
        this.emit('error', error);
      });

    console.log(`SessionWatcher started on ${pattern}`);
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    
    // Clear any pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    
    console.log('SessionWatcher stopped');
  }

  /**
   * Handle file change with debouncing
   */
  private handleChange(type: 'add' | 'change' | 'unlink', filePath: string): void {
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
    const sessionId = this.extractSessionId(filePath);
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
        const info = await this.readSessionInfo(filePath);
        event.sessionId = info.id;
        event.cwd = info.cwd;
        
        // Emit full session info
        this.emit('session_update', { ...event, info });
      } catch (error) {
        console.warn(`Failed to read session info for ${filePath}:`, error);
        this.emit('session_update', event);
      }
    } else {
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

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        
        // Count messages
        if (entry.type === 'message') {
          messageCount++;
          
          // Extract first user message
          if (!firstMessage && entry.message?.role === 'user') {
            const content = entry.message.content;
            if (typeof content === 'string') {
              firstMessage = content.slice(0, 100);
            } else if (Array.isArray(content)) {
              const textPart = content.find((p: { type?: string }) => p.type === 'text');
              if (textPart?.text) {
                firstMessage = textPart.text.slice(0, 100);
              }
            }
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
      id: this.extractSessionId(filePath),
      path: filePath,
      cwd: this.extractCwd(filePath),
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
            console.warn(`Failed to read session ${filePath}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to list sessions:', error);
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
      console.error(`Failed to set session name for ${sessionPath}:`, error);
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

export function getSessionWatcher(): SessionWatcher {
  if (!sessionWatcher) {
    sessionWatcher = new SessionWatcher();
  }
  return sessionWatcher;
}

export function startSessionWatcher(): SessionWatcher {
  const watcher = getSessionWatcher();
  watcher.start();
  return watcher;
}

export function stopSessionWatcher(): Promise<void> {
  if (sessionWatcher) {
    return sessionWatcher.stop();
  }
  return Promise.resolve();
}

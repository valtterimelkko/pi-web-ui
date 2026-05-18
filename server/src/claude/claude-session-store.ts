/**
 * Claude Session Store
 * Persists Claude session message history as JSONL files under
 * `~/.pi-web-ui/claude-sessions/<session-id>.jsonl`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface ClaudeMessageEntry {
  type: 'meta' | 'user' | 'assistant' | 'tool' | 'tool_result' | 'error';
  sessionId: string;
  claudeSessionId?: string;
  cwd?: string;
  model?: string;
  createdAt?: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
  usage?: unknown;
  code?: string;
  reauthRequired?: boolean;
  timestamp: number;
}

export class ClaudeSessionStore {
  private storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new session JSONL file with an initial `meta` entry.
   */
  async initSession(
    sessionId: string,
    claudeSessionId: string,
    cwd: string,
    model: string,
  ): Promise<void> {
    await this.ensureStoreDir();

    const metaEntry: ClaudeMessageEntry = {
      type: 'meta',
      sessionId,
      claudeSessionId,
      cwd,
      model,
      createdAt: new Date().toISOString(),
      timestamp: Date.now(),
    };

    const filePath = this.getFilePath(sessionId);
    await fs.writeFile(filePath, JSON.stringify(metaEntry) + '\n', 'utf-8');
  }

  /**
   * Append a single entry to the session JSONL file.
   */
  async appendEntry(
    sessionId: string,
    entry: Omit<ClaudeMessageEntry, 'sessionId'>,
  ): Promise<void> {
    await this.ensureStoreDir();

    const fullEntry: ClaudeMessageEntry = {
      ...entry,
      sessionId,
    };

    const filePath = this.getFilePath(sessionId);
    await fs.appendFile(filePath, JSON.stringify(fullEntry) + '\n', 'utf-8');
  }

  /**
   * Load all entries for a session. Returns empty array if file doesn't exist.
   */
  async loadHistory(sessionId: string): Promise<ClaudeMessageEntry[]> {
    const filePath = this.getFilePath(sessionId);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }

    const entries: ClaudeMessageEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as ClaudeMessageEntry);
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }

  /**
   * Return true if a session file already exists on disk.
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      await fs.access(this.getFilePath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete the JSONL file for a session.
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.getFilePath(sessionId));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  /**
   * Return the absolute path to the JSONL file for a session.
   */
  getFilePath(sessionId: string): string {
    return path.join(this.storeDir, `${sessionId}.jsonl`);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async ensureStoreDir(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

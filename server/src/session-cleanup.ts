import fs from 'fs/promises';
import path from 'path';
import { getSessionRegistry } from './session-registry.js';
import { withPrefsLock, PREFS_FILE } from './routes/preferences.js';
import type { Preferences } from './routes/preferences.js';
import type { MultiSessionManager } from './pi/multi-session-manager.js';
import type { ClaudeService } from './claude/index.js';
import type { OpenCodeService } from './opencode/index.js';
import type { AntigravityService } from './antigravity/index.js';
import { config } from './config.js';
import { createLogger } from './logging/logger.js';

const logger = createLogger('SessionCleanup');


export const DEFAULT_PIN_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionCleanupConfig {
  pinInactivityMs: number;
  archiveRetentionMs: number;
  cleanupIntervalMs: number;
  piSessionDir: string;
  claudeSessionDir: string;
  antigravitySessionDir: string;
}

export interface SessionCleanupResult {
  unpinned: string[];
  deleted: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

export class SessionCleanupService {
  private multiSessionManager?: MultiSessionManager;
  private claudeService?: ClaudeService;
  private opencodeService?: OpenCodeService;
  private antigravityService?: AntigravityService;
  private config: SessionCleanupConfig;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    cleanupConfig?: Partial<SessionCleanupConfig>,
  ) {
    this.config = {
      pinInactivityMs: cleanupConfig?.pinInactivityMs ?? DEFAULT_PIN_INACTIVITY_MS,
      archiveRetentionMs: cleanupConfig?.archiveRetentionMs ?? DEFAULT_ARCHIVE_RETENTION_MS,
      cleanupIntervalMs: cleanupConfig?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
      piSessionDir: cleanupConfig?.piSessionDir ?? path.join(config.piAgentDir, 'sessions'),
      claudeSessionDir: cleanupConfig?.claudeSessionDir ?? config.claudeSessionDir,
      antigravitySessionDir: cleanupConfig?.antigravitySessionDir ?? config.antigravitySessionDir,
    };
  }

  bindRuntimes(opts: {
    multiSessionManager: MultiSessionManager;
    claudeService: ClaudeService;
    opencodeService: OpenCodeService;
    antigravityService?: AntigravityService;
  }): void {
    this.multiSessionManager = opts.multiSessionManager;
    this.claudeService = opts.claudeService;
    this.opencodeService = opts.opencodeService;
    this.antigravityService = opts.antigravityService;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCleanup();
    }, this.config.cleanupIntervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
    void this.runCleanup();
    logger.info(
      `[SessionCleanup] Started with pinInactivity=${this.config.pinInactivityMs}ms, archiveRetention=${this.config.archiveRetentionMs}ms, interval=${this.config.cleanupIntervalMs}ms`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runCleanup(prefsPath?: string): Promise<SessionCleanupResult> {
    const result: SessionCleanupResult = { unpinned: [], deleted: [], errors: [] };

    try {
      await this.autoUnpinInactivePinnedSessions(result, prefsPath);
    } catch (err) {
      logger.error('[SessionCleanup] Error during auto-unpin pass:', err instanceof Error ? err.message : String(err));
    }

    try {
      await this.autoDeleteArchivedSessions(result, prefsPath);
    } catch (err) {
      logger.error('[SessionCleanup] Error during auto-delete pass:', err instanceof Error ? err.message : String(err));
    }

    if (result.unpinned.length > 0 || result.deleted.length > 0 || result.errors.length > 0) {
      logger.info(
        `[SessionCleanup] Cleanup complete: ${result.unpinned.length} unpinned, ${result.deleted.length} deleted, ${result.errors.length} error(s)`,
      );
    }

    return result;
  }

  private async autoUnpinInactivePinnedSessions(
    result: SessionCleanupResult,
    prefsPath?: string,
  ): Promise<void> {
    const toUnpin = await withPrefsLock(async (read, write) => {
      const prefs = await read();
      const pinnedEntries = Object.entries(prefs.sessions).filter(([, rec]) => rec.pinned);
      if (pinnedEntries.length === 0) return [] as Array<{ key: string; path: string }>;

      const registry = getSessionRegistry();
      const now = Date.now();
      const expired: Array<{ key: string; path: string }> = [];

      for (const [key, rec] of pinnedEntries) {
        const sessionPath = rec.legacyKey ?? key;
        let lastActivity: number | undefined;

        const inMemory = this.getInMemoryLastActivity(sessionPath);
        if (inMemory !== undefined) {
          lastActivity = inMemory;
        }

        if (lastActivity === undefined) {
          const entry = await registry.get(sessionPath)
            ?? await registry.getByPath(sessionPath)
            ?? await registry.getByClaudeSessionId(sessionPath)
            ?? await registry.getByOpencodeSessionId(sessionPath);
          if (entry?.lastActivity) {
            lastActivity = new Date(entry.lastActivity).getTime();
          }
        }

        if (lastActivity === undefined) continue;

        if (now - lastActivity > this.config.pinInactivityMs) {
          expired.push({ key, path: sessionPath });
        }
      }

      if (expired.length === 0) return [];

      // Clear the durable pin on expired records (v2 model: delete the field).
      for (const { key } of expired) {
        const rec = prefs.sessions[key];
        if (rec) {
          delete rec.pinned;
          rec.updatedAt = now;
        }
      }
      await write(prefs);
      return expired;
    }, prefsPath ?? PREFS_FILE);

    for (const { path } of toUnpin) {
      this.unpinInRuntimes(path);
      result.unpinned.push(path);
      logger.info(`[SessionCleanup] Auto-unpinned session after inactivity: ${path}`);
    }
  }

  private getInMemoryLastActivity(sessionPath: string): number | undefined {
    if (this.multiSessionManager) {
      const active = this.multiSessionManager.getActiveSession(sessionPath);
      if (active) return active.lastActivity.getTime();
    }

    if (this.opencodeService) {
      const statuses = this.opencodeService.getSessionStatuses();
      const found = statuses.find(s => s.sessionId === sessionPath);
      if (found) return found.lastActivity.getTime();
    }

    return undefined;
  }

  private unpinInRuntimes(sessionId: string): void {
    this.multiSessionManager?.unpinSession(sessionId);
    this.claudeService?.unpinSession(sessionId);
    this.opencodeService?.unpinSession(sessionId);
    this.antigravityService?.unpinSession(sessionId);
  }

  private async autoDeleteArchivedSessions(
    result: SessionCleanupResult,
    prefsPath?: string,
  ): Promise<void> {
    const filePath = prefsPath ?? PREFS_FILE;
    const registry = getSessionRegistry();
    const now = Date.now();

    const toDelete: Array<{ key: string; path: string }> = [];

    await withPrefsLock(async (read) => {
      const prefs = await read();
      const archivedEntries = Object.entries(prefs.sessions).filter(([, rec]) => rec.archived);
      if (archivedEntries.length === 0) return;

      for (const [key, rec] of archivedEntries) {
        const sessionPath = rec.legacyKey ?? key;
        let entry = await registry.get(sessionPath)
          ?? await registry.getByPath(sessionPath)
          ?? await registry.getByClaudeSessionId(sessionPath)
          ?? await registry.getByOpencodeSessionId(sessionPath);

        // Pi sessions are archived by their individual .jsonl file path. The
        // registry may store the parent cwd directory, but each file is its own
        // session and should age by its own mtime. Treat Pi file paths (and all
        // other orphan runtime files) by their filesystem mtime so old archived
        // files inside still-active directories are still cleaned up.
        if (!entry || (entry.sdkType === 'pi' && this.isPiFilePath(sessionPath))) {
          const fileMtime = await this.getRuntimeFileMtime(sessionPath);
          if (fileMtime === undefined) {
            // File is already gone — clean up the stale archived entry.
            toDelete.push({ key, path: sessionPath });
          } else if (now - fileMtime > this.config.archiveRetentionMs) {
            toDelete.push({ key, path: sessionPath });
          }
          continue;
        }

        const lastActivity = entry.lastActivity ? new Date(entry.lastActivity).getTime() : 0;
        if (now - lastActivity > this.config.archiveRetentionMs) {
          toDelete.push({ key, path: sessionPath });
        }
      }
    }, filePath);

    if (toDelete.length === 0) return;

    for (const { key, path } of toDelete) {
      try {
        const entry = await registry.get(path)
          ?? await registry.getByPath(path)
          ?? await registry.getByClaudeSessionId(path)
          ?? await registry.getByOpencodeSessionId(path);

        if (entry) {
          await this.deleteSessionFiles(entry);
          await registry.delete(entry.id);
        }

        // Always delete the runtime file at the archived path as well. This
        // handles Pi .jsonl file paths (where the registry entry may be the
        // parent directory) and orphan files that no longer have a registry
        // entry (e.g. Internal-API ephemeral deletes).
        await this.deleteRuntimeFileByPath(path);

        this.unpinInRuntimes(path);
        result.deleted.push(path);
        logger.info(`[SessionCleanup] Deleted archived session: ${path}`);
      } catch (err) {
        result.errors.push({
          sessionId: path,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.error(`[SessionCleanup] Failed to delete session ${path}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Clear the durable archived/pinned fields on successfully-deleted records
    // (v2 model: delete fields on the record rather than filter arrays).
    const deletedKeys = new Set(
      toDelete.filter(({ path }) => !result.errors.some(e => e.sessionId === path)).map(({ key }) => key),
    );
    if (deletedKeys.size > 0) {
      await withPrefsLock(async (read, write) => {
        const prefs = await read();
        for (const key of deletedKeys) {
          const rec = prefs.sessions[key];
          if (!rec) continue;
          delete rec.archived;
          delete rec.pinned;
          rec.updatedAt = now;
        }
        await write(prefs);
      }, filePath);
    }
  }

  private isPiFilePath(sessionPath: string): boolean {
    return sessionPath.startsWith(this.config.piSessionDir) && sessionPath.endsWith('.jsonl');
  }

  private isClaudeFilePath(sessionPath: string): boolean {
    const dir = path.dirname(sessionPath);
    return dir === this.config.claudeSessionDir && sessionPath.endsWith('.jsonl');
  }

  private isAntigravityFilePath(sessionPath: string): boolean {
    const dir = path.dirname(sessionPath);
    return dir === this.config.antigravitySessionDir && sessionPath.endsWith('.jsonl');
  }

  private async getRuntimeFileMtime(sessionPath: string): Promise<number | undefined> {
    try {
      if (this.isPiFilePath(sessionPath) || this.isClaudeFilePath(sessionPath) || this.isAntigravityFilePath(sessionPath)) {
        const stat = await fs.stat(sessionPath);
        return stat.mtime.getTime();
      }
      // Bare ID: check known runtime locations.
      if (!sessionPath.includes('/')) {
        const claudeFile = path.join(this.config.claudeSessionDir, `${sessionPath}.jsonl`);
        try { return (await fs.stat(claudeFile)).mtime.getTime(); } catch { /* ignore */ }
        const agFile = path.join(this.config.antigravitySessionDir, `${sessionPath}.jsonl`);
        try { return (await fs.stat(agFile)).mtime.getTime(); } catch { /* ignore */ }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private async deleteRuntimeFileByPath(sessionPath: string): Promise<void> {
    if (this.isPiFilePath(sessionPath) || this.isClaudeFilePath(sessionPath) || this.isAntigravityFilePath(sessionPath)) {
      try {
        await fs.unlink(sessionPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    if (!sessionPath.includes('/')) {
      const claudeFile = path.join(this.config.claudeSessionDir, `${sessionPath}.jsonl`);
      try { await fs.unlink(claudeFile); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      const agFile = path.join(this.config.antigravitySessionDir, `${sessionPath}.jsonl`);
      try { await fs.unlink(agFile); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  }

  private async sessionFilesExist(sessionPath: string): Promise<boolean> {
    if (sessionPath.endsWith('.jsonl') || sessionPath.startsWith(this.config.piSessionDir)) {
      try {
        await fs.access(sessionPath);
        return true;
      } catch {
        return false;
      }
    }

    if (!sessionPath.includes('/')) {
      const claudeFile = path.join(this.config.claudeSessionDir, `${sessionPath}.jsonl`);
      try {
        await fs.access(claudeFile);
        return true;
      } catch {
        /* fall through to antigravity check */
      }
      const agFile = path.join(this.config.antigravitySessionDir, `${sessionPath}.jsonl`);
      try {
        await fs.access(agFile);
        return true;
      } catch {
        return false;
      }
    }

    try {
      await fs.access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  private async deleteSessionFiles(entry: { sdkType: string; path: string; id: string }): Promise<void> {
    switch (entry.sdkType) {
      case 'pi': {
        const sessionPath = entry.path;
        try {
          const stat = await fs.stat(sessionPath);
          if (stat.isDirectory()) {
            await fs.rm(sessionPath, { recursive: true, force: true });
          } else {
            await fs.unlink(sessionPath);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        break;
      }
      case 'claude': {
        const jsonlFile = path.join(this.config.claudeSessionDir, `${entry.id}.jsonl`);
        try {
          await fs.unlink(jsonlFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        break;
      }
      case 'antigravity': {
        const jsonlFile = path.join(this.config.antigravitySessionDir, `${entry.id}.jsonl`);
        try {
          await fs.unlink(jsonlFile);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        const logsDir = path.join(this.config.antigravitySessionDir, 'agy-logs');
        try {
          const logFiles = await fs.readdir(logsDir);
          for (const logFile of logFiles) {
            if (logFile.startsWith(`${entry.id}-`)) {
              await fs.unlink(path.join(logsDir, logFile));
            }
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        break;
      }
      case 'opencode':
        break;
    }
  }
}

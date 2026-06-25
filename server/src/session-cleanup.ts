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
      const pinnedPaths = prefs.pinnedSessionPaths ?? [];
      if (pinnedPaths.length === 0) return [];

      const registry = getSessionRegistry();
      const now = Date.now();
      const expired: string[] = [];

      for (const sessionPath of pinnedPaths) {
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
          expired.push(sessionPath);
        }
      }

      if (expired.length === 0) return [];

      prefs.pinnedSessionPaths = pinnedPaths.filter(p => !expired.includes(p));
      await write(prefs);
      return expired;
    }, prefsPath ?? PREFS_FILE);

    for (const sessionId of toUnpin) {
      this.unpinInRuntimes(sessionId);
      result.unpinned.push(sessionId);
      logger.info(`[SessionCleanup] Auto-unpinned session after inactivity: ${sessionId}`);
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

    const toDelete: string[] = [];

    await withPrefsLock(async (read) => {
      const prefs = await read();
      const archivedPaths = prefs.archivedSessionPaths ?? [];
      if (archivedPaths.length === 0) return;

      for (const sessionPath of archivedPaths) {
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
            toDelete.push(sessionPath);
          } else if (now - fileMtime > this.config.archiveRetentionMs) {
            toDelete.push(sessionPath);
          }
          continue;
        }

        const lastActivity = entry.lastActivity ? new Date(entry.lastActivity).getTime() : 0;
        if (now - lastActivity > this.config.archiveRetentionMs) {
          toDelete.push(sessionPath);
        }
      }
    }, filePath);

    if (toDelete.length === 0) return;

    for (const sessionId of toDelete) {
      try {
        const entry = await registry.get(sessionId)
          ?? await registry.getByPath(sessionId)
          ?? await registry.getByClaudeSessionId(sessionId)
          ?? await registry.getByOpencodeSessionId(sessionId);

        if (entry) {
          await this.deleteSessionFiles(entry);
          await registry.delete(entry.id);
        }

        // Always delete the runtime file at the archived path as well. This
        // handles Pi .jsonl file paths (where the registry entry may be the
        // parent directory) and orphan files that no longer have a registry
        // entry (e.g. Internal-API ephemeral deletes).
        await this.deleteRuntimeFileByPath(sessionId);

        this.unpinInRuntimes(sessionId);
        result.deleted.push(sessionId);
        logger.info(`[SessionCleanup] Deleted archived session: ${sessionId}`);
      } catch (err) {
        result.errors.push({
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.error(`[SessionCleanup] Failed to delete session ${sessionId}:`, err instanceof Error ? err.message : String(err));
      }
    }

    const deletedSet = new Set(toDelete.filter(id => !result.errors.some(e => e.sessionId === id)));
    if (deletedSet.size > 0) {
      await withPrefsLock(async (read, write) => {
        const prefs = await read();
        prefs.archivedSessionPaths = (prefs.archivedSessionPaths ?? []).filter(p => !deletedSet.has(p));
        prefs.pinnedSessionPaths = (prefs.pinnedSessionPaths ?? []).filter(p => !deletedSet.has(p));
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

import fs from 'fs/promises';
import path from 'path';
import { getSessionRegistry } from './session-registry.js';
import { readPreferences, writePreferences, type Preferences, PREFS_FILE } from './routes/preferences.js';
import type { MultiSessionManager } from './pi/multi-session-manager.js';
import type { ClaudeService } from './claude/index.js';
import type { OpenCodeService } from './opencode/index.js';
import { config } from './config.js';

export const DEFAULT_PIN_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionCleanupConfig {
  pinInactivityMs: number;
  archiveRetentionMs: number;
  cleanupIntervalMs: number;
  piSessionDir: string;
  claudeSessionDir: string;
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
    };
  }

  bindRuntimes(opts: {
    multiSessionManager: MultiSessionManager;
    claudeService: ClaudeService;
    opencodeService: OpenCodeService;
  }): void {
    this.multiSessionManager = opts.multiSessionManager;
    this.claudeService = opts.claudeService;
    this.opencodeService = opts.opencodeService;
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
    console.log(
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
      console.error('[SessionCleanup] Error during auto-unpin pass:', err instanceof Error ? err.message : String(err));
    }

    try {
      await this.autoDeleteArchivedSessions(result, prefsPath);
    } catch (err) {
      console.error('[SessionCleanup] Error during auto-delete pass:', err instanceof Error ? err.message : String(err));
    }

    if (result.unpinned.length > 0 || result.deleted.length > 0 || result.errors.length > 0) {
      console.log(
        `[SessionCleanup] Cleanup complete: ${result.unpinned.length} unpinned, ${result.deleted.length} deleted, ${result.errors.length} error(s)`,
      );
    }

    return result;
  }

  private async autoUnpinInactivePinnedSessions(
    result: SessionCleanupResult,
    prefsPath?: string,
  ): Promise<void> {
    const prefs = await readPreferences(prefsPath ?? PREFS_FILE);
    const pinnedPaths = prefs.pinnedSessionPaths ?? [];
    if (pinnedPaths.length === 0) return;

    const registry = getSessionRegistry();
    const now = Date.now();
    const toUnpin: string[] = [];

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
        toUnpin.push(sessionPath);
      }
    }

    if (toUnpin.length === 0) return;

    const updatedPins = pinnedPaths.filter(p => !toUnpin.includes(p));

    const merged: Preferences = {
      ...prefs,
      pinnedSessionPaths: updatedPins,
    };
    await writePreferences(merged, prefsPath ?? PREFS_FILE);

    for (const sessionId of toUnpin) {
      this.unpinInRuntimes(sessionId);
      result.unpinned.push(sessionId);
      console.log(`[SessionCleanup] Auto-unpinned session after inactivity: ${sessionId}`);
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
  }

  private async autoDeleteArchivedSessions(
    result: SessionCleanupResult,
    prefsPath?: string,
  ): Promise<void> {
    const prefs = await readPreferences(prefsPath ?? PREFS_FILE);
    const archivedPaths = prefs.archivedSessionPaths ?? [];
    if (archivedPaths.length === 0) return;

    const registry = getSessionRegistry();
    const now = Date.now();
    const toDelete: string[] = [];

    for (const sessionPath of archivedPaths) {
      const entry = await registry.get(sessionPath)
        ?? await registry.getByPath(sessionPath)
        ?? await registry.getByClaudeSessionId(sessionPath)
        ?? await registry.getByOpencodeSessionId(sessionPath);

      if (!entry) {
        toDelete.push(sessionPath);
        continue;
      }

      const lastActivity = entry.lastActivity ? new Date(entry.lastActivity).getTime() : 0;
      if (now - lastActivity > this.config.archiveRetentionMs) {
        toDelete.push(sessionPath);
      }
    }

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

        this.unpinInRuntimes(sessionId);

        const cleanedArchived = (prefs.archivedSessionPaths ?? []).filter(p => p !== sessionId);
        const cleanedPins = (prefs.pinnedSessionPaths ?? []).filter(p => p !== sessionId);
        prefs.archivedSessionPaths = cleanedArchived;
        prefs.pinnedSessionPaths = cleanedPins;
        await writePreferences(prefs, prefsPath ?? PREFS_FILE);

        result.deleted.push(sessionId);
        console.log(`[SessionCleanup] Deleted archived session: ${sessionId}`);
      } catch (err) {
        result.errors.push({
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(`[SessionCleanup] Failed to delete session ${sessionId}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async deleteSessionFiles(entry: { sdkType: string; path: string; id: string }): Promise<void> {
    switch (entry.sdkType) {
      case 'pi': {
        const sessionDir = entry.path;
        try {
          const stat = await fs.stat(sessionDir);
          if (stat.isDirectory()) {
            await fs.rm(sessionDir, { recursive: true, force: true });
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
      case 'opencode':
        break;
    }
  }
}

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getSessionRegistry } from './session-registry.js';
import { withPrefsLock, PREFS_FILE, buildRegistryResolver } from './routes/preferences.js';
import { toV2Key, type SessionMeta } from './routes/session-meta.js';
import type { MultiSessionManager } from './pi/multi-session-manager.js';
import type { ClaudeService } from './claude/index.js';
import type { OpenCodeService } from './opencode/index.js';
import type { AntigravityService } from './antigravity/index.js';
import type { DevinService } from './devin/index.js';
import { config } from './config.js';
import { createLogger } from './logging/logger.js';

const logger = createLogger('SessionCleanup');

/**
 * Stage 0 of the hygiene funnel (plan Phase 3): a pi CLI session the
 * SessionWatcher just discovered on disk (origin 'native-discovered') that is
 * ALREADY older than the discovery threshold is flagged archived immediately
 * upon discovery, so hundreds of historical CLI sessions never flood the
 * sidebar's active list. Reversible and idempotent: explicit pins win, and an
 * existing archived stamp (with its retention-dwell archivedAt) is preserved.
 * Returns true when this call stamped a NEW archive record.
 */
export async function archiveStaleDiscoveredSession(opts: {
  sessionPath: string;
  lastActivityMs: number;
  /** Recency threshold in ms; <= 0 disables. Defaults to
   *  config.sessionDiscoveryArchiveDays (14 days). */
  thresholdMs?: number;
  prefsPath?: string;
}): Promise<boolean> {
  const thresholdMs = opts.thresholdMs ?? config.sessionDiscoveryArchiveDays * 24 * 60 * 60 * 1000;
  if (thresholdMs <= 0) return false;
  if (Date.now() - opts.lastActivityMs <= thresholdMs) return false;

  const filePath = opts.prefsPath ?? PREFS_FILE;
  const resolver = await buildRegistryResolver();
  const { key } = toV2Key(opts.sessionPath, resolver);
  const now = Date.now();

  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const rec = prefs.sessions[key];
    if (rec?.archived || rec?.pinned) return false;
    prefs.sessions[key] = {
      ...(rec ?? {}),
      archived: true,
      archivedAt: rec?.archivedAt ?? now,
      updatedAt: now,
      legacyKey: rec?.legacyKey ?? opts.sessionPath,
    };
    await write(prefs);
    return true;
  }, filePath);
}


export const DEFAULT_PIN_INACTIVITY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_AUTO_ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** Grace period between archiving and retention-delete eligibility. */
export const DEFAULT_RETENTION_MIN_DWELL_MS = 7 * 24 * 60 * 60 * 1000;
/** Default recency threshold for auto-archiving a session upon discovery. */
export const DEFAULT_DISCOVERY_ARCHIVE_MS = 14 * 24 * 60 * 60 * 1000;

export interface SessionCleanupConfig {
  pinInactivityMs: number;
  archiveRetentionMs: number;
  cleanupIntervalMs: number;
  /** Stage 1: auto-archive sessions idle longer than this (0 disables). */
  autoArchiveMs: number;
  /** Report what would happen without acting. Default true until reviewed. */
  dryRun: boolean;
  /** Minimum time a session must dwell archived before deletion is eligible. */
  retentionMinDwellMs: number;
  piSessionDir: string;
  claudeSessionDir: string;
  antigravitySessionDir: string;
  devinSessionDir: string;
  /** Delete guard (owner, 13 Nov 2026): when set, a session's runtime files are only deleted
   * after the jev hardlink archive holds them. Unset (the default, and `SESSION_DELETE_REQUIRE_ARCHIVE_ROOT`
   * unset) keeps the previous behaviour. */
  deleteRequireArchiveRoot?: string;
  /** The home directory the jev archive mirrors; defaults to os.homedir(). */
  deleteRequireArchiveHome?: string;
}

export interface SessionCleanupResult {
  unpinned: string[];
  deleted: string[];
  errors: Array<{ sessionId: string; error: string }>;
  autoArchived: string[];
  wouldUnpin: string[];
  wouldArchive: string[];
  wouldDelete: string[];
  /** Candidates kept for this pass because the jev archive does not hold their runtime files yet. */
  skippedUnarchived: string[];
}

export class SessionCleanupService {
  private multiSessionManager?: MultiSessionManager;
  private claudeService?: ClaudeService;
  private opencodeService?: OpenCodeService;
  private antigravityService?: AntigravityService;
  private devinService?: DevinService;
  private config: SessionCleanupConfig;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    cleanupConfig?: Partial<SessionCleanupConfig>,
  ) {
    const configuredRoot = cleanupConfig?.deleteRequireArchiveRoot;
    const envRoot = process.env.SESSION_DELETE_REQUIRE_ARCHIVE_ROOT;
    const guardRoot = configuredRoot ?? (envRoot && envRoot.trim() ? envRoot.trim() : undefined);
    this.config = {
      pinInactivityMs: cleanupConfig?.pinInactivityMs ?? DEFAULT_PIN_INACTIVITY_MS,
      archiveRetentionMs: cleanupConfig?.archiveRetentionMs ?? DEFAULT_ARCHIVE_RETENTION_MS,
      cleanupIntervalMs: cleanupConfig?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
      autoArchiveMs: cleanupConfig?.autoArchiveMs ?? config.sessionAutoArchiveDays * 24 * 60 * 60 * 1000,
      dryRun: cleanupConfig?.dryRun ?? config.sessionCleanupDryRun,
      retentionMinDwellMs: cleanupConfig?.retentionMinDwellMs ?? config.sessionRetentionMinDwellDays * 24 * 60 * 60 * 1000,
      piSessionDir: cleanupConfig?.piSessionDir ?? config.sessionDir ?? path.join(config.piAgentDir, 'sessions'),
      claudeSessionDir: cleanupConfig?.claudeSessionDir ?? config.claudeSessionDir,
      antigravitySessionDir: cleanupConfig?.antigravitySessionDir ?? config.antigravitySessionDir,
      devinSessionDir: cleanupConfig?.devinSessionDir ?? config.devinSessionDir,
      deleteRequireArchiveRoot: guardRoot,
      deleteRequireArchiveHome: cleanupConfig?.deleteRequireArchiveHome ?? os.homedir(),
    };
    // Log the guard's state once, at construction (the service is a singleton): an operator reading
    // the journal must be able to tell whether deletions are guarded, and a blank value in
    // production.env must not disable the guard silently.
    if (guardRoot) {
      logger.info(
        `[SessionCleanup] Delete guard ON: no runtime file is deleted until the jev archive holds it (${guardRoot})`,
      );
    } else if (configuredRoot === undefined && envRoot !== undefined && envRoot.trim() === '') {
      logger.warn(
        '[SessionCleanup] SESSION_DELETE_REQUIRE_ARCHIVE_ROOT is set but empty — the archive delete guard is OFF. ' +
        'A blank value in production.env silently disables it; unset the variable or name the archive root.',
      );
    }
  }

  bindRuntimes(opts: {
    multiSessionManager: MultiSessionManager;
    claudeService: ClaudeService;
    opencodeService: OpenCodeService;
    antigravityService?: AntigravityService;
    devinService?: DevinService;
  }): void {
    this.multiSessionManager = opts.multiSessionManager;
    this.claudeService = opts.claudeService;
    this.opencodeService = opts.opencodeService;
    this.antigravityService = opts.antigravityService;
    this.devinService = opts.devinService;
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
    const result: SessionCleanupResult = { unpinned: [], deleted: [], errors: [], autoArchived: [], wouldUnpin: [], wouldArchive: [], wouldDelete: [], skippedUnarchived: [] };
    const dryRun = this.config.dryRun;

    try {
      await this.autoUnpinInactivePinnedSessions(result, prefsPath);
    } catch (err) {
      logger.error('[SessionCleanup] Error during auto-unpin pass:', err instanceof Error ? err.message : String(err));
    }

    try {
      await this.autoArchiveInactiveSessions(result, prefsPath);
    } catch (err) {
      logger.error('[SessionCleanup] Error during auto-archive pass:', err instanceof Error ? err.message : String(err));
    }

    try {
      await this.autoDeleteArchivedSessions(result, prefsPath);
    } catch (err) {
      logger.error('[SessionCleanup] Error during auto-delete pass:', err instanceof Error ? err.message : String(err));
    }

    if (dryRun) {
      const sample = (arr: string[]) => (arr.length > 0 ? `; e.g. ${arr.slice(0, 3).join(', ')}` : '');
      logger.info(
        `[SessionCleanup] DRY-RUN pass (no changes written): would unpin ${result.wouldUnpin.length}, ` +
        `would archive ${result.wouldArchive.length}, would delete ${result.wouldDelete.length}` +
        `${sample(result.wouldArchive)}${sample(result.wouldDelete)}`,
      );
    } else if (result.unpinned.length > 0 || result.deleted.length > 0 || result.autoArchived.length > 0 || result.errors.length > 0) {
      logger.info(
        `[SessionCleanup] Cleanup complete: ${result.unpinned.length} unpinned, ${result.autoArchived.length} auto-archived, ` +
        `${result.deleted.length} deleted, ${result.errors.length} error(s)`,
      );
    }

    return result;
  }

  /** Resolve last activity for a session path: in-memory first, then registry. */
  private async resolveLastActivity(sessionPath: string): Promise<number | undefined> {
    const inMemory = this.getInMemoryLastActivity(sessionPath);
    if (inMemory !== undefined) return inMemory;

    const registry = getSessionRegistry();
    const entry = await registry.get(sessionPath)
      ?? await registry.getByPath(sessionPath)
      ?? await registry.getByClaudeSessionId(sessionPath)
      ?? await registry.getByOpencodeSessionId(sessionPath);
    if (entry?.lastActivity) return new Date(entry.lastActivity).getTime();
    return undefined;
  }

  /**
   * Stage 1 of the hygiene funnel: archive sessions with no activity beyond
   * the threshold. Reversible — it only removes them from the default view.
   * Pinned sessions are never auto-archived (auto-unpin handles stale pins,
   * and the next pass picks them up). Each newly archived record is stamped
   * with `archivedAt` so stage-2 retention deletion can enforce its minimum
   * dwell time.
   *
   * Candidate universe is the union of registry entries (the authoritative
   * session inventory) and existing prefs records (orphaned/legacy identities),
   * so sessions that never gained a metadata record are still funnelled.
   */
  private async autoArchiveInactiveSessions(
    result: SessionCleanupResult,
    prefsPath?: string,
  ): Promise<void> {
    if (this.config.autoArchiveMs <= 0) return;
    const filePath = prefsPath ?? PREFS_FILE;
    const now = Date.now();
    const registry = getSessionRegistry();
    const resolver = await buildRegistryResolver();

    let entries: Array<{ id?: string; path?: string; lastActivity?: string | Date }> = [];
    try {
      entries = await registry.listAll();
    } catch {
      entries = [];
    }

    const toArchive = await withPrefsLock(async (read, write) => {
      const prefs = await read();
      const aged: string[] = [];
      const stamp = (key: string, rec: SessionMeta | undefined, sessionPath: string): void => {
        prefs.sessions[key] = {
          ...(rec ?? {}),
          archived: true,
          archivedAt: rec?.archivedAt ?? now,
          updatedAt: now,
          legacyKey: rec?.legacyKey ?? sessionPath,
        };
        aged.push(sessionPath);
      };

      // Universe A: every known registry session.
      for (const e of entries) {
        const sessionPath = e.path ?? e.id;
        if (!sessionPath) continue;
        if (!e.lastActivity) continue;
        const last = new Date(e.lastActivity).getTime();
        if (Number.isNaN(last) || now - last <= this.config.autoArchiveMs) continue;
        const { key } = toV2Key(sessionPath, resolver);
        const rec = prefs.sessions[key];
        if (rec?.archived || rec?.pinned) continue;
        stamp(key, rec, sessionPath);
      }

      // Universe B: prefs records for identities no registry entry covered.
      for (const [key, rec] of Object.entries(prefs.sessions)) {
        if (rec.archived || rec.pinned) continue;
        const sessionPath = rec.legacyKey ?? key;
        if (aged.includes(sessionPath)) continue;
        const lastActivity = await this.resolveLastActivity(sessionPath);
        if (lastActivity === undefined) continue;
        if (now - lastActivity <= this.config.autoArchiveMs) continue;
        stamp(key, rec, sessionPath);
      }

      if (aged.length > 0 && !this.config.dryRun) await write(prefs);
      return aged;
    }, filePath);

    if (this.config.dryRun) {
      result.wouldArchive.push(...toArchive);
    } else {
      for (const sessionPath of toArchive) {
        result.autoArchived.push(sessionPath);
        logger.info(`[SessionCleanup] Auto-archived session idle > ${Math.round(this.config.autoArchiveMs / 86400000)}d: ${sessionPath}`);
      }
    }
  }

  private async autoUnpinInactivePinnedSessions(
    result: SessionCleanupResult,
    prefsPath?: string,
  ): Promise<void> {
    const toUnpin = await withPrefsLock(async (read, write) => {
      const prefs = await read();
      const pinnedEntries = Object.entries(prefs.sessions).filter(([, rec]) => rec.pinned);
      if (pinnedEntries.length === 0) return [] as Array<{ key: string; path: string }>;

      const now = Date.now();
      const expired: Array<{ key: string; path: string }> = [];

      for (const [key, rec] of pinnedEntries) {
        const sessionPath = rec.legacyKey ?? key;
        const lastActivity = await this.resolveLastActivity(sessionPath);
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
      if (!this.config.dryRun) await write(prefs);
      return expired;
    }, prefsPath ?? PREFS_FILE);

    for (const { path } of this.config.dryRun ? [] : toUnpin) {
      this.unpinInRuntimes(path);
      result.unpinned.push(path);
      logger.info(`[SessionCleanup] Auto-unpinned session after inactivity: ${path}`);
    }
    if (this.config.dryRun) {
      result.wouldUnpin.push(...toUnpin.map(({ path }) => path));
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
    this.devinService?.unpinSession(sessionId);
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
        // Minimum dwell time in the archived state before deletion is eligible.
        // Records stamped by the auto-archive funnel always carry archivedAt, so
        // freshly auto-archived sessions get a full grace period. Legacy records
        // without archivedAt predate the funnel and are grandfathered as eligible.
        if (rec.archivedAt !== undefined && now - rec.archivedAt < this.config.retentionMinDwellMs) {
          continue;
        }

        const sessionPath = rec.legacyKey ?? key;
        const entry = await registry.get(sessionPath)
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

    if (this.config.dryRun) {
      // Report what a live pass would actually do: with the guard on, a candidate the archive does
      // not hold would be kept, and saying otherwise over-states the deletion.
      for (const { path: sessionPath } of toDelete) {
        const check = await this.guardTargets(sessionPath);
        if (check && (check.missing.length > 0 || !(await this.allArchived(check.files)))) {
          result.skippedUnarchived.push(sessionPath);
        } else {
          result.wouldDelete.push(sessionPath);
        }
      }
      return;
    }

    for (const { path: sessionPath } of toDelete) {
      try {
        // Delete guard: keep the session (files, registry entry and prefs record) while the jev
        // archive does not yet hold its runtime files. Nothing is lost — the next pass retries.
        // The files are re-stat'ed immediately before the unlinks below: a transcript rewritten in
        // the gap between the pass-level check and the deletion must not lose its new tail.
        //
        // Scope: this guard covers SessionCleanup only. UI deletes and Internal API ephemeral
        // deletes remove runtime files through their own `deleteSessionFiles` in
        // internal-api/routes/sessions.ts and are NOT guarded — their copy survives only if the
        // daily archive snapshot ran in between. Read this as "retention never deletes unarchived
        // data", not "no runtime file is ever deleted before it is archived".
        const check = await this.guardTargets(sessionPath);
        if (check && (check.missing.length > 0 || !(await this.allArchived(check.files)))) {
          result.skippedUnarchived.push(sessionPath);
          logger.info(`[SessionCleanup] not archived yet: ${sessionPath}`);
          continue;
        }

        const entry = await registry.get(sessionPath)
          ?? await registry.getByPath(sessionPath)
          ?? await registry.getByClaudeSessionId(sessionPath)
          ?? await registry.getByOpencodeSessionId(sessionPath);

        if (entry) {
          await this.deleteSessionFiles(entry);
          await registry.delete(entry.id);
        }

        // Always delete the runtime file at the archived path as well. This
        // handles Pi .jsonl file paths (where the registry entry may be the
        // parent directory) and orphan files that no longer have a registry
        // entry (e.g. Internal-API ephemeral deletes).
        await this.deleteRuntimeFileByPath(sessionPath);

        this.unpinInRuntimes(sessionPath);
        result.deleted.push(sessionPath);
        logger.info(`[SessionCleanup] Deleted archived session: ${sessionPath}`);
      } catch (err) {
        result.errors.push({
          sessionId: sessionPath,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.error(`[SessionCleanup] Failed to delete session ${sessionPath}:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Remove successfully-deleted sessions from the prefs map entirely. The
    // session's files are permanently gone, so its metadata record serves no
    // purpose — and keeping a cleared-but-present record (a `{updatedAt,
    // legacyKey}` husk) would leak one dead entry per retention pass forever,
    // bloating the prefs file unboundedly. Hard-delete is safe here (unlike a
    // user unarchive, where a husk acts as an LWW tombstone): a permanently
    // deleted session cannot be legitimately resurrected, and a stray stale
    // write would only recreate an orphan that the next pass removes again.
    // A session kept by the guard or by an error keeps its prefs record: its files are still there.
    const kept = new Set([...result.errors.map(e => e.sessionId), ...result.skippedUnarchived]);
    const deletedKeys = new Set(toDelete.filter(({ path }) => !kept.has(path)).map(({ key }) => key));
    if (deletedKeys.size > 0) {
      await withPrefsLock(async (read, write) => {
        const prefs = await read();
        for (const key of deletedKeys) {
          delete prefs.sessions[key];
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

  private isDevinFilePath(sessionPath: string): boolean {
    const dir = path.dirname(sessionPath);
    return dir === this.config.devinSessionDir && sessionPath.endsWith('.jsonl');
  }

  private async getRuntimeFileMtime(sessionPath: string): Promise<number | undefined> {
    try {
      if (this.isPiFilePath(sessionPath) || this.isClaudeFilePath(sessionPath) || this.isAntigravityFilePath(sessionPath) || this.isDevinFilePath(sessionPath)) {
        const stat = await fs.stat(sessionPath);
        return stat.mtime.getTime();
      }
      // Bare ID: check known runtime locations.
      if (!sessionPath.includes('/')) {
        const claudeFile = path.join(this.config.claudeSessionDir, `${sessionPath}.jsonl`);
        try { return (await fs.stat(claudeFile)).mtime.getTime(); } catch { /* ignore */ }
        const agFile = path.join(this.config.antigravitySessionDir, `${sessionPath}.jsonl`);
        try { return (await fs.stat(agFile)).mtime.getTime(); } catch { /* ignore */ }
        const devinFile = path.join(this.config.devinSessionDir, `${sessionPath}.jsonl`);
        try { return (await fs.stat(devinFile)).mtime.getTime(); } catch { /* ignore */ }
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private async registryEntryFor(sessionPath: string): Promise<{ sdkType: string; path: string; id: string } | undefined> {
    const registry = getSessionRegistry();
    return await registry.get(sessionPath)
      ?? await registry.getByPath(sessionPath)
      ?? await registry.getByClaudeSessionId(sessionPath)
      ?? await registry.getByOpencodeSessionId(sessionPath);
  }

  /**
   * The archive path jev-session-eval would use for a runtime file. Its archive mirrors the home
   * layout with hardlinks (`<archive root>/<home-relative path>`), so this is a path mapping, not a
   * guess. A file outside that home cannot be verified and therefore counts as not archived.
   */
  private archivePathFor(file: string): string | null {
    const root = this.config.deleteRequireArchiveRoot;
    if (!root) return null;
    const rel = path.relative(this.config.deleteRequireArchiveHome ?? os.homedir(), file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return path.join(root, rel);
  }

  /**
   * Does the archive hold this exact file? Either the hardlink itself (same inode), or a copy at
   * least as new and as large — a transcript rewritten after the last snapshot must not lose its
   * tail to a deletion.
   */
  private async isArchived(file: string): Promise<boolean> {
    const dest = this.archivePathFor(file);
    if (!dest) return false;
    try {
      const [live, arch] = await Promise.all([fs.stat(file), fs.stat(dest)]);
      if (!arch.isFile()) return false;
      if (arch.ino === live.ino && arch.dev === live.dev) return true;
      return arch.mtimeMs >= live.mtimeMs && arch.size >= live.size;
    } catch {
      return false;
    }
  }

  private async walkFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await this.walkFiles(full));
      else out.push(full);
    }
    return out;
  }

  /** Every runtime file this candidate's deletion would remove, restricted to files on disk
   * (directories are expanded, because a pi session directory is removed recursively), plus the
   * paths that could not be stat'ed for a reason other than ENOENT: those are unverified, and an
   * unverified file is treated as not archived. */
  private async deleteTargetsFor(sessionPath: string): Promise<{ files: string[]; unverified: string[] }> {
    const candidates = new Set<string>();
    const entry = await this.registryEntryFor(sessionPath);
    if (entry) {
      switch (entry.sdkType) {
        case 'pi':
          candidates.add(entry.path);
          break;
        case 'claude':
          candidates.add(path.join(this.config.claudeSessionDir, `${entry.id}.jsonl`));
          break;
        case 'antigravity': {
          candidates.add(path.join(this.config.antigravitySessionDir, `${entry.id}.jsonl`));
          const logsDir = path.join(this.config.antigravitySessionDir, 'agy-logs');
          for (const name of await fs.readdir(logsDir).catch(() => [] as string[])) {
            if (name.startsWith(`${entry.id}-`)) candidates.add(path.join(logsDir, name));
          }
          break;
        }
        case 'devin':
          candidates.add(path.join(this.config.devinSessionDir, `${entry.id}.jsonl`));
          break;
        default:
          break; // opencode deletes no local file
      }
    }
    if (this.isPiFilePath(sessionPath) || this.isClaudeFilePath(sessionPath) || this.isAntigravityFilePath(sessionPath) || this.isDevinFilePath(sessionPath)) {
      candidates.add(sessionPath);
    } else if (!sessionPath.includes('/')) {
      candidates.add(path.join(this.config.claudeSessionDir, `${sessionPath}.jsonl`));
      candidates.add(path.join(this.config.antigravitySessionDir, `${sessionPath}.jsonl`));
      candidates.add(path.join(this.config.devinSessionDir, `${sessionPath}.jsonl`));
    }
    const files: string[] = [];
    const unverified: string[] = [];
    for (const candidate of candidates) {
      const stat = await fs.stat(candidate).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null; // already gone: nothing to lose
        return undefined; // EACCES, EIO, ELOOP …: cannot verify, so do not delete
      });
      if (stat === null) continue;
      if (stat === undefined) {
        unverified.push(candidate);
        continue;
      }
      files.push(...(stat.isDirectory() ? await this.walkFiles(candidate) : [candidate]));
    }
    return { files, unverified };
  }

  /**
   * The deletion's target files and the ones the archive does not hold. `null` when the guard is
   * off (`SESSION_DELETE_REQUIRE_ARCHIVE_ROOT` unset), which keeps every other host and every
   * existing test on the previous behaviour.
   */
  private async guardTargets(sessionPath: string): Promise<{ files: string[]; missing: string[] } | null> {
    if (!this.config.deleteRequireArchiveRoot) return null;
    const { files, unverified } = await this.deleteTargetsFor(sessionPath);
    const missing = [...unverified];
    for (const file of files) {
      if (!(await this.isArchived(file))) missing.push(file);
    }
    return { files, missing };
  }

  /** Fresh stat of every target, called immediately before the unlinks. */
  private async allArchived(files: string[]): Promise<boolean> {
    for (const file of files) {
      if (!(await this.isArchived(file))) return false;
    }
    return true;
  }

  private async deleteRuntimeFileByPath(sessionPath: string): Promise<void> {
    if (this.isPiFilePath(sessionPath) || this.isClaudeFilePath(sessionPath) || this.isAntigravityFilePath(sessionPath) || this.isDevinFilePath(sessionPath)) {
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
      const devinFile = path.join(this.config.devinSessionDir, `${sessionPath}.jsonl`);
      try { await fs.unlink(devinFile); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
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
        /* fall through to devin check */
      }
      const devinFile = path.join(this.config.devinSessionDir, `${sessionPath}.jsonl`);
      try {
        await fs.access(devinFile);
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
      case 'devin': {
        // Review fix 6: mirror the antigravity branch — the per-session turn
        // store JSONL is removed with the archived record (devin keeps no
        // extra log files).
        const devinFile = path.join(this.config.devinSessionDir, `${entry.id}.jsonl`);
        try {
          await fs.unlink(devinFile);
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

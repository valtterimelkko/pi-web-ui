import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { SessionCleanupService, DEFAULT_PIN_INACTIVITY_MS, DEFAULT_ARCHIVE_RETENTION_MS } from '../../src/session-cleanup.js';
import { migrateV1ToV2, deriveLegacyArrays, isV2, type V1Preferences } from '../../src/routes/session-meta.js';

const mockRegistryEntries: Map<string, any> = new Map();
const mockRegistry = {
  get: vi.fn(async (id: string) => mockRegistryEntries.get(id)),
  getByPath: vi.fn(async (p: string) => {
    for (const e of mockRegistryEntries.values()) {
      if (e.path === p) return e;
    }
    return undefined;
  }),
  getByClaudeSessionId: vi.fn(async (sid: string) => {
    for (const e of mockRegistryEntries.values()) {
      if (e.claudeSessionId === sid) return e;
    }
    return undefined;
  }),
  getByOpencodeSessionId: vi.fn(async (sid: string) => {
    for (const e of mockRegistryEntries.values()) {
      if (e.opencodeSessionId === sid) return e;
    }
    return undefined;
  }),
  delete: vi.fn(async (id: string) => { mockRegistryEntries.delete(id); }),
  upsert: vi.fn(async (entry: any) => { mockRegistryEntries.set(entry.id ?? entry.path, entry); return entry; }),
  listAll: vi.fn(async () => [...mockRegistryEntries.values()]),
};

vi.mock('../../src/session-registry.js', () => ({
  getSessionRegistry: () => mockRegistry,
}));

vi.mock('../../src/config.js', () => ({
  config: {
    piAgentDir: '/tmp/test-pi-agent',
    claudeSessionDir: '/tmp/test-claude-sessions',
    antigravitySessionDir: '/tmp/test-antigravity-sessions',
    sessionRegistryPath: '/tmp/test-session-registry.json',
  },
}));

function makeMultiSessionManager(unpinFn?: (id: string) => boolean) {
  return {
    unpinSession: vi.fn(unpinFn ?? (() => true)),
    getActiveSession: vi.fn(() => undefined),
  } as any;
}

function makeClaudeService() {
  return {
    unpinSession: vi.fn(() => true),
  } as any;
}

function makeOpenCodeService(statuses: any[] = []) {
  return {
    unpinSession: vi.fn(() => true),
    getSessionStatuses: vi.fn(() => statuses),
  } as any;
}

function makeAntigravityService() {
  return {
    unpinSession: vi.fn(() => true),
  } as any;
}

describe('SessionCleanupService', () => {
  let tmpDir: string;
  let prefsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-test-'));
    prefsPath = path.join(tmpDir, 'prefs.json');
    mockRegistryEntries.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writePrefs(prefs: Record<string, any>): Promise<void> {
    // Mirror the real substrate: legacy v1 input is migrated to v2 on disk so
    // the cleanup service (which reads v2) sees realistic data.
    const onDisk = isV2(prefs)
      ? prefs
      : migrateV1ToV2(prefs as V1Preferences, () => null, Date.now());
    await fs.writeFile(prefsPath, JSON.stringify(onDisk), 'utf-8');
  }

  async function readPrefs(): Promise<Record<string, any>> {
    try {
      const raw = JSON.parse(await fs.readFile(prefsPath, 'utf-8'));
      // Return v2 plus the derived legacy arrays so existing v1-style assertions
      // (pinnedSessionPaths / archivedSessionPaths) keep working.
      return isV2(raw) ? { ...raw, ...deriveLegacyArrays(raw) } : raw;
    } catch {
      return {};
    }
  }

  function makeService(opts?: { pinInactivityMs?: number; archiveRetentionMs?: number }) {
    return new SessionCleanupService({
      pinInactivityMs: opts?.pinInactivityMs ?? 24 * 60 * 60 * 1000,
      archiveRetentionMs: opts?.archiveRetentionMs ?? 90 * 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 999999999,
      piSessionDir: path.join(tmpDir, 'pi-sessions'),
      claudeSessionDir: path.join(tmpDir, 'claude-sessions'),
      antigravitySessionDir: path.join(tmpDir, 'antigravity-sessions'),
    });
  }

  function bindAll(service: any, extra: { multi?: any; claude?: any; opencode?: any; antigravity?: any } = {}) {
    service.bindRuntimes({
      multiSessionManager: extra.multi ?? makeMultiSessionManager(),
      claudeService: extra.claude ?? makeClaudeService(),
      opencodeService: extra.opencode ?? makeOpenCodeService(),
      antigravityService: extra.antigravity ?? makeAntigravityService(),
    });
  }

  describe('auto-unpin after 24h inactivity', () => {
    it('should unpin a session inactive for more than 24h', async () => {
      const sessionId = 'old-pinned-session';
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      await writePrefs({ pinnedSessionPaths: [sessionId], archivedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'pi', path: `/sessions/${sessionId}`,
        lastActivity: twentyFiveHoursAgo, status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).toContain(sessionId);
      const prefs = await readPrefs();
      expect(prefs.pinnedSessionPaths).not.toContain(sessionId);
    });

    it('should NOT unpin a session still active within 24h', async () => {
      const sessionId = 'recent-pinned-session';
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await writePrefs({ pinnedSessionPaths: [sessionId], archivedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'claude', path: `/claude/${sessionId}`,
        lastActivity: oneHourAgo, status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).not.toContain(sessionId);
      const prefs = await readPrefs();
      expect(prefs.pinnedSessionPaths).toContain(sessionId);
    });

    it('should use in-memory lastActivity for Pi SDK sessions', async () => {
      const sessionId = 'in-memory-pi-session';
      await writePrefs({ pinnedSessionPaths: [sessionId], archivedSessionPaths: [] });

      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const service = makeService();
      bindAll(service, {
        multi: {
          unpinSession: vi.fn(() => true),
          getActiveSession: vi.fn(() => ({ lastActivity: oldDate, pinned: true })),
        } as any,
      });

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).toContain(sessionId);
    });

    it('should use in-memory lastActivity for OpenCode sessions', async () => {
      const sessionId = 'opencode-in-memory';
      await writePrefs({ pinnedSessionPaths: [sessionId], archivedSessionPaths: [] });

      const service = makeService();
      bindAll(service, {
        opencode: {
          unpinSession: vi.fn(() => true),
          getSessionStatuses: vi.fn(() => [{
            sessionId,
            status: 'idle',
            lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000),
            pinned: true,
          }]),
        } as any,
      });

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).toContain(sessionId);
    });

    it('should handle no pinned sessions gracefully', async () => {
      await writePrefs({ pinnedSessionPaths: [], archivedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).toEqual([]);
      expect(result.deleted).toEqual([]);
    });

    it('should only unpin inactive sessions among multiple pinned', async () => {
      const oldSession = 'old-session';
      const recentSession = 'recent-session';

      await writePrefs({ pinnedSessionPaths: [oldSession, recentSession], archivedSessionPaths: [] });
      mockRegistryEntries.set(oldSession, {
        id: oldSession, sdkType: 'pi', path: `/sessions/${oldSession}`,
        lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });
      mockRegistryEntries.set(recentSession, {
        id: recentSession, sdkType: 'pi', path: `/sessions/${recentSession}`,
        lastActivity: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).toContain(oldSession);
      expect(result.unpinned).not.toContain(recentSession);

      const prefs = await readPrefs();
      expect(prefs.pinnedSessionPaths).toContain(recentSession);
      expect(prefs.pinnedSessionPaths).not.toContain(oldSession);
    });

    it('should unpin across all three runtimes', async () => {
      const sessionId = 'multi-runtime-unpin';
      await writePrefs({ pinnedSessionPaths: [sessionId], archivedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'pi', path: `/sessions/${sessionId}`,
        lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const multi = makeMultiSessionManager();
      const claude = makeClaudeService();
      const opencode = makeOpenCodeService();

      const service = makeService();
      service.bindRuntimes({ multiSessionManager: multi, claudeService: claude, opencodeService: opencode });

      await service.runCleanup(prefsPath);

      expect(multi.unpinSession).toHaveBeenCalledWith(sessionId);
      expect(claude.unpinSession).toHaveBeenCalledWith(sessionId);
      expect(opencode.unpinSession).toHaveBeenCalledWith(sessionId);
    });
  });

  describe('auto-delete archived sessions after 3 months', () => {
    it('should delete a Pi session directory archived for more than 90 days', async () => {
      const sessionId = 'old-archived-pi';
      const sessionDir = path.join(tmpDir, 'pi-sessions', sessionId);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(path.join(sessionDir, 'test.jsonl'), 'test', 'utf-8');

      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'pi', path: sessionDir,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionId);
      await expect(fs.stat(sessionDir)).rejects.toThrow();
    });

    it('should delete a Claude session JSONL file', async () => {
      const sessionId = 'old-claude-archived';
      const claudeDir = path.join(tmpDir, 'claude-sessions');
      await fs.mkdir(claudeDir, { recursive: true });
      const jsonlFile = path.join(claudeDir, `${sessionId}.jsonl`);
      await fs.writeFile(jsonlFile, 'test-data', 'utf-8');

      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'claude', path: jsonlFile,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService({ archiveRetentionMs: 90 * 24 * 60 * 60 * 1000 });
      service.bindRuntimes({
        multiSessionManager: makeMultiSessionManager(),
        claudeService: makeClaudeService(),
        opencodeService: makeOpenCodeService(),
      });

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      await expect(fs.stat(jsonlFile)).rejects.toThrow();
    });

    it('should NOT delete an archived session within 90 days', async () => {
      const sessionId = 'recent-archived';
      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'opencode', path: sessionId,
        lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).not.toContain(sessionId);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toContain(sessionId);
    });

    it('should NOT delete sessions that are not archived', async () => {
      const sessionId = 'not-archived-old';
      await writePrefs({ archivedSessionPaths: [], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'pi', path: `/sessions/${sessionId}`,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).not.toContain(sessionId);
    });

    it('should clean up stale archived entries with no registry entry and no files on disk', async () => {
      const ghostSession = 'ghost-no-registry-no-files';
      await writePrefs({ archivedSessionPaths: [ghostSession], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(ghostSession);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(ghostSession);
    });

    it('should NOT remove archived entries not in registry if files still exist on disk', async () => {
      const piSessionDir = path.join(tmpDir, 'pi-sessions', '--root-test--');
      await fs.mkdir(piSessionDir, { recursive: true });
      const sessionFile = path.join(piSessionDir, '2026-01-01T00-00-00-000Z_test.jsonl');
      await fs.writeFile(sessionFile, 'test', 'utf-8');

      await writePrefs({ archivedSessionPaths: [sessionFile], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).not.toContain(sessionFile);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toContain(sessionFile);
    });

    it('should also remove from pinnedSessionPaths when deleting', async () => {
      const sessionId = 'pinned-and-archived-old';
      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [sessionId] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'opencode', path: sessionId,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionId);
      expect(prefs.pinnedSessionPaths).not.toContain(sessionId);
    });

    it('should report errors when deletion fails', async () => {
      const sessionId = 'error-deletion';
      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'pi', path: '/nonexistent/path',
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const { getSessionRegistry } = await import('../../src/session-registry.js');
      const origDelete = getSessionRegistry().delete;
      getSessionRegistry().delete = vi.fn(async () => { throw new Error('Registry delete failed'); });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].sessionId).toBe(sessionId);

      getSessionRegistry().delete = origDelete;
    });

    it('should handle OpenCode sessions (no local files to delete)', async () => {
      const sessionId = 'old-opencode-archived';
      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'opencode', path: sessionId,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      expect(result.errors).toEqual([]);
    });
  });

  describe('combined scenarios', () => {
    it('should handle both unpin and delete in the same run', async () => {
      const oldPinned = 'old-pinned';
      const oldArchived = 'old-archived';
      const recentPinned = 'recent-pinned';

      await writePrefs({
        pinnedSessionPaths: [oldPinned, recentPinned],
        archivedSessionPaths: [oldArchived],
      });

      mockRegistryEntries.set(oldPinned, {
        id: oldPinned, sdkType: 'pi', path: `/sessions/${oldPinned}`,
        lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });
      mockRegistryEntries.set(recentPinned, {
        id: recentPinned, sdkType: 'pi', path: `/sessions/${recentPinned}`,
        lastActivity: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'idle',
      });
      mockRegistryEntries.set(oldArchived, {
        id: oldArchived, sdkType: 'opencode', path: oldArchived,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.unpinned).toContain(oldPinned);
      expect(result.unpinned).not.toContain(recentPinned);
      expect(result.deleted).toContain(oldArchived);
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop cleanly', () => {
      const service = makeService();
      service.start();
      service.stop();
    });

    it('should not start twice', () => {
      const service = makeService();
      service.start();
      service.start();
      service.stop();
    });

    it('should be safe to stop without starting', () => {
      const service = makeService();
      service.stop();
    });
  });

  describe('defaults', () => {
    it('should export correct default constants', async () => {
      const { DEFAULT_PIN_INACTIVITY_MS: pinMs, DEFAULT_ARCHIVE_RETENTION_MS: archMs } = await import('../../src/session-cleanup.js');
      expect(pinMs).toBe(24 * 60 * 60 * 1000);
      expect(archMs).toBe(90 * 24 * 60 * 60 * 1000);
    });
  });

  describe('robustness', () => {
    it('should write prefs only once after batch-deleting multiple sessions', async () => {
      const ids = ['batch-1', 'batch-2', 'batch-3'];
      await writePrefs({
        archivedSessionPaths: ids,
        pinnedSessionPaths: [],
      });

      for (const id of ids) {
        mockRegistryEntries.set(id, {
          id, sdkType: 'opencode', path: id,
          lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
        });
      }

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toHaveLength(3);

      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toEqual([]);
    });

    it('should preserve non-deleted archived sessions during batch delete', async () => {
      const oldId = 'batch-old';
      const recentId = 'batch-recent';
      await writePrefs({
        archivedSessionPaths: [oldId, recentId],
        pinnedSessionPaths: [],
      });

      mockRegistryEntries.set(oldId, {
        id: oldId, sdkType: 'opencode', path: oldId,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });
      mockRegistryEntries.set(recentId, {
        id: recentId, sdkType: 'opencode', path: recentId,
        lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toEqual([oldId]);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toEqual([recentId]);
    });

    it('should not lose prefs data when a deletion errors mid-batch', async () => {
      const okId = 'batch-ok';
      const errId = 'batch-err';
      const keepId = 'batch-keep';
      await writePrefs({
        archivedSessionPaths: [okId, errId, keepId],
        pinnedSessionPaths: [],
      });

      mockRegistryEntries.set(okId, {
        id: okId, sdkType: 'opencode', path: okId,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });
      mockRegistryEntries.set(errId, {
        id: errId, sdkType: 'pi', path: '/nonexistent/dir',
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });
      mockRegistryEntries.set(keepId, {
        id: keepId, sdkType: 'opencode', path: keepId,
        lastActivity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const { getSessionRegistry } = await import('../../src/session-registry.js');
      const origDelete = getSessionRegistry().delete;
      let deleteCallCount = 0;
      getSessionRegistry().delete = vi.fn(async (id: string) => {
        deleteCallCount++;
        if (id === errId) throw new Error('Registry delete failed');
        mockRegistryEntries.delete(id);
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      getSessionRegistry().delete = origDelete;

      expect(result.deleted).toContain(okId);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].sessionId).toBe(errId);

      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toContain(errId);
      expect(prefs.archivedSessionPaths).toContain(keepId);
      expect(prefs.archivedSessionPaths).not.toContain(okId);
    });
  });

  describe('antigravity cleanup', () => {
    it('should delete archived Antigravity session JSONL and agy logs', async () => {
      const sessionId = 'old-antigravity-archived';
      const agDir = path.join(tmpDir, 'antigravity-sessions');
      const logsDir = path.join(agDir, 'agy-logs');
      await fs.mkdir(logsDir, { recursive: true });

      const jsonlFile = path.join(agDir, `${sessionId}.jsonl`);
      const logFile = path.join(logsDir, `${sessionId}-1780000000000-abc.log`);
      const otherLogFile = path.join(logsDir, 'other-session-1780000000000-abc.log');
      await fs.writeFile(jsonlFile, 'turn\n', 'utf-8');
      await fs.writeFile(logFile, 'agy output', 'utf-8');
      await fs.writeFile(otherLogFile, 'other output', 'utf-8');

      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'antigravity', path: sessionId,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const antigravity = makeAntigravityService();
      const service = makeService();
      bindAll(service, { antigravity });

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      await expect(fs.stat(jsonlFile)).rejects.toThrow();
      await expect(fs.stat(logFile)).rejects.toThrow();
      await expect(fs.stat(otherLogFile)).resolves.toBeDefined();
      expect(antigravity.unpinSession).toHaveBeenCalledWith(sessionId);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionId);
    });

    it('should delete archived Antigravity session even when logs dir is missing', async () => {
      const sessionId = 'old-antigravity-no-logs';
      const agDir = path.join(tmpDir, 'antigravity-sessions');
      await fs.mkdir(agDir, { recursive: true });

      const jsonlFile = path.join(agDir, `${sessionId}.jsonl`);
      await fs.writeFile(jsonlFile, 'turn\n', 'utf-8');

      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });
      mockRegistryEntries.set(sessionId, {
        id: sessionId, sdkType: 'antigravity', path: sessionId,
        lastActivity: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(), status: 'idle',
      });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      await expect(fs.stat(jsonlFile)).rejects.toThrow();
    });
  });

  describe('pi path mismatch cleanup', () => {
    it('should delete archived Pi file path based on file mtime even when inside an active directory', async () => {
      const sessionDir = path.join(tmpDir, 'pi-sessions', '--root--');
      const sessionFile = path.join(sessionDir, '2026-03-01T00-00-00-000Z_old.jsonl');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(sessionFile, '{"type":"session","id":"pi-session-id"}\n', 'utf-8');
      const oldMtime = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
      await fs.utimes(sessionFile, oldMtime, oldMtime);

      // Registry stores the directory with a recent lastActivity (other sessions
      // in the same cwd are still active). The archived file itself is old.
      const dirEntryId = 'pi-dir-entry';
      mockRegistryEntries.set(dirEntryId, {
        id: dirEntryId,
        sdkType: 'pi',
        path: sessionDir,
        lastActivity: new Date().toISOString(),
        status: 'idle',
      });

      // UI archive stores the full file path
      await writePrefs({ archivedSessionPaths: [sessionFile], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionFile);
      await expect(fs.stat(sessionFile)).rejects.toThrow();
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionFile);
    });

    it('should delete orphan archived Pi file with no registry entry when file mtime is old', async () => {
      const sessionDir = path.join(tmpDir, 'pi-sessions', '--root--');
      const sessionFile = path.join(sessionDir, '2026-03-01T00-00-00-000Z_orphan.jsonl');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(sessionFile, '{"type":"session","id":"orphan"}\n', 'utf-8');
      // Set mtime to >90 days ago
      const oldMtime = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
      await fs.utimes(sessionFile, oldMtime, oldMtime);

      await writePrefs({ archivedSessionPaths: [sessionFile], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionFile);
      await expect(fs.stat(sessionFile)).rejects.toThrow();
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionFile);
    });

    it('should NOT delete orphan archived Pi file when file mtime is recent', async () => {
      const sessionDir = path.join(tmpDir, 'pi-sessions', '--root--');
      const sessionFile = path.join(sessionDir, '2026-06-01T00-00-00-000Z_recent.jsonl');
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(sessionFile, '{"type":"session","id":"recent"}\n', 'utf-8');

      await writePrefs({ archivedSessionPaths: [sessionFile], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).not.toContain(sessionFile);
      await expect(fs.stat(sessionFile)).resolves.toBeDefined();
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toContain(sessionFile);
    });
  });

  describe('orphan runtime file cleanup', () => {
    it('should delete orphan archived Claude JSONL file with no registry entry when mtime is old', async () => {
      const sessionId = 'orphan-claude-old';
      const claudeDir = path.join(tmpDir, 'claude-sessions');
      await fs.mkdir(claudeDir, { recursive: true });
      const jsonlFile = path.join(claudeDir, `${sessionId}.jsonl`);
      await fs.writeFile(jsonlFile, 'claude data', 'utf-8');
      const oldMtime = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
      await fs.utimes(jsonlFile, oldMtime, oldMtime);

      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      await expect(fs.stat(jsonlFile)).rejects.toThrow();
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionId);
    });

    it('should delete orphan archived Antigravity JSONL file with no registry entry when mtime is old', async () => {
      const sessionId = 'orphan-antigravity-old';
      const agDir = path.join(tmpDir, 'antigravity-sessions');
      await fs.mkdir(agDir, { recursive: true });
      const jsonlFile = path.join(agDir, `${sessionId}.jsonl`);
      await fs.writeFile(jsonlFile, 'turn', 'utf-8');
      const oldMtime = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
      await fs.utimes(jsonlFile, oldMtime, oldMtime);

      await writePrefs({ archivedSessionPaths: [sessionId], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(sessionId);
      await expect(fs.stat(jsonlFile)).rejects.toThrow();
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).not.toContain(sessionId);
    });

    it('should clean stale archived entries whose files are already gone', async () => {
      const ghostPi = '/nonexistent/pi-session.jsonl';
      const ghostClaude = 'ghost-claude-id';
      await writePrefs({ archivedSessionPaths: [ghostPi, ghostClaude], pinnedSessionPaths: [] });

      const service = makeService();
      bindAll(service);

      const result = await service.runCleanup(prefsPath);

      expect(result.deleted).toContain(ghostPi);
      expect(result.deleted).toContain(ghostClaude);
      const prefs = await readPrefs();
      expect(prefs.archivedSessionPaths).toEqual([]);
    });
  });
});

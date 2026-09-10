import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { archiveStaleDiscoveredSession, DEFAULT_DISCOVERY_ARCHIVE_MS, SessionCleanupService } from '../../src/session-cleanup.js';

const mockRegistryEntries: Map<string, any> = new Map();
const mockRegistry = {
  get: vi.fn(async (id: string) => mockRegistryEntries.get(id)),
  getByPath: vi.fn(async (p: string) => {
    for (const e of mockRegistryEntries.values()) {
      if (e.path === p) return e;
    }
    return undefined;
  }),
  getByClaudeSessionId: vi.fn(async () => undefined),
  getByOpencodeSessionId: vi.fn(async () => undefined),
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
    sessionDir: '/tmp/test-pi-agent/sessions',
    claudeSessionDir: '/tmp/test-claude-sessions',
    antigravitySessionDir: '/tmp/test-antigravity-sessions',
    sessionRegistryPath: '/tmp/test-session-registry.json',
    webUiPrefsPath: '/tmp/test-web-ui-prefs.json',
    sessionAutoArchiveDays: 30,
    sessionCleanupDryRun: false,
    sessionRetentionMinDwellDays: 7,
    sessionDiscoveryArchiveDays: 14,
  },
}));

/**
 * Native-discovery hygiene (plan Phase 3): a pi CLI session the watcher
 * discovers on disk AFTER the fact (origin 'native-discovered') that is
 * already older than the discovery threshold must be flagged archived upon
 * discovery, so hundreds of historical CLI sessions never flood the sidebar's
 * active list. Also pins the funnel's native-path keying (toV2Key on a pi
 * file path → `pi:<basename>` with the full path as legacyKey).
 */

const DAY = 24 * 60 * 60 * 1000;

describe('archiveStaleDiscoveredSession (discovery hygiene)', () => {
  let tmpDir: string;
  let prefsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-discovery-'));
    prefsPath = path.join(tmpDir, 'web-ui-prefs.json');
    mockRegistryEntries.clear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function readPrefs(): Promise<{ sessions: Record<string, any> }> {
    const raw = await fs.readFile(prefsPath, 'utf8');
    return JSON.parse(raw);
  }

  it('archives a stale discovered pi session under its stable v2 key with the path as legacyKey', async () => {
    const sessionPath = path.join(
      tmpDir, 'sessions', '--tmp-w--',
      '2026-08-01T00-00-00_3f9d2c8a-1b2c-4d5e-8f90-1a2b3c4d5e6f.jsonl',
    );
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, '{}');

    const stamped = await archiveStaleDiscoveredSession({
      sessionPath,
      lastActivityMs: Date.now() - 20 * DAY,
      prefsPath,
    });
    expect(stamped).toBe(true);
    const prefs = await readPrefs();
    const rec = prefs.sessions['pi:3f9d2c8a-1b2c-4d5e-8f90-1a2b3c4d5e6f'];
    expect(rec?.archived).toBe(true);
    expect(rec?.archivedAt).toBeTypeOf('number');
    expect(rec?.legacyKey).toBe(sessionPath);
  });

  it('ignores fresh discoveries (inside the 14-day default threshold)', async () => {
    expect(DEFAULT_DISCOVERY_ARCHIVE_MS).toBe(14 * DAY);
    const stamped = await archiveStaleDiscoveredSession({
      sessionPath: '/sessions/x/2026-09-09T00-00-00_fresh.jsonl',
      lastActivityMs: Date.now() - 2 * DAY,
      prefsPath,
    });
    expect(stamped).toBe(false);
    // Nothing was written for a fresh session (no prefs file materialised).
    await expect(fs.readFile(prefsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overrides an explicit pin and never re-stamps an archived record', async () => {
    const sessionPath = '/sessions/y/5f0e8d7c-6a5b-4c3d-9e2f-0a1b2c3d4e5f.jsonl';
    const v2Key = 'pi:5f0e8d7c-6a5b-4c3d-9e2f-0a1b2c3d4e5f';
    await fs.writeFile(prefsPath, JSON.stringify({
      version: 2,
      sessions: { [v2Key]: { pinned: true, legacyKey: sessionPath } },
    }));
    const pinned = await archiveStaleDiscoveredSession({
      sessionPath, lastActivityMs: Date.now() - 60 * DAY, prefsPath,
    });
    expect(pinned).toBe(false);
    const prefs = await readPrefs();
    expect(prefs.sessions[v2Key].archived).toBeUndefined();

    await fs.writeFile(prefsPath, JSON.stringify({
      version: 2,
      sessions: { [v2Key]: { archived: true, archivedAt: 123, legacyKey: sessionPath } },
    }));
    const again = await archiveStaleDiscoveredSession({
      sessionPath, lastActivityMs: Date.now() - 60 * DAY, prefsPath,
    });
    expect(again).toBe(false);
    const prefs2 = await readPrefs();
    expect(prefs2.sessions[v2Key].archivedAt).toBe(123); // original stamp preserved
  });

  it('threshold <= 0 disables discovery archiving entirely', async () => {
    const stamped = await archiveStaleDiscoveredSession({
      sessionPath: '/sessions/z/ancient.jsonl',
      lastActivityMs: Date.now() - 365 * DAY,
      thresholdMs: 0,
      prefsPath,
    });
    expect(stamped).toBe(false);
  });
});

describe('cleanup funnel keys native-discovered pi sessions correctly (regression pin)', () => {
  let tmpDir: string;
  let prefsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-funnel-'));
    prefsPath = path.join(tmpDir, 'web-ui-prefs.json');
    mockRegistryEntries.clear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('autoArchiveInactiveSessions archives a stale native-discovered pi file path under pi:<basename>', async () => {
    const sessionPath = '/tmp/test-pi-agent/sessions/--tmp-w--/2026-07-01T00-00-00_7c2a9b1e-0f3d-4a8b-b6c5-e9d0f1a2b3c4.jsonl';
    mockRegistryEntries.set('7c2a9b1e-0f3d-4a8b-b6c5-e9d0f1a2b3c4', {
      id: '7c2a9b1e-0f3d-4a8b-b6c5-e9d0f1a2b3c4', sdkType: 'pi', path: sessionPath,
      lastActivity: new Date(Date.now() - 45 * DAY).toISOString(),
      origin: 'native-discovered',
    });
    const cleanup = new SessionCleanupService({ autoArchiveMs: 30 * DAY, dryRun: false });
    const result = await cleanup.runCleanup(prefsPath);
    expect(result.autoArchived).toContain(sessionPath);
    const prefs = JSON.parse(await fs.readFile(prefsPath, 'utf8'));
    const rec = prefs.sessions['pi:7c2a9b1e-0f3d-4a8b-b6c5-e9d0f1a2b3c4'];
    expect(rec?.archived).toBe(true);
    expect(rec?.legacyKey).toBe(sessionPath);
  });
});

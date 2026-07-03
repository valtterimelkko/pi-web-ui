import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import { config } from '../config.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createLogger } from '../logging/logger.js';
import { getSessionRegistry } from '../session-registry.js';
import {
  type PreferencesV2,
  type SessionMeta,
  type SessionRuntime,
  type RuntimeResolver,
  piSessionIdFromPath,
  toV2Key,
  migrateV1ToV2,
  deriveLegacyArrays,
  isV2,
  applyLWW,
} from './session-meta.js';

const logger = createLogger('Preferences');

const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

export const PREFS_FILE = path.join(config.piAgentDir, 'web-ui-prefs.json');

// ── Schemas ─────────────────────────────────────────────────────────────────
// Disk accepts both v2 (sessions map) and legacy v1 (parallel arrays). On read,
// v1 is migrated to v2 once (see readPreferences). GET returns v2 plus the v1
// arrays DERIVED from it, so older client bundles keep working (compat window).

const SessionMetaSchema = z.object({
  archived: z.literal(true).optional(),
  pinned: z.literal(true).optional(),
  displayName: z.string().optional(),
  updatedAt: z.number().optional(),
  legacyKey: z.string().optional(),
}).passthrough();

const V2Schema = z.object({
  version: z.literal(2),
  sessions: z.record(z.string(), SessionMetaSchema),
}).passthrough();

const V1Schema = z.object({
  archivedSessionPaths: z.array(z.string()).optional(),
  pinnedSessionPaths: z.array(z.string()).optional(),
  sessionDisplayNames: z.record(z.string(), z.string()).optional(),
}).passthrough();

/** Canonical internal type: the v2 keyed model. */
export type Preferences = PreferencesV2;
export type { SessionMeta, SessionRuntime } from './session-meta.js';

const SessionPathSchema = z.object({ sessionPath: z.string().min(1).max(4096) });
const ArchiveAllSchema = z.object({
  sessionPaths: z.array(z.string().min(1).max(4096)).max(100000),
});
// Single-key display-name delta: set a name, or clear it (name === null / empty).
const DisplayNameSchema = z.object({
  sessionPath: z.string().min(1).max(4096),
  name: z.union([z.string().max(4096), z.null()]).optional(),
});
// New key-based delta (Phase 2 clients send the stable runtime:id key directly).
const SessionKeySchema = z.object({ key: z.string().min(1).max(4096) });
const DisplayNameKeySchema = z.object({
  key: z.string().min(1).max(4096),
  name: z.union([z.string().max(4096), z.null()]).optional(),
});

class PreferencesMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve();
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

const prefsMutex = new PreferencesMutex();

/** Build a SYNCHRONOUS runtime resolver from the (async) registry, so the pure
 *  migration/key functions can stay sync & deterministic. Maps id/path and the
 *  per-runtime sub-ids of every registry entry to its sdkType. */
async function buildRegistryResolver(): Promise<RuntimeResolver> {
  let entries: Array<{ id?: string; path?: string; sdkType?: string; claudeSessionId?: string; opencodeSessionId?: string }> = [];
  try {
    entries = await getSessionRegistry().listAll();
  } catch {
    entries = [];
  }
  const map = new Map<string, SessionRuntime>();
  for (const e of entries) {
    const rt = (e.sdkType ?? 'unknown') as SessionRuntime;
    if (e.id) map.set(e.id, rt);
    if (e.path) map.set(e.path, rt);
    if (e.claudeSessionId) map.set(e.claudeSessionId, rt);
    if (e.opencodeSessionId) map.set(e.opencodeSessionId, rt);
  }
  return (id: string) => (map.get(id) as SessionRuntime | undefined) ?? null;
}

export const EMPTY_PREFERENCES: Preferences = { version: 2, sessions: {} };

export async function readPreferences(filePath = PREFS_FILE): Promise<Preferences> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return EMPTY_PREFERENCES;
    logger.error(
      `[Preferences] Corrupt prefs file (${filePath}), treating as empty:`,
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY_PREFERENCES;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.error(`[Preferences] Unparseable prefs (${filePath}), treating as empty:`, err instanceof Error ? err.message : String(err));
    return EMPTY_PREFERENCES;
  }

  if (isV2(parsed)) {
    try {
      return V2Schema.parse(parsed) as Preferences;
    } catch (err) {
      logger.error(`[Preferences] Invalid v2 prefs (${filePath}), treating as empty:`, err instanceof Error ? err.message : String(err));
      return EMPTY_PREFERENCES;
    }
  }

  // v1 → migrate once, atomically, with a .bak for reversibility.
  try {
    const v1 = V1Schema.parse(parsed);
    const resolver = await buildRegistryResolver();
    const v2 = migrateV1ToV2(v1, resolver, Date.now());
    try {
      await fs.copyFile(filePath, filePath + '.v1.bak');
    } catch {
      /* best-effort backup */
    }
    await writePreferences(v2, filePath);
    const legacy = deriveLegacyArrays(v2);
    logger.info(
      `[Preferences] Migrated v1→v2 at ${filePath} (.v1.bak saved): ` +
        `${legacy.archivedSessionPaths.length} archived, ${legacy.pinnedSessionPaths.length} pinned, ` +
        `${Object.keys(legacy.sessionDisplayNames).length} display names → ${Object.keys(v2.sessions).length} records`,
    );
    return v2;
  } catch (err) {
    logger.error(`[Preferences] v1→v2 migration failed (${filePath}), treating as empty:`, err instanceof Error ? err.message : String(err));
    return EMPTY_PREFERENCES;
  }
}

export async function writePreferences(prefs: Preferences, filePath = PREFS_FILE): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = filePath + '.tmp';
  await fs.writeFile(tmpFile, JSON.stringify(prefs, null, 2), 'utf-8');
  await fs.rename(tmpFile, filePath);
}

export async function withPrefsLock<T>(
  fn: (read: () => Promise<Preferences>, write: (prefs: Preferences) => Promise<void>) => Promise<T>,
  filePath = PREFS_FILE,
): Promise<T> {
  await prefsMutex.acquire();
  try {
    let cached: Preferences | undefined;
    const read = async (): Promise<Preferences> => {
      if (!cached) cached = await readPreferences(filePath);
      return cached;
    };
    const write = async (prefs: Preferences): Promise<void> => {
      cached = prefs;
      await writePreferences(prefs, filePath);
    };
    return await fn(read, write);
  } finally {
    prefsMutex.release();
  }
}

/** Resolve a session path (Pi path or bare id) to its stable v2 key. */
async function pathToKey(sessionPath: string): Promise<string> {
  return toV2Key(sessionPath, await buildRegistryResolver()).key;
}

/** Mark a record field, bumping updatedAt (LWW) and preserving legacyKey. */
function setField(
  sessions: Record<string, SessionMeta>,
  key: string,
  patch: Partial<SessionMeta>,
  legacyKey: string,
  now: number,
): void {
  const stored = sessions[key];
  const incoming: SessionMeta = { ...patch, updatedAt: now, legacyKey };
  const { record } = applyLWW(stored, incoming);
  sessions[key] = record;
}

/** Drop a field from a record (unarchive/unpin/clear-name). */
function clearField(
  sessions: Record<string, SessionMeta>,
  key: string,
  field: 'archived' | 'pinned' | 'displayName',
  legacyKey: string,
  now: number,
): void {
  const stored = sessions[key];
  if (!stored) return;
  const next: SessionMeta = { ...stored };
  delete next[field];
  next.updatedAt = now;
  next.legacyKey = legacyKey;
  sessions[key] = next;
}

/**
 * Atomically add a single session path to the archive (delta, keepalive-safe).
 * Archiving auto-unpins: an archived session must not consume a pin slot.
 */
export async function addArchivedPath(sessionPath: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const key = await pathToKey(sessionPath);
    const now = Date.now();
    setField(prefs.sessions, key, { archived: true }, sessionPath, now);
    // auto-unpin invariant
    if (prefs.sessions[key]?.pinned) clearField(prefs.sessions, key, 'pinned', sessionPath, now);
    await write(prefs);
    return prefs;
  }, filePath);
}

/** Atomically remove a single session path from the archive (delta unarchive). */
export async function removeArchivedPath(sessionPath: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const key = await pathToKey(sessionPath);
    clearField(prefs.sessions, key, 'archived', sessionPath, Date.now());
    await write(prefs);
    return prefs;
  }, filePath);
}

/**
 * Atomically archive many sessions at once (union with the existing archive).
 * Used by "Archive all" (a deliberate, foreground, non-keepalive request).
 */
export async function addArchivedPaths(sessionPaths: string[], filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const resolver = await buildRegistryResolver();
    const now = Date.now();
    const archivedKeys = new Set<string>();
    for (const p of sessionPaths) {
      const key = toV2Key(p, resolver).key;
      setField(prefs.sessions, key, { archived: true }, p, now);
      archivedKeys.add(key);
    }
    // auto-unpin every archived session
    for (const key of archivedKeys) {
      if (prefs.sessions[key]?.pinned) clearField(prefs.sessions, key, 'pinned', prefs.sessions[key]!.legacyKey ?? key, now);
    }
    await write(prefs);
    return prefs;
  }, filePath);
}

/** Atomically add a single session path to the pinned set (delta pin). */
export async function addPinnedPath(sessionPath: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const key = await pathToKey(sessionPath);
    setField(prefs.sessions, key, { pinned: true }, sessionPath, Date.now());
    await write(prefs);
    return prefs;
  }, filePath);
}

/** Atomically remove a single session path from the pinned set (delta unpin). */
export async function removePinnedPath(sessionPath: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const key = await pathToKey(sessionPath);
    clearField(prefs.sessions, key, 'pinned', sessionPath, Date.now());
    await write(prefs);
    return prefs;
  }, filePath);
}

/** Atomically set or clear a single session's display name (delta rename). */
export async function setDisplayName(
  sessionPath: string,
  name: string | null,
  filePath = PREFS_FILE,
): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const key = await pathToKey(sessionPath);
    const trimmed = typeof name === 'string' ? name.trim() : '';
    const now = Date.now();
    if (trimmed) setField(prefs.sessions, key, { displayName: trimmed }, sessionPath, now);
    else clearField(prefs.sessions, key, 'displayName', sessionPath, now);
    await write(prefs);
    return prefs;
  }, filePath);
}

// Key-based variants (Phase 2 clients send the stable runtime:id key directly,
// avoiding the registry round-trip and staying immune to path changes).
export async function addArchivedKey(key: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const now = Date.now();
    setField(prefs.sessions, key, { archived: true }, key, now);
    if (prefs.sessions[key]?.pinned) clearField(prefs.sessions, key, 'pinned', key, now);
    await write(prefs);
    return prefs;
  }, filePath);
}

export async function removeArchivedKey(key: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    clearField(prefs.sessions, key, 'archived', key, Date.now());
    await write(prefs);
    return prefs;
  }, filePath);
}

export async function addPinnedKey(key: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    setField(prefs.sessions, key, { pinned: true }, key, Date.now());
    await write(prefs);
    return prefs;
  }, filePath);
}

export async function removePinnedKey(key: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    clearField(prefs.sessions, key, 'pinned', key, Date.now());
    await write(prefs);
    return prefs;
  }, filePath);
}

export async function setDisplayNameKey(
  key: string,
  name: string | null,
  filePath = PREFS_FILE,
): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const prefs = await read();
    const trimmed = typeof name === 'string' ? name.trim() : '';
    const now = Date.now();
    if (trimmed) setField(prefs.sessions, key, { displayName: trimmed }, key, now);
    else clearField(prefs.sessions, key, 'displayName', key, now);
    await write(prefs);
    return prefs;
  }, filePath);
}

/** Response shape for GET / delta endpoints: v2 + derived legacy arrays. */
function withLegacy(prefs: Preferences) {
  return { ...prefs, ...deriveLegacyArrays(prefs) };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const prefs = await readPreferences();
    res.json(withLegacy(prefs));
  } catch (error) {
    logger.error('Error reading preferences:', error);
    res.status(500).json({ error: 'Failed to read preferences' });
  }
});

// Whole-object PATCH (legacy/compat). Accepts v1 arrays and merges them into the
// v2 map (each supplied entry mapped to its stable key with LWW). New clients
// use the per-item delta endpoints instead.
router.patch('/', async (req: Request, res: Response) => {
  try {
    const parsed = V1Schema.parse(req.body);
    const merged = await withPrefsLock(async (read, write) => {
      const prefs = await read();
      const resolver = await buildRegistryResolver();
      const incoming = migrateV1ToV2(parsed, resolver, Date.now());
      for (const [key, rec] of Object.entries(incoming.sessions)) {
        prefs.sessions[key] = applyLWW(prefs.sessions[key], rec).record;
      }
      await write(prefs);
      return prefs;
    });
    res.json(withLegacy(merged));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid preferences', details: error.errors });
      return;
    }
    logger.error('Error writing preferences:', error);
    res.status(500).json({ error: 'Failed to write preferences' });
  }
});

// ── Delta endpoints (path-based, Phase 1 compat + keepalive-safe) ───────────
router.post('/archive', async (req: Request, res: Response) => {
  try {
    const { sessionPath } = SessionPathSchema.parse(req.body);
    res.json(withLegacy(await addArchivedPath(sessionPath)));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid archive request', details: error.errors }); return; }
    logger.error('Error archiving session:', error);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

router.post('/unarchive', async (req: Request, res: Response) => {
  try {
    const { sessionPath } = SessionPathSchema.parse(req.body);
    res.json(withLegacy(await removeArchivedPath(sessionPath)));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid unarchive request', details: error.errors }); return; }
    logger.error('Error unarchiving session:', error);
    res.status(500).json({ error: 'Failed to unarchive session' });
  }
});

router.post('/archive-all', async (req: Request, res: Response) => {
  try {
    const { sessionPaths } = ArchiveAllSchema.parse(req.body);
    res.json(withLegacy(await addArchivedPaths(sessionPaths)));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid archive-all request', details: error.errors }); return; }
    logger.error('Error archiving all sessions:', error);
    res.status(500).json({ error: 'Failed to archive all sessions' });
  }
});

router.post('/pin', async (req: Request, res: Response) => {
  try {
    if (req.body && typeof req.body === 'object' && 'key' in req.body) {
      const { key } = SessionKeySchema.parse(req.body);
      res.json(withLegacy(await addPinnedKey(key)));
      return;
    }
    const { sessionPath } = SessionPathSchema.parse(req.body);
    res.json(withLegacy(await addPinnedPath(sessionPath)));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid pin request', details: error.errors }); return; }
    logger.error('Error pinning session:', error);
    res.status(500).json({ error: 'Failed to pin session' });
  }
});

router.post('/unpin', async (req: Request, res: Response) => {
  try {
    if (req.body && typeof req.body === 'object' && 'key' in req.body) {
      const { key } = SessionKeySchema.parse(req.body);
      res.json(withLegacy(await removePinnedKey(key)));
      return;
    }
    const { sessionPath } = SessionPathSchema.parse(req.body);
    res.json(withLegacy(await removePinnedPath(sessionPath)));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid unpin request', details: error.errors }); return; }
    logger.error('Error unpinning session:', error);
    res.status(500).json({ error: 'Failed to unpin session' });
  }
});

router.post('/display-name', async (req: Request, res: Response) => {
  try {
    if (req.body && typeof req.body === 'object' && 'key' in req.body) {
      const { key, name } = DisplayNameKeySchema.parse(req.body);
      res.json(withLegacy(await setDisplayNameKey(key, name ?? null)));
      return;
    }
    const { sessionPath, name } = DisplayNameSchema.parse(req.body);
    res.json(withLegacy(await setDisplayName(sessionPath, name ?? null)));
  } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid display-name request', details: error.errors }); return; }
    logger.error('Error setting display name:', error);
    res.status(500).json({ error: 'Failed to set display name' });
  }
});

export { deriveLegacyArrays, migrateV1ToV2, isV2, parseV2Key } from './session-meta.js';
export default router;

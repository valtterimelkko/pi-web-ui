import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import { config } from '../config.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Preferences');


const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

export const PREFS_FILE = path.join(config.piAgentDir, 'web-ui-prefs.json');

const PreferencesSchema = z.object({
  archivedSessionPaths: z.array(z.string()).optional(),
  pinnedSessionPaths: z.array(z.string()).optional(),
  sessionDisplayNames: z.record(z.string(), z.string()).optional(),
}).passthrough();

export type Preferences = z.infer<typeof PreferencesSchema>;

const SessionPathSchema = z.object({ sessionPath: z.string().min(1).max(4096) });
const ArchiveAllSchema = z.object({
  sessionPaths: z.array(z.string().min(1).max(4096)).max(100000),
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

export async function readPreferences(filePath = PREFS_FILE): Promise<Preferences> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return PreferencesSchema.parse(JSON.parse(content));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { archivedSessionPaths: [] };
    }
    logger.error(
      `[Preferences] Corrupt prefs file (${filePath}), treating as empty:`,
      err instanceof Error ? err.message : String(err),
    );
    return { archivedSessionPaths: [] };
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

/**
 * Atomically add a single session path to the archive.
 *
 * This is a *delta* mutation: the request body is one path, not the whole
 * array. That matters because the browser rejects `fetch(..., { keepalive:
 * true })` when the combined in-flight keepalive body size exceeds 64 KiB.
 * Sending the entire (tens-of-KB) archivedSessionPaths array on every archive
 * meant concurrent archives — and, once the array grew large enough, even a
 * single one — silently failed to reach the server and vanished on reload.
 * A per-path delta keeps every write tiny and keepalive-safe, and the mutex
 * makes it race-free without last-write-wins clobbering.
 *
 * Archiving also auto-unpins: an archived session should not consume a pin slot.
 */
export async function addArchivedPath(sessionPath: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const current = await read();
    const archived = current.archivedSessionPaths ?? [];
    const nextArchived = archived.includes(sessionPath) ? archived : [...archived, sessionPath];
    const nextPinned = (current.pinnedSessionPaths ?? []).filter((p) => p !== sessionPath);
    const result: Preferences = { ...current, archivedSessionPaths: nextArchived, pinnedSessionPaths: nextPinned };
    await write(result);
    return result;
  }, filePath);
}

/** Atomically remove a single session path from the archive (delta unarchive). */
export async function removeArchivedPath(sessionPath: string, filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const current = await read();
    const result: Preferences = {
      ...current,
      archivedSessionPaths: (current.archivedSessionPaths ?? []).filter((p) => p !== sessionPath),
    };
    await write(result);
    return result;
  }, filePath);
}

/**
 * Atomically archive many sessions at once (union with the existing archive).
 *
 * Used by "Archive all". This is a deliberate, foreground action (never fires
 * on page unload), so the client sends it with a normal — non-keepalive —
 * fetch; the 64 KiB keepalive limit does not apply, so a large body is fine.
 * The union preserves any already-archived path not present in the request.
 */
export async function addArchivedPaths(sessionPaths: string[], filePath = PREFS_FILE): Promise<Preferences> {
  return withPrefsLock(async (read, write) => {
    const current = await read();
    const union = Array.from(new Set([...(current.archivedSessionPaths ?? []), ...sessionPaths]));
    const archivedSet = new Set(union);
    const nextPinned = (current.pinnedSessionPaths ?? []).filter((p) => !archivedSet.has(p));
    const result: Preferences = { ...current, archivedSessionPaths: union, pinnedSessionPaths: nextPinned };
    await write(result);
    return result;
  }, filePath);
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const prefs = await readPreferences();
    res.json(prefs);
  } catch (error) {
    logger.error('Error reading preferences:', error);
    res.status(500).json({ error: 'Failed to read preferences' });
  }
});

router.patch('/', async (req: Request, res: Response) => {
  try {
    const updates = PreferencesSchema.parse(req.body);
    const merged = await withPrefsLock(async (read, write) => {
      const current = await read();
      const result: Preferences = { ...current, ...updates };
      await write(result);
      return result;
    });
    res.json(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid preferences', details: error.errors });
      return;
    }
    logger.error('Error writing preferences:', error);
    res.status(500).json({ error: 'Failed to write preferences' });
  }
});

// Delta archive mutations. These send a single path (or, for archive-all, the
// list as a normal non-keepalive request) rather than PATCHing the entire
// archivedSessionPaths array, which the browser's 64 KiB keepalive quota would
// silently reject once the array grew large enough. See addArchivedPath above.
router.post('/archive', async (req: Request, res: Response) => {
  try {
    const { sessionPath } = SessionPathSchema.parse(req.body);
    const merged = await addArchivedPath(sessionPath);
    res.json(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid archive request', details: error.errors });
      return;
    }
    logger.error('Error archiving session:', error);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

router.post('/unarchive', async (req: Request, res: Response) => {
  try {
    const { sessionPath } = SessionPathSchema.parse(req.body);
    const merged = await removeArchivedPath(sessionPath);
    res.json(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid unarchive request', details: error.errors });
      return;
    }
    logger.error('Error unarchiving session:', error);
    res.status(500).json({ error: 'Failed to unarchive session' });
  }
});

router.post('/archive-all', async (req: Request, res: Response) => {
  try {
    const { sessionPaths } = ArchiveAllSchema.parse(req.body);
    const merged = await addArchivedPaths(sessionPaths);
    res.json(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid archive-all request', details: error.errors });
      return;
    }
    logger.error('Error archiving all sessions:', error);
    res.status(500).json({ error: 'Failed to archive all sessions' });
  }
});

export default router;

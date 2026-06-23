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

export default router;

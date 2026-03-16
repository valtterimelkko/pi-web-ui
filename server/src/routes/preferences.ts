import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import { config } from '../config.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';

const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

export const PREFS_FILE = path.join(config.piAgentDir, 'web-ui-prefs.json');

const PreferencesSchema = z.object({
  archivedSessionPaths: z.array(z.string()).optional(),
  sessionDisplayNames: z.record(z.string(), z.string()).optional(),
}).passthrough(); // preserve any future/unknown keys in the file

export type Preferences = z.infer<typeof PreferencesSchema>;

export async function readPreferences(filePath = PREFS_FILE): Promise<Preferences> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return PreferencesSchema.parse(JSON.parse(content));
  } catch {
    return { archivedSessionPaths: [] };
  }
}

export async function writePreferences(prefs: Preferences, filePath = PREFS_FILE): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(prefs, null, 2), 'utf-8');
}

// GET /api/preferences
router.get('/', async (_req: Request, res: Response) => {
  try {
    const prefs = await readPreferences();
    res.json(prefs);
  } catch (error) {
    console.error('Error reading preferences:', error);
    res.status(500).json({ error: 'Failed to read preferences' });
  }
});

// PATCH /api/preferences
router.patch('/', async (req: Request, res: Response) => {
  try {
    const updates = PreferencesSchema.parse(req.body);
    const current = await readPreferences();
    const merged: Preferences = { ...current, ...updates };
    await writePreferences(merged);
    res.json(merged);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid preferences', details: error.errors });
      return;
    }
    console.error('Error writing preferences:', error);
    res.status(500).json({ error: 'Failed to write preferences' });
  }
});

export default router;

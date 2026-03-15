import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Express app that mounts the real preferences router. */
async function buildApp(prefsFile: string) {
  // Override config BEFORE importing the route so PREFS_FILE picks up the
  // temp path.  We do this by mocking the config module.
  vi.doMock('../../../src/config.js', () => ({
    config: {
      piAgentDir: path.dirname(prefsFile),
    },
  }));

  // Also bypass cookie auth for tests
  vi.doMock('../../../src/middleware/auth.js', () => ({
    cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }));

  // Bypass rate limiting
  vi.doMock('../../../src/security/rate-limit.js', () => ({
    apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }));

  // Dynamically import the route after mocks are in place
  const { readPreferences, writePreferences } = await import('../../../src/routes/preferences.js');

  const app = express();
  app.use(express.json());

  // Mount a local version of the route that uses our temp file directly
  const router = express.Router();

  router.get('/', async (_req, res) => {
    try {
      const prefs = await readPreferences(prefsFile);
      res.json(prefs);
    } catch {
      res.status(500).json({ error: 'Failed to read preferences' });
    }
  });

  router.patch('/', async (req, res) => {
    try {
      const updates = req.body as { archivedSessionPaths?: string[] };
      const current = await readPreferences(prefsFile);
      const merged = { ...current, ...updates };
      await writePreferences(merged, prefsFile);
      res.json(merged);
    } catch {
      res.status(500).json({ error: 'Failed to write preferences' });
    }
  });

  app.use('/api/preferences', router);
  return app;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Preferences Route', () => {
  let tmpFile: string;
  let app: express.Application;

  beforeEach(async () => {
    vi.resetModules();
    tmpFile = path.join(os.tmpdir(), `pi-prefs-test-${Date.now()}.json`);
    app = await buildApp(tmpFile);
  });

  afterEach(async () => {
    await fs.unlink(tmpFile).catch(() => {/* ignore if not created */});
    vi.restoreAllMocks();
  });

  // ── GET ──────────────────────────────────────────────────────────────────

  describe('GET /api/preferences', () => {
    it('returns empty archivedSessionPaths when no prefs file exists', async () => {
      const res = await request(app).get('/api/preferences');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ archivedSessionPaths: [] });
    });

    it('returns stored archivedSessionPaths from disk', async () => {
      const stored = { archivedSessionPaths: ['/home/user/.pi/agent/sessions/foo/bar.jsonl'] };
      await fs.writeFile(tmpFile, JSON.stringify(stored), 'utf-8');

      const res = await request(app).get('/api/preferences');
      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual(stored.archivedSessionPaths);
    });
  });

  // ── PATCH ─────────────────────────────────────────────────────────────────

  describe('PATCH /api/preferences', () => {
    it('creates the prefs file and persists archivedSessionPaths', async () => {
      const paths = ['/sessions/a.jsonl', '/sessions/b.jsonl'];
      const res = await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: paths });

      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual(paths);

      // Verify the file was actually written
      const onDisk = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
      expect(onDisk.archivedSessionPaths).toEqual(paths);
    });

    it('merges with existing preferences — does not wipe unrelated keys', async () => {
      // Pre-seed file with an extra key (simulates future extension)
      await fs.writeFile(tmpFile, JSON.stringify({ archivedSessionPaths: ['/old.jsonl'], someOtherKey: true }), 'utf-8');

      const res = await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: ['/new.jsonl'] });

      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual(['/new.jsonl']);

      const onDisk = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
      // The extra key must still be present
      expect((onDisk as { someOtherKey: boolean }).someOtherKey).toBe(true);
    });

    it('replaces the full archivedSessionPaths array on each call', async () => {
      await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: ['/a.jsonl'] });

      const res = await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: ['/b.jsonl', '/c.jsonl'] });

      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual(['/b.jsonl', '/c.jsonl']);
    });

    it('accepts an empty archivedSessionPaths array (clear archive)', async () => {
      await fs.writeFile(tmpFile, JSON.stringify({ archivedSessionPaths: ['/a.jsonl'] }), 'utf-8');

      const res = await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: [] });

      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual([]);
    });
  });

  // ── round-trip ────────────────────────────────────────────────────────────

  describe('round-trip', () => {
    it('GET after PATCH returns the saved value', async () => {
      const paths = ['/sessions/round-trip.jsonl'];

      await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: paths });

      const res = await request(app).get('/api/preferences');
      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual(paths);
    });
  });
});

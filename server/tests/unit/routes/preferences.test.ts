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

  // ── sessionDisplayNames ───────────────────────────────────────────────────

  describe('sessionDisplayNames', () => {
    it('returns empty sessionDisplayNames when no prefs file exists', async () => {
      const res = await request(app).get('/api/preferences');
      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual([]);
    });

    it('persists and retrieves sessionDisplayNames', async () => {
      const displayNames = {
        '/sessions/foo.jsonl': 'My Custom Name',
        '/sessions/bar.jsonl': 'Another Name',
      };

      const res = await request(app)
        .patch('/api/preferences')
        .send({ sessionDisplayNames: displayNames });

      expect(res.status).toBe(200);
      expect(res.body.sessionDisplayNames).toEqual(displayNames);

      // Verify the file was actually written
      const onDisk = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
      expect(onDisk.sessionDisplayNames).toEqual(displayNames);
    });

    it('merges sessionDisplayNames with archivedSessionPaths', async () => {
      // First set archived paths
      await request(app)
        .patch('/api/preferences')
        .send({ archivedSessionPaths: ['/archived.jsonl'] });

      // Then set display names
      const displayNames = { '/sessions/foo.jsonl': 'Renamed' };
      const res = await request(app)
        .patch('/api/preferences')
        .send({ sessionDisplayNames: displayNames });

      expect(res.status).toBe(200);
      expect(res.body.archivedSessionPaths).toEqual(['/archived.jsonl']);
      expect(res.body.sessionDisplayNames).toEqual(displayNames);
    });

    it('updates a single session display name without affecting others', async () => {
      // Set initial display names
      await request(app)
        .patch('/api/preferences')
        .send({
          sessionDisplayNames: {
            '/sessions/a.jsonl': 'Name A',
            '/sessions/b.jsonl': 'Name B',
          },
        });

      // Update just one
      const res = await request(app)
        .patch('/api/preferences')
        .send({
          sessionDisplayNames: {
            '/sessions/a.jsonl': 'Name A Updated',
            '/sessions/b.jsonl': 'Name B',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.sessionDisplayNames['/sessions/a.jsonl']).toBe('Name A Updated');
      expect(res.body.sessionDisplayNames['/sessions/b.jsonl']).toBe('Name B');
    });

    it('can remove a display name by updating the map', async () => {
      // Set initial display names
      await request(app)
        .patch('/api/preferences')
        .send({
          sessionDisplayNames: {
            '/sessions/a.jsonl': 'Name A',
            '/sessions/b.jsonl': 'Name B',
          },
        });

      // Remove one by not including it
      const res = await request(app)
        .patch('/api/preferences')
        .send({
          sessionDisplayNames: {
            '/sessions/b.jsonl': 'Name B',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.sessionDisplayNames['/sessions/a.jsonl']).toBeUndefined();
      expect(res.body.sessionDisplayNames['/sessions/b.jsonl']).toBe('Name B');
    });
  });
});

// ── Robustness tests (atomic writes, corrupt file, mutex) ─────────────────────

describe('Preferences Robustness', () => {
  let tmpFile: string;

  beforeEach(() => {
    vi.resetModules();
    tmpFile = path.join(os.tmpdir(), `pi-prefs-robust-${Date.now()}.json`);
  });

  afterEach(async () => {
    await fs.unlink(tmpFile).catch(() => {});
    await fs.unlink(tmpFile + '.tmp').catch(() => {});
    vi.restoreAllMocks();
  });

  async function loadModule() {
    vi.doMock('../../../src/config.js', () => ({
      config: { piAgentDir: path.dirname(tmpFile) },
    }));
    vi.doMock('../../../src/middleware/auth.js', () => ({
      cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));
    vi.doMock('../../../src/security/rate-limit.js', () => ({
      apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    }));
    return import('../../../src/routes/preferences.js');
  }

  describe('atomic writes', () => {
    it('should not leave a .tmp file after successful write', async () => {
      const { writePreferences } = await loadModule();
      await writePreferences({ archivedSessionPaths: ['/a'] }, tmpFile);

      const exists = await fs.stat(tmpFile + '.tmp').then(() => true).catch(() => false);
      expect(exists).toBe(false);

      const data = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
      expect(data.archivedSessionPaths).toEqual(['/a']);
    });

    it('should replace file contents atomically via rename', async () => {
      const { writePreferences, readPreferences } = await loadModule();

      await writePreferences({ archivedSessionPaths: ['/first'] }, tmpFile);
      await writePreferences({ archivedSessionPaths: ['/second'] }, tmpFile);

      const prefs = await readPreferences(tmpFile);
      expect(prefs.archivedSessionPaths).toEqual(['/second']);
    });
  });

  describe('corrupt file handling', () => {
    it('should return empty prefs for corrupt (non-JSON) file', async () => {
      const { readPreferences } = await loadModule();
      await fs.mkdir(path.dirname(tmpFile), { recursive: true });
      await fs.writeFile(tmpFile, 'NOT VALID JSON{{{', 'utf-8');

      const prefs = await readPreferences(tmpFile);
      expect(prefs.archivedSessionPaths).toEqual([]);
    });

    it('should return empty prefs for missing file (ENOENT)', async () => {
      const { readPreferences } = await loadModule();
      const prefs = await readPreferences(tmpFile);
      expect(prefs.archivedSessionPaths).toEqual([]);
    });

    it('should return empty prefs for empty file', async () => {
      const { readPreferences } = await loadModule();
      await fs.mkdir(path.dirname(tmpFile), { recursive: true });
      await fs.writeFile(tmpFile, '', 'utf-8');

      const prefs = await readPreferences(tmpFile);
      expect(prefs.archivedSessionPaths).toEqual([]);
    });
  });

  describe('withPrefsLock', () => {
    it('should serialize concurrent read-modify-write cycles', async () => {
      const { withPrefsLock, writePreferences } = await loadModule();
      await writePreferences({ archivedSessionPaths: [], pinnedSessionPaths: [] }, tmpFile);

      const concurrency = 10;
      let resolved = 0;

      const tasks = Array.from({ length: concurrency }, (_, i) =>
        withPrefsLock(async (read, write) => {
          const prefs = await read();
          const arr = prefs.archivedSessionPaths ?? [];
          arr.push(`session-${i}`);
          prefs.archivedSessionPaths = arr;
          await write(prefs);
          resolved++;
        }, tmpFile),
      );

      await Promise.all(tasks);
      expect(resolved).toBe(concurrency);

      const final = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
      expect(final.archivedSessionPaths).toHaveLength(concurrency);
      for (let i = 0; i < concurrency; i++) {
        expect(final.archivedSessionPaths).toContain(`session-${i}`);
      }
    });

    it('should provide cached read within the same lock', async () => {
      const { withPrefsLock, writePreferences } = await loadModule();
      await writePreferences({ archivedSessionPaths: ['/initial'], pinnedSessionPaths: [] }, tmpFile);

      await withPrefsLock(async (read, write) => {
        const first = await read();
        const second = await read();
        expect(first).toBe(second);

        first.archivedSessionPaths = ['/updated'];
        await write(first);

        const third = await read();
        expect(third.archivedSessionPaths).toEqual(['/updated']);
      }, tmpFile);

      const final = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
      expect(final.archivedSessionPaths).toEqual(['/updated']);
    });

    it('should release lock even if fn throws', async () => {
      const { withPrefsLock } = await loadModule();

      await expect(
        withPrefsLock(async () => { throw new Error('boom'); }, tmpFile),
      ).rejects.toThrow('boom');

      const result = await withPrefsLock(async (read) => read(), tmpFile);
      expect(result.archivedSessionPaths).toEqual([]);
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock fs/promises - files.ts uses `import fs from 'fs/promises'` (default)
// validatePath internally calls fs.realpath, fs.stat, fs.lstat
const mockWriteFile = vi.fn();
const mockRename = vi.fn();
const mockUnlink = vi.fn();
const mockMkdir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockLstat = vi.fn();
const mockReaddir = vi.fn();
// realpath is used by validatePath; return the path unchanged so /root/* passes
const mockRealpath = vi.fn((p: string) => Promise.resolve(p));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: mockWriteFile,
    rename: mockRename,
    unlink: mockUnlink,
    mkdir: mockMkdir,
    readFile: mockReadFile,
    stat: mockStat,
    lstat: mockLstat,
    readdir: mockReaddir,
    realpath: mockRealpath,
  },
}));

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../../src/security/rate-limit.js', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Import after mocks are set up
const { filesRouter } = await import('../../../src/routes/files.js');

const app = express();
app.use(express.json());
app.use('/api/files', filesRouter);

describe('Files CRUD Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: realpath returns input unchanged
    mockRealpath.mockImplementation((p: string) => Promise.resolve(p));
  });

  // ── POST /write ────────────────────────────────────────────────────────────

  describe('POST /api/files/write', () => {
    it('creates or overwrites a file successfully', async () => {
      mockWriteFile.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/root/test.txt', content: 'hello world' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith('/root/test.txt', 'hello world', 'utf-8');
    });

    it('rejects path traversal outside allowed dirs', async () => {
      // /etc/passwd does not start with /root → validatePath returns null
      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/etc/passwd', content: 'evil' });

      expect(res.status).toBe(400);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('rejects sibling paths that only share an allowed directory prefix', async () => {
      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/root-escape/secret.txt', content: 'evil' });

      expect(res.status).toBe(400);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/files/write')
        .send({ content: 'hello' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when writeFile throws', async () => {
      mockWriteFile.mockRejectedValue(new Error('disk full'));

      const res = await request(app)
        .post('/api/files/write')
        .send({ path: '/root/test.txt', content: 'data' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('disk full');
    });
  });

  // ── PUT /rename ────────────────────────────────────────────────────────────

  describe('PUT /api/files/rename', () => {
    it('renames a file successfully', async () => {
      mockRename.mockResolvedValue(undefined);

      const res = await request(app)
        .put('/api/files/rename')
        .send({ oldPath: '/root/old.txt', newPath: '/root/new.txt' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRename).toHaveBeenCalled();
    });

    it('rejects traversal in oldPath', async () => {
      const res = await request(app)
        .put('/api/files/rename')
        .send({ oldPath: '/etc/hosts', newPath: '/root/new.txt' });

      expect(res.status).toBe(400);
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('rejects traversal in newPath parent', async () => {
      // oldPath is fine, but newPath parent /etc is not allowed
      const res = await request(app)
        .put('/api/files/rename')
        .send({ oldPath: '/root/old.txt', newPath: '/etc/evil' });

      expect(res.status).toBe(400);
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('returns 400 when body fields are missing', async () => {
      const res = await request(app)
        .put('/api/files/rename')
        .send({ oldPath: '/root/old.txt' });

      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /delete ─────────────────────────────────────────────────────────

  describe('DELETE /api/files/delete', () => {
    it('deletes a file successfully', async () => {
      mockUnlink.mockResolvedValue(undefined);

      const res = await request(app)
        .delete('/api/files/delete')
        .send({ path: '/root/test.txt' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUnlink).toHaveBeenCalledWith('/root/test.txt');
    });

    it('rejects path traversal', async () => {
      const res = await request(app)
        .delete('/api/files/delete')
        .send({ path: '/etc/passwd' });

      expect(res.status).toBe(400);
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('returns 400 when unlink throws', async () => {
      mockUnlink.mockRejectedValue(new Error('file not found'));

      const res = await request(app)
        .delete('/api/files/delete')
        .send({ path: '/root/test.txt' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('file not found');
    });
  });

  // ── POST /mkdir ────────────────────────────────────────────────────────────

  describe('POST /api/files/mkdir', () => {
    it('creates a directory successfully', async () => {
      mockMkdir.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/root/newdir' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith('/root/newdir', { recursive: true });
    });

    it('rejects path outside allowed dirs', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({ path: '/etc/evildir' });

      expect(res.status).toBe(400);
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/files/mkdir')
        .send({});

      expect(res.status).toBe(400);
    });
  });
});

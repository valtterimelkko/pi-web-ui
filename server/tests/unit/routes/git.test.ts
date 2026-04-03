import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockGitService = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getBranches: vi.fn(),
  getLog: vi.fn(),
  getDiff: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  checkout: vi.fn(),
  createBranch: vi.fn(),
}));

vi.mock('../../../src/git/git-service.js', () => ({
  gitService: mockGitService,
}));

// Import router AFTER mocks are set up
const { gitRouter } = await import('../../../src/routes/git.js');

const app = express();
app.use(express.json());
app.use('/api/git', gitRouter);

describe('Git Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/git/status returns git status', async () => {
    mockGitService.getStatus.mockResolvedValue({
      isRepo: true, branch: 'main', ahead: 0, behind: 0,
      staged: [], unstaged: [], untracked: [],
    });
    const res = await request(app).get('/api/git/status?cwd=/root/test');
    expect(res.status).toBe(200);
    expect(res.body.isRepo).toBe(true);
    expect(res.body.branch).toBe('main');
  });

  it('GET /api/git/status returns 400 without cwd', async () => {
    const res = await request(app).get('/api/git/status');
    expect(res.status).toBe(400);
  });

  it('GET /api/git/branches returns branches', async () => {
    mockGitService.getBranches.mockResolvedValue({ current: 'main', branches: [] });
    const res = await request(app).get('/api/git/branches?cwd=/root/test');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe('main');
  });

  it('GET /api/git/log returns commits', async () => {
    mockGitService.getLog.mockResolvedValue([]);
    const res = await request(app).get('/api/git/log?cwd=/root/test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/git/log passes limit parameter', async () => {
    mockGitService.getLog.mockResolvedValue([]);
    const res = await request(app).get('/api/git/log?cwd=/root/test&limit=10');
    expect(res.status).toBe(200);
    expect(mockGitService.getLog).toHaveBeenCalledWith('/root/test', 10);
  });

  it('GET /api/git/diff returns diff', async () => {
    mockGitService.getDiff.mockResolvedValue('diff content');
    const res = await request(app).get('/api/git/diff?cwd=/root/test');
    expect(res.status).toBe(200);
    expect(res.body.diff).toBe('diff content');
  });

  it('GET /api/git/diff passes staged flag', async () => {
    mockGitService.getDiff.mockResolvedValue('staged diff');
    const res = await request(app).get('/api/git/diff?cwd=/root/test&staged=true');
    expect(res.status).toBe(200);
    expect(mockGitService.getDiff).toHaveBeenCalledWith('/root/test', { staged: true, file: undefined });
  });

  it('POST /api/git/stage stages files', async () => {
    mockGitService.stage.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/git/stage')
      .send({ cwd: '/root/test', paths: ['file.ts'] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockGitService.stage).toHaveBeenCalledWith('/root/test', ['file.ts']);
  });

  it('POST /api/git/stage returns 400 without paths', async () => {
    const res = await request(app)
      .post('/api/git/stage')
      .send({ cwd: '/root/test', paths: [] });
    expect(res.status).toBe(400);
  });

  it('POST /api/git/unstage unstages files', async () => {
    mockGitService.unstage.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/git/unstage')
      .send({ cwd: '/root/test', paths: ['file.ts'] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/git/discard discards changes', async () => {
    mockGitService.discard.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/git/discard')
      .send({ cwd: '/root/test', paths: ['file.ts'] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/git/commit commits changes', async () => {
    mockGitService.commit.mockResolvedValue('1 file changed');
    const res = await request(app)
      .post('/api/git/commit')
      .send({ cwd: '/root/test', message: 'test commit' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toBe('1 file changed');
  });

  it('POST /api/git/commit returns 400 without message', async () => {
    const res = await request(app)
      .post('/api/git/commit')
      .send({ cwd: '/root/test' });
    expect(res.status).toBe(400);
  });

  it('POST /api/git/push pushes changes', async () => {
    mockGitService.push.mockResolvedValue('To origin');
    const res = await request(app)
      .post('/api/git/push')
      .send({ cwd: '/root/test' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/git/push uses provided remote and branch', async () => {
    mockGitService.push.mockResolvedValue('To upstream');
    const res = await request(app)
      .post('/api/git/push')
      .send({ cwd: '/root/test', remote: 'upstream', branch: 'feature' });
    expect(res.status).toBe(200);
    expect(mockGitService.push).toHaveBeenCalledWith('/root/test', 'upstream', 'feature');
  });

  it('POST /api/git/pull pulls changes', async () => {
    mockGitService.pull.mockResolvedValue('Already up to date');
    const res = await request(app)
      .post('/api/git/pull')
      .send({ cwd: '/root/test' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/git/checkout checks out a branch', async () => {
    mockGitService.checkout.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/git/checkout')
      .send({ cwd: '/root/test', branch: 'feature-branch' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockGitService.checkout).toHaveBeenCalledWith('/root/test', 'feature-branch');
  });

  it('POST /api/git/branch creates a new branch', async () => {
    mockGitService.createBranch.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/git/branch')
      .send({ cwd: '/root/test', name: 'new-feature' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockGitService.createBranch).toHaveBeenCalledWith('/root/test', 'new-feature');
  });

  it('returns 400 when service throws', async () => {
    mockGitService.getStatus.mockRejectedValue(new Error('git not found'));
    const res = await request(app).get('/api/git/status?cwd=/root/test');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('git not found');
  });
});

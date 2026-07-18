import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateSessionToken } from '../../../src/security/auth.js';

// NOTE: this file intentionally does NOT mock cookieAuthMiddleware — it verifies
// the real cookie-auth gate on the browser worktree surface, mirroring
// notifications-web-auth.test.ts. Only the worktree/plan modules are mocked so
// authenticated requests reach a deterministic handler.

const execFileAsync = promisify(execFile);

const { listWorktrees, createWorktreeManager } = vi.hoisted(() => {
  const list = vi.fn();
  return {
    listWorktrees: list,
    createWorktreeManager: vi.fn(async () => ({ listWorktrees: list })),
  };
});
const parsePlanFile = vi.fn();
const validatePlan = vi.fn();

vi.mock('../../../src/pi/parallel/worktree-manager.js', () => ({
  createWorktreeManager,
}));

vi.mock('../../../src/pi/parallel/plan-parser.js', () => ({
  parsePlanFile: (...args: unknown[]) => parsePlanFile(...args),
  validatePlan: (...args: unknown[]) => validatePlan(...args),
}));

// Import AFTER mocks are registered.
import worktreesRoutes from '../../../src/routes/worktrees.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/worktrees', worktreesRoutes);
  return app;
}

const validCookie = () => `accessToken=${generateSessionToken('test-user')}`;

let tmpRoot: string;
let gitRepo: string;
let planFile: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-route-'));
  gitRepo = path.join(tmpRoot, 'repo');
  await fs.mkdir(gitRepo, { recursive: true });
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: gitRepo });
  planFile = path.join(tmpRoot, 'plan.md');
  await fs.writeFile(planFile, '# plan\n');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Worktree routes — auth gate (real cookieAuthMiddleware)', () => {
  beforeEach(() => {
    listWorktrees.mockReset();
    createWorktreeManager.mockClear();
    parsePlanFile.mockReset();
    validatePlan.mockReset();
  });

  it('GET / rejects without auth cookie (401)', async () => {
    const res = await request(buildApp()).get('/api/worktrees');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/cookie/i);
  });

  it('POST / rejects without auth cookie (401)', async () => {
    const res = await request(buildApp()).post('/api/worktrees').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/cookie/i);
  });

  it('POST /orchestrate rejects without auth cookie (401)', async () => {
    const res = await request(buildApp()).post('/api/worktrees/orchestrate').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/cookie/i);
  });

  it('POST /parse-plan rejects without auth cookie (401)', async () => {
    const res = await request(buildApp()).post('/api/worktrees/parse-plan').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/cookie/i);
  });

  it('an authenticated request reaches the handler for a valid git repo (200)', async () => {
    listWorktrees.mockResolvedValue([]);
    const res = await request(buildApp())
      .get('/api/worktrees')
      .set('Cookie', validCookie())
      .query({ repoPath: gitRepo });
    expect(res.status).toBe(200);
    expect(listWorktrees).toHaveBeenCalledTimes(1);
  });

  it('accepts a nested directory and canonicalises it to the repository root', async () => {
    const repo = path.join(tmpRoot, 'nested-repo');
    const nested = path.join(repo, 'packages', 'app');
    await fs.mkdir(nested, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
    listWorktrees.mockResolvedValue([]);

    const res = await request(buildApp())
      .get('/api/worktrees')
      .set('Cookie', validCookie())
      .query({ repoPath: nested });

    expect(res.status).toBe(200);
    expect(createWorktreeManager).toHaveBeenCalledWith(await fs.realpath(repo));
  });

  it('rejects an authenticated repoPath that is not a git repository (400)', async () => {
    // tmpRoot is a real directory but not a git repo.
    const res = await request(buildApp())
      .get('/api/worktrees')
      .set('Cookie', validCookie())
      .query({ repoPath: tmpRoot });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/git repository|directory|repoPath/i);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it('rejects a directory that only contains a fake .git marker', async () => {
    const fakeRepo = path.join(tmpRoot, 'fake-repo');
    await fs.mkdir(fakeRepo, { recursive: true });
    await fs.writeFile(path.join(fakeRepo, '.git'), 'not a gitdir');

    const res = await request(buildApp())
      .get('/api/worktrees')
      .set('Cookie', validCookie())
      .query({ repoPath: fakeRepo });

    expect(res.status).toBe(400);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it('rejects an authenticated repoPath that does not exist (400)', async () => {
    const res = await request(buildApp())
      .get('/api/worktrees')
      .set('Cookie', validCookie())
      .query({ repoPath: path.join(tmpRoot, 'nope') });
    expect(res.status).toBe(400);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it('rejects a planPath traversal that does not resolve to a file (400)', async () => {
    const res = await request(buildApp())
      .post('/api/worktrees/parse-plan')
      .set('Cookie', validCookie())
      .send({ planPath: path.join(tmpRoot, 'missing.md') });
    expect(res.status).toBe(400);
    expect(parsePlanFile).not.toHaveBeenCalled();
  });

  it('accepts an authenticated planPath that resolves to a real file (200)', async () => {
    parsePlanFile.mockResolvedValue({ title: 't', description: '', tasks: [], parallelGroups: [] });
    validatePlan.mockReturnValue({ valid: true, issues: [] });
    const res = await request(buildApp())
      .post('/api/worktrees/parse-plan')
      .set('Cookie', validCookie())
      .send({ planPath: planFile });
    expect(res.status).toBe(200);
    expect(parsePlanFile).toHaveBeenCalledTimes(1);
  });
});

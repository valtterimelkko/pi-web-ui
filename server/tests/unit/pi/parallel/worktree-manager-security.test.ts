import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWorktreeManager,
  assertSafeGitRef,
} from '../../../../src/pi/parallel/worktree-manager.js';

const execFileAsync = promisify(execFile);

async function gitInit(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

let tmpRoot: string;
let baseRepo: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-sec-'));
  baseRepo = path.join(tmpRoot, 'repo');
  await fs.mkdir(baseRepo, { recursive: true });
  await gitInit(baseRepo, 'init', '-b', 'main');
  await gitInit(baseRepo, 'config', 'user.email', 't@t');
  await gitInit(baseRepo, 'config', 'user.name', 't');
  await fs.writeFile(path.join(baseRepo, 'README.md'), 'hello\n');
  await gitInit(baseRepo, 'add', 'README.md');
  await gitInit(baseRepo, 'commit', '-m', 'init');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('assertSafeGitRef — ref/flag safety validator', () => {
  const bad = [
    'main; touch /tmp/x',      // shell command separator + space
    'main$(touch /tmp/x)',     // command substitution
    'main`touch /tmp/x`',      // backtick substitution
    'main && touch /tmp/x',    // shell AND + space
    '--upload-pack=/tmp/x',    // leading flag / option injection
    '-x',                      // leading dash
    'main\n--evil',            // embedded newline
    'main ev',                 // embedded space
    'main|cat',                // pipe
    'a..b',                    // git-forbidden ..
    'a:b',                     // git-forbidden :
    'a~b',                     // git-forbidden ~
    'a^b',                     // git-forbidden ^
    'refs@{x}',                // git-forbidden @{
    'branch.lock',             // trailing .lock
    'main/',                   // trailing slash
    'main.',                   // trailing dot
    '',                        // empty
  ];
  for (const value of bad) {
    it(`rejects unsafe ref value ${JSON.stringify(value)}`, () => {
      expect(() => assertSafeGitRef(value, 'baseBranch')).toThrow();
    });
  }

  const good = ['main', 'feature/x', 'task-1-foo', 'release-2.0', 'dev_branch'];
  for (const value of good) {
    it(`accepts safe ref value ${JSON.stringify(value)}`, () => {
      expect(() => assertSafeGitRef(value, 'baseBranch')).not.toThrow();
    });
  }
});

describe('WorktreeManager — shell-injection neutralised (real temp git repo)', () => {
  it('a baseBranch with shell command substitution creates no marker file', async () => {
    const mk = path.join(tmpRoot, 'marker-sub');
    const manager = await createWorktreeManager(baseRepo);
    await manager
      .createWorktree({
        taskId: '1',
        baseBranch: `main; touch ${mk}`,
        taskDescription: 'inject sub',
        repoPath: baseRepo,
      })
      .catch(() => {
        /* expected to be rejected */
      });
    const exists = await fs.stat(mk).then(() => true).catch(() => false);
    expect(exists).toBe(false);
    // Ensure no stray worktree dir leaks into the temp root for this case.
    const entries = await fs.readdir(tmpRoot).catch(() => []);
    expect(entries.some((e) => e.startsWith('marker-'))).toBe(false);
  });

  it('creates a worktree for valid repo + valid branch/task id', async () => {
    const manager = await createWorktreeManager(baseRepo);
    const wt = await manager.createWorktree({
      taskId: 'valid1',
      baseBranch: 'main',
      taskDescription: 'A perfectly normal task',
      repoPath: baseRepo,
    });
    expect(wt.id).toMatch(/^wt-valid1-/);
    expect(wt.branch).toBe('task-valid1-a-perfectly-normal-task');
    expect(wt.baseBranch).toBe('main');
    await fs.rm(wt.path, { recursive: true, force: true }).catch(() => {});
  });
});

async function makeIsolatedRepo(name: string): Promise<string> {
  const repo = path.join(tmpRoot, name);
  await fs.mkdir(repo, { recursive: true });
  await gitInit(repo, 'init', '-b', 'main');
  await gitInit(repo, 'config', 'user.email', 't@t');
  await gitInit(repo, 'config', 'user.name', 't');
  await fs.writeFile(path.join(repo, 'README.md'), 'hello\n');
  await gitInit(repo, 'add', 'README.md');
  await gitInit(repo, 'commit', '-m', 'init');
  return repo;
}

async function installGitWrapper(dir: string, blockedCommand: 'merge' | 'push'): Promise<string> {
  const marker = path.join(dir, `${blockedCommand}-invoked`);
  const wrapper = path.join(dir, 'git');
  await fs.writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "${blockedCommand}" ]; then echo invoked > "${marker}"; fi\nexec /usr/bin/git "$@"\n`);
  await fs.chmod(wrapper, 0o755);
  return marker;
}

describe('WorktreeManager destructive-operation safety (real temp git repos)', () => {
  it('refuses to merge a dirty worktree instead of creating a WIP commit', async () => {
    const repo = await makeIsolatedRepo('dirty-merge-repo');
    const manager = await createWorktreeManager(repo);
    const wt = await manager.createWorktree({ taskId: 'dirty1', baseBranch: 'main', taskDescription: 'dirty merge', repoPath: repo });
    await fs.writeFile(path.join(wt.path, 'dirty.txt'), 'uncommitted\n');
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: wt.path })).stdout.trim();

    const result = await manager.mergeWorktree(wt.id);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/uncommitted|dirty/i);
    const after = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: wt.path })).stdout.trim();
    expect(after).toBe(before);
  });

  it('does not invoke git push as part of merging a worktree', async () => {
    const repo = await makeIsolatedRepo('no-push-repo');
    const manager = await createWorktreeManager(repo);
    const wt = await manager.createWorktree({ taskId: 'nopush1', baseBranch: 'main', taskDescription: 'no push', repoPath: repo });
    await fs.writeFile(path.join(wt.path, 'feature.txt'), 'committed\n');
    await gitInit(wt.path, 'add', 'feature.txt');
    await gitInit(wt.path, 'commit', '-m', 'feature');
    const marker = await installGitWrapper(tmpRoot, 'push');
    const oldPath = process.env.PATH;
    process.env.PATH = `${tmpRoot}:${oldPath}`;
    try {
      const result = await manager.mergeWorktree(wt.id);
      expect(result.success).toBe(true);
    } finally {
      process.env.PATH = oldPath;
    }
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes the base branch only through the explicit publish call', async () => {
    const repo = await makeIsolatedRepo('explicit-publish-repo');
    const remote = path.join(tmpRoot, 'explicit-publish-remote.git');
    await fs.mkdir(remote, { recursive: true });
    await gitInit(remote, 'init', '--bare');
    await gitInit(repo, 'remote', 'add', 'origin', remote);
    await gitInit(repo, 'push', '-u', 'origin', 'main');

    const manager = await createWorktreeManager(repo);
    const wt = await manager.createWorktree({ taskId: 'publish1', baseBranch: 'main', taskDescription: 'explicit publish', repoPath: repo });
    await fs.writeFile(path.join(wt.path, 'published.txt'), 'committed\n');
    await gitInit(wt.path, 'add', 'published.txt');
    await gitInit(wt.path, 'commit', '-m', 'publishable feature');

    const merged = await manager.mergeWorktree(wt.id);
    expect(merged.success).toBe(true);
    const localMain = (await execFileAsync('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim();
    const remoteBefore = (await execFileAsync('git', ['rev-parse', 'main'], { cwd: remote })).stdout.trim();
    expect(remoteBefore).not.toBe(localMain);

    const published = await manager.publishBaseBranch(wt.id);
    expect(published.success).toBe(true);
    const remoteAfter = (await execFileAsync('git', ['rev-parse', 'main'], { cwd: remote })).stdout.trim();
    expect(remoteAfter).toBe(localMain);
  });

  it('does not recursively delete a poisoned metadata path that is absent from the git worktree registry', async () => {
    const repo = await makeIsolatedRepo('poison-delete-repo');
    const manager = await createWorktreeManager(repo);
    const wt = await manager.createWorktree({ taskId: 'delete1', baseBranch: 'main', taskDescription: 'safe delete', repoPath: repo });
    const decoy = path.join(tmpRoot, 'decoy-delete-target');
    await fs.mkdir(decoy, { recursive: true });
    await fs.writeFile(path.join(decoy, 'keep.txt'), 'must survive');
    (manager as unknown as { worktreeMetadata: Map<string, { path: string }> }).worktreeMetadata.get(wt.id)!.path = decoy;

    await expect(manager.deleteWorktree(wt.id)).rejects.toThrow(/registry|not found|canonical/i);
    await expect(fs.readFile(path.join(decoy, 'keep.txt'), 'utf8')).resolves.toBe('must survive');
  });

  it('detects conflicts read-only with merge-tree and leaves the worktree unchanged', async () => {
    const repo = await makeIsolatedRepo('conflict-readonly-repo');
    const manager = await createWorktreeManager(repo);
    const wt = await manager.createWorktree({ taskId: 'conflict1', baseBranch: 'main', taskDescription: 'conflict probe', repoPath: repo });
    await fs.writeFile(path.join(wt.path, 'README.md'), 'worktree\n');
    await gitInit(wt.path, 'add', 'README.md');
    await gitInit(wt.path, 'commit', '-m', 'worktree change');
    await fs.writeFile(path.join(repo, 'README.md'), 'base\n');
    await gitInit(repo, 'add', 'README.md');
    await gitInit(repo, 'commit', '-m', 'base change');

    const beforeStatus = (await execFileAsync('git', ['status', '--porcelain'], { cwd: wt.path })).stdout;
    const beforeFile = await fs.readFile(path.join(wt.path, 'README.md'), 'utf8');
    const marker = await installGitWrapper(tmpRoot, 'merge');
    const oldPath = process.env.PATH;
    process.env.PATH = `${tmpRoot}:${oldPath}`;
    let conflicts;
    try {
      conflicts = await manager.getConflicts(wt.id);
    } finally {
      process.env.PATH = oldPath;
    }

    expect(conflicts.map((c) => c.file)).toContain('README.md');
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: wt.path })).stdout).toBe(beforeStatus);
    await expect(fs.readFile(path.join(wt.path, 'README.md'), 'utf8')).resolves.toBe(beforeFile);
  });
});

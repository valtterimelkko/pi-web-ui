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

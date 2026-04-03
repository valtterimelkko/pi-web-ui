import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 30000; // 30s

// Allowed base directories for git operations
const ALLOWED_DIRS = ['/root', '/home'];

// Git type definitions (inline since not yet in shared package)
export interface GitFileStatus {
  path: string;
  staged: boolean;
  status: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs: string;
}

function validateCwd(cwd: string): string {
  const resolved = resolve(cwd);
  const isAllowed = ALLOWED_DIRS.some(dir => resolved === dir || resolved.startsWith(dir + '/'));
  if (!isAllowed) {
    throw new Error(`Access denied: ${cwd}`);
  }
  return resolved;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const safeCwd = validateCwd(cwd);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: safeCwd,
      timeout: GIT_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    const msg = error.stderr?.trim() || error.message || 'Git command failed';
    throw new Error(msg);
  }
}

export class GitService {
  async isGitRepo(cwd: string): Promise<boolean> {
    // Validate path first - let access denied errors propagate
    validateCwd(cwd);
    try {
      await git(cwd, ['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(cwd: string): Promise<GitStatus> {
    const isRepo = await this.isGitRepo(cwd);
    if (!isRepo) {
      return { isRepo: false, branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
    }

    // Get branch name
    let branch = 'HEAD';
    try {
      branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch { /* ignore */ }

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;
    try {
      const ab = await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      const parts = ab.split('\t');
      ahead = parseInt(parts[0] || '0', 10);
      behind = parseInt(parts[1] || '0', 10);
    } catch { /* no upstream - ignore */ }

    // Get porcelain status
    const porcelain = await git(cwd, ['status', '--porcelain=v1']);
    const staged: GitFileStatus[] = [];
    const unstaged: GitFileStatus[] = [];
    const untracked: GitFileStatus[] = [];

    for (const line of porcelain.split('\n').filter(Boolean)) {
      const stagedStatus = line[0];
      const unstagedStatus = line[1];
      const filePath = line.slice(3);

      if (stagedStatus !== ' ' && stagedStatus !== '?') {
        staged.push({ path: filePath, staged: true, status: stagedStatus });
      }
      if (unstagedStatus !== ' ' && unstagedStatus !== '?') {
        unstaged.push({ path: filePath, staged: false, status: unstagedStatus });
      }
      if (stagedStatus === '?' && unstagedStatus === '?') {
        untracked.push({ path: filePath, staged: false, status: '?' });
      }
    }

    return { isRepo: true, branch, ahead, behind, staged, unstaged, untracked };
  }

  async getBranches(cwd: string): Promise<{ current: string; branches: GitBranch[] }> {
    const branchOutput = await git(cwd, ['branch', '-a', '--format=%(refname:short) %(HEAD) %(objectname:short)']);
    let current = '';
    const branches: GitBranch[] = [];

    for (const line of branchOutput.split('\n').filter(Boolean)) {
      const parts = line.split(' ');
      const name = parts[0];
      const isCurrent = parts[1] === '*';
      const hash = parts[2] || '';
      const isRemote = name.startsWith('remotes/');

      if (isCurrent) current = name;
      branches.push({ name, isCurrent, isRemote, lastCommit: hash });
    }

    return { current, branches };
  }

  async getLog(cwd: string, limit: number = 50): Promise<GitLogEntry[]> {
    const format = '%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%D';
    const output = await git(cwd, ['log', `--max-count=${limit}`, `--format=${format}`, '--date=relative']);
    const entries: GitLogEntry[] = [];

    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split('\x1f');
      entries.push({
        hash: parts[0] || '',
        shortHash: parts[1] || '',
        message: parts[2] || '',
        author: parts[3] || '',
        date: parts[4] || '',
        refs: parts[5] || '',
      });
    }

    return entries;
  }

  async getDiff(cwd: string, options: { staged?: boolean; file?: string } = {}): Promise<string> {
    const args = ['diff', '--no-color'];
    if (options.staged) args.push('--staged');
    if (options.file) args.push('--', options.file);
    return git(cwd, args);
  }

  async stage(cwd: string, paths: string[]): Promise<void> {
    await git(cwd, ['add', '--', ...paths]);
  }

  async unstage(cwd: string, paths: string[]): Promise<void> {
    await git(cwd, ['reset', 'HEAD', '--', ...paths]);
  }

  async discard(cwd: string, paths: string[]): Promise<void> {
    await git(cwd, ['checkout', '--', ...paths]);
  }

  async commit(cwd: string, message: string): Promise<string> {
    return git(cwd, ['commit', '-m', message]);
  }

  async push(cwd: string, remote: string = 'origin', branch?: string): Promise<string> {
    const args = ['push', remote];
    if (branch) args.push(branch);
    return git(cwd, args);
  }

  async pull(cwd: string): Promise<string> {
    return git(cwd, ['pull']);
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    await git(cwd, ['checkout', branch]);
  }

  async createBranch(cwd: string, name: string): Promise<void> {
    await git(cwd, ['checkout', '-b', name]);
  }
}

export const gitService = new GitService();

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from '../../../src/git/git-service.js';

describe('GitService', () => {
  it('creates a GitService instance', () => {
    const service = new GitService();
    expect(service).toBeDefined();
    expect(typeof service.isGitRepo).toBe('function');
    expect(typeof service.getStatus).toBe('function');
    expect(typeof service.getBranches).toBe('function');
    expect(typeof service.getLog).toBe('function');
    expect(typeof service.getDiff).toBe('function');
    expect(typeof service.stage).toBe('function');
    expect(typeof service.unstage).toBe('function');
    expect(typeof service.discard).toBe('function');
    expect(typeof service.commit).toBe('function');
    expect(typeof service.push).toBe('function');
    expect(typeof service.pull).toBe('function');
    expect(typeof service.checkout).toBe('function');
    expect(typeof service.createBranch).toBe('function');
  });

  it('rejects paths outside allowed directories', async () => {
    const service = new GitService();
    await expect(service.isGitRepo('/etc/passwd')).rejects.toThrow('Access denied');
    await expect(service.isGitRepo('/var/log')).rejects.toThrow('Access denied');
  });

  it('rejects path traversal attempts', async () => {
    const service = new GitService();
    await expect(service.isGitRepo('/root/../etc')).rejects.toThrow('Access denied');
  });

  it('rejects a symlinked cwd that escapes the allowed roots', async () => {
    const service = new GitService();
    const tmp = await fs.mkdtemp(path.join(os.homedir(), '.git-service-cwd-'));
    try {
      const link = path.join(tmp, 'etc-link');
      await fs.symlink('/etc', link);
      await expect(service.isGitRepo(link)).rejects.toThrow('Access denied');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

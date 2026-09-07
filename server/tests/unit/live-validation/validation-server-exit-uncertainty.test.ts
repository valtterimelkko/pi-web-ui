import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const repo = path.resolve(import.meta.dirname, '../../../..');

describe('validation child exit evidence', () => {
  it('preserves identity rather than claiming stopped when process inspection fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vexit-unknown-'));
    const emptyPath = path.join(dir, 'empty-path');
    await mkdir(emptyPath);
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'scripts/validation-server-child.ts')], {
      cwd: repo, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env, NODE_ENV: 'test', PATH: emptyPath,
        PI_WEB_UI_VALIDATION_SERVER_CHILD: '1',
        PI_WEB_UI_VALIDATION_RECORD_DIR: dir,
        PI_WEB_UI_VALIDATION_BOUND_PORT: '12345',
        PI_WEB_UI_VALIDATION_CHILD_EXIT_AFTER_RECORD: '1',
        PI_WEB_UI_VALIDATION_TEST_NOISE: '1',
        PI_WEB_UI_VALIDATION_TEST_NOISE_TTL_MS: '1000',
      },
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolve());
      });
      expect(stderr).toContain('validation hook: exiting after record write');
      await expect(readFile(path.join(dir, 'server-process.json'), 'utf8')).resolves.toContain('startTimeTicks');
      await expect(readFile(path.join(dir, 'server-process.stopped.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(stderr).toContain('unverified');
    } finally {
      // This fixture independently owns the detached group and its short-TTL
      // helper. Never rely on the faulty exit handler under test for cleanup.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
});

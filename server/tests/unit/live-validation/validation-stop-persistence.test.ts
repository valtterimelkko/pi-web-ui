import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const repo = path.resolve(import.meta.dirname, '../../../..');

describe('validation stop evidence persistence', () => {
  it('preserves the live identity if writing verified stop evidence fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vstop-io-'));
    const leader = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.exit(0)); console.log('READY'); setInterval(()=>{},1000);"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve, reject) => { leader.once('error', reject); leader.stdout!.once('data', () => resolve()); });
      const stat = await readFile(`/proc/${leader.pid}/stat`, 'utf8');
      const startTimeTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      await writeFile(path.join(dir, 'server-process.json'), JSON.stringify({ identityVersion: 1, pid: leader.pid, pgid: leader.pid, pgidSource: 'verified-dedicated-group-leader', startTimeTicks }));
      await mkdir(path.join(dir, 'server-process.stopped.json')); // deterministic EISDIR
      const stop = spawnSync(process.execPath, [path.join(repo, 'scripts/validation-server-stop.mjs'), '--dir', dir, '--timeout-ms', '500'], { encoding: 'utf8', timeout: 5000 });
      expect(stop.status).not.toBe(0);
      await expect(readFile(path.join(dir, 'server-process.json'), 'utf8')).resolves.toContain('startTimeTicks');
    } finally {
      try { process.kill(-leader.pid!, 'SIGKILL'); } catch { /* already gone */ }
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);

  it('preserves child-exit identity if its quiet-group tombstone cannot be written', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vexit-io-'));
    const bin = path.join(dir, 'bin'); await mkdir(bin);
    // Substitute only the process-table observation to reach the quiet-exit
    // persistence branch deterministically, without a full server/model.
    await writeFile(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await mkdir(path.join(dir, 'server-process.stopped.json'));
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'scripts/validation-server-child.ts')], {
      cwd: repo, detached: true, stdio: 'ignore', env: {
        ...process.env, PATH: bin, NODE_ENV: 'test', PI_WEB_UI_VALIDATION_SERVER_CHILD: '1',
        PI_WEB_UI_VALIDATION_RECORD_DIR: dir, PI_WEB_UI_VALIDATION_BOUND_PORT: '12345',
        PI_WEB_UI_VALIDATION_CHILD_EXIT_AFTER_RECORD: '1', PI_WEB_UI_VALIDATION_TEST_NOISE: '0',
      },
    });
    try {
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
      await expect(readFile(path.join(dir, 'server-process.json'), 'utf8')).resolves.toContain('startTimeTicks');
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
});

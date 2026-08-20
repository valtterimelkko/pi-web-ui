import { describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'scripts/validation-server-stop.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('validation-server-stop.mjs not found upward of the test');
}
const REPO = findRepoRoot(import.meta.dirname);
const STOPPER = path.join(REPO, 'scripts/validation-server-stop.mjs');

function makeValidationTempRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function groupLeaderAlive(pgid: number): boolean {
  // Stat-aware: a killed-but-unreaped zombie still appears in the table.
  const probe = spawnSync('ps', ['-e', '-o', 'pgid=,stat='], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  return probe.stdout.split('\n').some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\w+)/);
    return match !== null && Number(match[1]) === pgid && !/^[ZX]/.test(match[2]);
  });
}

describe('validation-server-stop (defect 12: process-group teardown)', () => {
  it('terminates the whole recorded process group, including a SIGTERM-ignoring member', async () => {
    const dir = makeValidationTempRoot('vstop-');
    // A group leader (setsid) that ignores SIGTERM plus a child in the same group:
    // killing only the leader pid would orphan the child — the exact defect shape.
    const ignoreTerm = `process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
    const leader = spawn('bash', ['-c', `exec node -e ${JSON.stringify(ignoreTerm)} & child=$!; trap '' TERM; wait $child`], {
      detached: true,
      stdio: 'ignore',
    });
    leader.unref();
    const pgid = leader.pid!;
    // Wait for the group to exist.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(groupLeaderAlive(pgid)).toBe(true);

    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify({ pid: pgid, pgid, startedAt: new Date().toISOString() })}\n`);

    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir, '--timeout-ms', '2000'], { encoding: 'utf8' });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toMatch(/terminated and verified gone/);
    // Verification, not just exit code: the group is really gone.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupLeaderAlive(pgid)).toBe(false);
    // The record is cleaned up by the stopper.
    expect(existsSync(path.join(dir, 'server-process.json'))).toBe(false);
  }, 20000);

  it('is a no-op success when no record exists', () => {
    const dir = makeValidationTempRoot('vstop-empty-');
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status).toBe(0);
    expect(stop.stderr).toMatch(/nothing recorded to stop/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an unsafe process group id', () => {
    const dir = makeValidationTempRoot('vstop-unsafe-');
    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify({ pid: 1, pgid: 1, startedAt: new Date().toISOString() })}\n`);
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toMatch(/unsafe process group/);
    rmSync(dir, { recursive: true, force: true });
  });
});

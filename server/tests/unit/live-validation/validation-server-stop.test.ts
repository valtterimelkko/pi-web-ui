import { describe, expect, it, onTestFinished } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
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

/** Overall field 22 of /proc/<pid>/stat (start time in clock ticks). */
function startTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
}

/**
 * Identity record in the format the dedicated-group child entry writes
 * (scripts/validation-server-child.ts). The stopper refuses to act on
 * anything else — that gate is what closed the old false-success teardown.
 */
function dedicatedGroupRecord(pid: number) {
  return {
    identityVersion: 1,
    pid,
    pgid: pid,
    pgidSource: 'verified-dedicated-group-leader',
    startTimeTicks: startTicks(pid),
    startedAt: new Date().toISOString(),
  };
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
    onTestFinished(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } });

    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify(dedicatedGroupRecord(pgid))}\n`);

    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir, '--timeout-ms', '2000'], { encoding: 'utf8' });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toMatch(/terminated and verified gone/);
    // Verification, not just exit code: the group is really gone.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupLeaderAlive(pgid)).toBe(false);
    // The live record is cleaned up and a tombstone preserves the evidence.
    expect(existsSync(path.join(dir, 'server-process.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'server-process.stopped.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it('refuses to claim success when no record and no tombstone exist', () => {
    const dir = makeValidationTempRoot('vstop-empty-');
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    // Unsafe-success expectation deliberately changed (capacity review §3):
    // unknown ownership is never reported as stopped.
    expect(stop.status).toBe(1);
    expect(stop.stderr).toMatch(/NOT reported as stopped/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an already-stopped directory truthfully from the tombstone', () => {
    const dir = makeValidationTempRoot('vstop-tombstone-');
    writeFileSync(path.join(dir, 'server-process.stopped.json'), `${JSON.stringify({
      identityVersion: 1,
      pid: 424242,
      pgid: 424242,
      stoppedAt: new Date().toISOString(),
      outcome: 'stopped-by-stopper',
    })}\n`);
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toMatch(/already stopped/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an unsafe process group id in an otherwise valid record', () => {
    const dir = makeValidationTempRoot('vstop-unsafe-');
    const record = { ...dedicatedGroupRecord(1), pid: 1, pgid: 1 };
    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify(record)}\n`);
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toMatch(/unsafe process group/);
    // Refusals preserve the record so cleanup ability is never lost.
    expect(existsSync(path.join(dir, 'server-process.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a legacy (pre-dedicated-group) record without signalling anything', () => {
    const dir = makeValidationTempRoot('vstop-legacy-');
    // Exactly the shape the old fallback launcher wrote: no identity marker.
    // Its pgid was a guess — acting on it is how teardown used to report
    // false success against a live server.
    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify({ pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString() })}\n`);
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toMatch(/predates verified dedicated-group identity/);
    expect(existsSync(path.join(dir, 'server-process.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a reused pid whose starttime no longer matches the record', async () => {
    const dir = makeValidationTempRoot('vstop-reused-');
    const leader = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    leader.unref();
    const pgid = leader.pid!;
    await new Promise((resolve) => setTimeout(resolve, 300));
    onTestFinished(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } });
    expect(groupLeaderAlive(pgid)).toBe(true);

    const record = { ...dedicatedGroupRecord(pgid), startTimeTicks: startTicks(pgid) + 98765 };
    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify(record)}\n`);
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toMatch(/starttime mismatch/);
    expect(existsSync(path.join(dir, 'server-process.json'))).toBe(true);
    // The live group was untouched by the refusal.
    expect(groupLeaderAlive(pgid)).toBe(true);
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }, 15000);

  // ── Rework regressions (parent review 1, items 1–2) ────────────────────

  it('refuses an unreadable or malformed tombstone instead of reporting already-stopped', () => {
    const dir = makeValidationTempRoot('vstop-badtomb-');
    // A tombstone is evidence, not a magic success token: unreadable contents
    // must never mint a stop outcome.
    writeFileSync(path.join(dir, 'server-process.stopped.json'), '{ not json at all');
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir], { encoding: 'utf8' });
    expect(stop.status, `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(1);
    expect(stop.stderr).toMatch(/tombstone/i);
    expect(stop.stdout).not.toMatch(/already stopped/);
    // The untrustworthy tombstone is preserved for investigation.
    expect(existsSync(path.join(dir, 'server-process.stopped.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a valid tombstone while its named group still has live members', async () => {
    const dir = makeValidationTempRoot('vstop-tomblive-');
    // Repro of review item 1: the leader exited (so a tombstone exists) but a
    // SIGTERM-ignoring descendant of the same group remains. A tombstone plus
    // a live group must be an explicit refusal, never "already stopped".
    const ignoreTerm = `process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
    const leader = spawn('bash', ['-c', `exec node -e ${JSON.stringify(ignoreTerm)} & child=$!; trap '' TERM; wait $child`], {
      detached: true,
      stdio: 'ignore',
    });
    leader.unref();
    const pgid = leader.pid!;
    await new Promise((resolve) => setTimeout(resolve, 400));
    onTestFinished(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } });
    expect(groupLeaderAlive(pgid)).toBe(true);

    writeFileSync(path.join(dir, 'server-process.stopped.json'), `${JSON.stringify({
      identityVersion: 1,
      pid: pgid,
      pgid,
      stoppedAt: new Date().toISOString(),
      outcome: 'server-process-exit',
    })}\n`);
    const stop = spawnSync(process.execPath, [STOPPER, '--dir', dir, '--timeout-ms', '2000'], { encoding: 'utf8' });
    expect(stop.status, `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(1);
    expect(stop.stdout).not.toMatch(/already stopped/);
    expect(groupLeaderAlive(pgid)).toBe(true);
    expect(existsSync(path.join(dir, 'server-process.stopped.json'))).toBe(true);
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it('rejects invalid --timeout-ms values before signalling a live fixture', async () => {
    const dir = makeValidationTempRoot('vstop-timeout-');
    const ignoreTerm = `process.on('SIGTERM', () => {}); setInterval(() => {}, 500);`;
    const leader = spawn('bash', ['-c', `exec node -e ${JSON.stringify(ignoreTerm)} & child=$!; trap '' TERM; wait $child`], {
      detached: true,
      stdio: 'ignore',
    });
    leader.unref();
    const pgid = leader.pid!;
    await new Promise((resolve) => setTimeout(resolve, 400));
    onTestFinished(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ } });
    expect(groupLeaderAlive(pgid)).toBe(true);

    writeFileSync(path.join(dir, 'server-process.json'), `${JSON.stringify(dedicatedGroupRecord(pgid))}\n`);

    for (const bad of ['Infinity', 'NaN', '-500', 'abc', '0', '999999']) {
      // Bounded execution: the current Infinity behaviour hangs forever, which
      // is itself the defect under test — the watchdog turns a hang into the
      // observable RED instead of stalling the suite.
      const result = await new Promise<{ status: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [STOPPER, '--dir', dir, '--timeout-ms', bad], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
        const watchdog = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          resolve({ status: null, timedOut: true, stdout, stderr });
        }, 5000);
        child.once('exit', (code) => {
          clearTimeout(watchdog);
          resolve({ status: code, timedOut: false, stdout, stderr });
        });
      });
      const detail = `--timeout-ms ${bad}: status=${result.status} timedOut=${result.timedOut} stdout=${result.stdout} stderr=${result.stderr}`;
      expect(result.timedOut, `stopper must reject ${bad} immediately, not hang: ${detail}`).toBe(false);
      expect(result.status, `stopper must exit 2 (usage refusal) for ${bad}: ${detail}`).toBe(2);
      expect(groupLeaderAlive(pgid), `live fixture must be untouched after refusing ${bad}: ${detail}`).toBe(true);
      expect(existsSync(path.join(dir, 'server-process.json')), `record must be preserved after refusing ${bad}`).toBe(true);
    }
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }, 60000);
});

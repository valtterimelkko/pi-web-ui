import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, rmSync as rm, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { placementBashPrefixLine } from '../../../src/placement/spawn-wrap.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

/**
 * Correction-08 finding 2: the bash prefix executes the GENERATED SHELL TEXT against
 * a fake cgroup tree with each write failing in turn (memory.max/high, pids.max,
 * swap.max via /dev/null symlinks; the OOM-score write via the PI_TOOLS_OOM_SCORE_FILE
 * seam) and a read-back mismatch. Each case asserts: NOT joined, a degrade line
 * written, and the appended command still ran.
 */

const GiB = 1024 * 1024 * 1024;

function fakeTree(): { root: string; slice: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'd0-prefix-'));
  const slice = path.join(dir, 'tools.slice');
  mkdirSync(slice, { recursive: true });
  writeFileSync(path.join(slice, 'cgroup.controllers'), 'cpu memory pids\n');
  writeFileSync(path.join(slice, 'cgroup.procs'), '');
  writeFileSync(path.join(slice, 'memory.max'), '10737418240\n'); // bounded root
  return { root: dir, slice, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseEnv(slice: string, degrade: string): Record<string, string> {
  return {
    PI_TOOLS_CG: path.join(slice, 'pi-faulty'),
    PI_TOOLS_ROOT: slice,
    PI_TOOLS_GROUP: 'pi-faulty',
    PI_TOOLS_MEM_MAX: String(2 * GiB),
    PI_TOOLS_MEM_HIGH: String(1 * GiB),
    PI_TOOLS_PIDS_MAX: '512',
    PI_TOOLS_SWAP_MAX: String(512 * 1024 * 1024),
    PI_TOOLS_SHELL: '/bin/bash',
    PI_TOOLS_DEGRADE_FILE: degrade,
  };
}

function runPrefix(slice: string, env: Record<string, string>, userCmd: string): { out: string; status: number } {
  const line = placementBashPrefixLine(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on' }));
  const out = execFileSync('/bin/sh', ['-c', `${line}\n${userCmd}`], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { out, status: 0 };
}

describe('correction-08 finding 2: bash prefix all-or-nothing (fault injection, generated shell)', () => {
  const root = fakeTree();
  afterAll(root.cleanup);

  it.each([
    ['memory.max'], ['memory.high'], ['pids.max'], ['memory.swap.max'],
  ])('FAULT %s: not joined, degrade written, command still ran', (limitFile) => {
    const degrade = path.join(root.slice, `degrade-${limitFile}.log`);
    const env = { ...baseEnv(root.slice, degrade), PI_TOOLS_CG: path.join(root.slice, 'pi-faulty') };
    const leaf = path.join(root.slice, 'pi-faulty');
    mkdirSync(leaf, { recursive: true });
    // kernel-shaped leaf whose faulty limit is a /dev/null symlink: the write
    // vanishes and the read-back comes back empty → mismatch → not joined.
    writeFileSync(path.join(leaf, 'cgroup.procs'), '');
    for (const f of ['memory.max', 'memory.high', 'pids.max', 'memory.swap.max']) {
      if (f === limitFile) {
        rm(path.join(leaf, f), { force: true });
        symlinkSync('/dev/null', path.join(leaf, f));
      } else {
        writeFileSync(path.join(leaf, f), 'max\n');
      }
    }
    const { out } = runPrefix(root.slice, env, 'echo RAN-MARKER; cat "$PI_TOOLS_CG/cgroup.procs" 2>/dev/null');
    // NOT joined: the prefix never wrote $$ into the group's procs file
    const procs = readFileSync(path.join(leaf, 'cgroup.procs'), 'utf8');
    expect(procs).toBe('');
    // degrade written
    expect(readFileSync(degrade, 'utf8')).toContain('limit-readback-failed');
    // command still ran (its own marker output is present)
    expect(out).toContain('RAN-MARKER');
    rm(leaf, { recursive: true, force: true });
    rm(degrade, { force: true });
  });

  it('FAULT missing memory.max (correction 09): a group created without the limit file is refused', () => {
    // 09-correction: cgroupfs refuses to CREATE a missing limit file — the write fails
    // with Permission denied and the read fails with No such file. Simulated here with
    // a directory stub (both the write and the read fail); the group must be refused.
    const degrade = path.join(root.slice, 'degrade-nomax.log');
    const env = { ...baseEnv(root.slice, degrade), PI_TOOLS_CG: path.join(root.slice, 'pi-nomax') };
    const leaf = path.join(root.slice, 'pi-nomax');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(path.join(leaf, 'cgroup.procs'), '');
    mkdirSync(path.join(leaf, 'memory.max')); // directory stub: no creatable memory.max
    writeFileSync(path.join(leaf, 'memory.high'), 'max\n');
    writeFileSync(path.join(leaf, 'pids.max'), 'max\n');
    writeFileSync(path.join(leaf, 'memory.swap.max'), 'max\n');
    const { out } = runPrefix(root.slice, env, 'echo RAN-MARKER');
    expect(readFileSync(path.join(leaf, 'cgroup.procs'), 'utf8')).toBe(''); // NOT joined
    expect(readFileSync(degrade, 'utf8')).toContain('limit-readback-failed');
    expect(out).toContain('RAN-MARKER'); // command still ran, unplaced
    rm(leaf, { recursive: true, force: true });
    rm(degrade, { force: true });
  });

  it('FAULT oom-score: a failed score reset (before the join) leaves the command unplaced', () => {
    const degrade = path.join(root.slice, 'degrade-oom.log');
    const env = { ...baseEnv(root.slice, degrade), PI_TOOLS_OOM_SCORE_FILE: '/dev/null' };
    const leaf = path.join(root.slice, 'pi-oomf');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(path.join(leaf, 'cgroup.procs'), '');
    writeFileSync(path.join(leaf, 'memory.max'), 'max\n');
    const { out } = runPrefix(root.slice, env, 'echo RAN-MARKER');
    expect(readFileSync(path.join(leaf, 'cgroup.procs'), 'utf8')).toBe(''); // not joined
    expect(readFileSync(degrade, 'utf8')).toContain('oom-score-reset-failed');
    expect(out).toContain('RAN-MARKER'); // command still ran
    rm(leaf, { recursive: true, force: true });
    rm(degrade, { force: true });
  });

  it('HAPPY PATH: all limits verified and the command is joined at score 0', () => {
    const degrade = path.join(root.slice, 'degrade-happy.log');
    const env = baseEnv(root.slice, degrade);
    const { out } = runPrefix(root.slice, env, 'echo "JOINED=$(cat "$PI_TOOLS_CG/cgroup.procs" 2>/dev/null)"; echo "SCORE=$(cat /proc/self/oom_score_adj 2>/dev/null)"');
    expect(out).toMatch(/JOINED=\d+/); // the prefix's $$ is in the group
    expect(out).toContain('SCORE=0'); // /proc/self score in the child shell: 0 inherited via the REAL /proc write in this root shell
    expect(existsSync(path.join(degrade))).toBe(false);
  });

  it('FALLBACK SCORE: a command that falls open runs at score 0, not the server\'s -500 (Luna D0 live re-run finding 2)', () => {
    const degrade = path.join(root.slice, 'degrade-fbscore.log');
    const scoreFile = path.join(root.root, 'score-fb');
    writeFileSync(scoreFile, '-500\n');
    const env = { ...baseEnv(root.slice, degrade), PI_TOOLS_ROOT: path.join(root.root, 'gone2'), PI_TOOLS_CG: path.join(root.root, 'gone2', 'pi-x'), PI_TOOLS_OOM_SCORE_FILE: scoreFile };
    const { out } = runPrefix(root.slice, env, 'echo RAN-FB');
    expect(out).toContain('RAN-FB');
    expect(readFileSync(scoreFile, 'utf8').trim()).toBe('0');
  });

  it('FALLBACK SCORE FAULT: a failed reset on the root-unavailable path is reported, and the command still runs (Luna closure round)', () => {
    const degrade = path.join(root.slice, 'degrade-fbfault.log');
    const scoreDir = mkdtempSync(path.join(tmpdir(), 'd0-score-dir-')); // a directory: the reset write fails
    const env = { ...baseEnv(root.slice, degrade), PI_TOOLS_ROOT: path.join(root.root, 'gone3'), PI_TOOLS_CG: path.join(root.root, 'gone3', 'pi-x'), PI_TOOLS_OOM_SCORE_FILE: scoreDir };
    const { out } = runPrefix(root.slice, env, 'echo RAN-FBFAULT');
    expect(out).toContain('RAN-FBFAULT');
    expect(readFileSync(degrade, 'utf8')).toContain('oom-score-reset-failed');
    rmSync(scoreDir, { recursive: true, force: true });
  });

  it('ROOT MISSING: never creates the root; degrades; command runs', () => {
    const degrade = path.join(root.slice, 'degrade-noroot.log');
    const env = { ...baseEnv(root.slice, degrade), PI_TOOLS_ROOT: path.join(root.root, 'gone'), PI_TOOLS_CG: path.join(root.root, 'gone', 'pi-x') };
    const { out } = runPrefix(root.slice, env, 'echo RAN-NOROOT');
    expect(existsSync(path.join(root.root, 'gone'))).toBe(false);
    expect(readFileSync(degrade, 'utf8')).toContain('root-unavailable');
    expect(out).toContain('RAN-NOROOT');
  });
});

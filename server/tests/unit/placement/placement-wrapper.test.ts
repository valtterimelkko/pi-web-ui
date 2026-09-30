import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { materialiseWrapper } from '../../../src/placement/wrapper.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

const GiB = 1024 * 1024 * 1024;

function fakeRoot(): { root: string; slice: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'd0-wrap-'));
  const slice = path.join(dir, 'pi.slice', 'pi-web-ui.slice', 'pi-web-ui-tools.slice');
  mkdirSync(slice, { recursive: true });
  // Kernel shape for correction-03 root verification: controllers + a numeric bound.
  writeFileSync(path.join(slice, 'cgroup.controllers'), 'cpuset cpu memory pids\n');
  writeFileSync(path.join(slice, 'cgroup.procs'), '');
  writeFileSync(path.join(slice, 'memory.max'), '12884901888\n'); // the slice is bounded
  return { root: dir, slice, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runWrapper(env: Record<string, string>, argv: string[], root: string): { status: number; cgroup?: string } {
  const wrapper = materialiseWrapper(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: root }));
  try {
    const out = execFileSync(wrapper, argv, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { status: 0, cgroup: out.trim() || undefined };
  } catch (err) {
    const e = err as { status?: number };
    return { status: e.status ?? -1 };
  }
}

function writeGroupEnv(slice: string, group: string): Record<string, string> {
  return {
    PI_TOOLS_CG: path.join(slice, group),
    PI_TOOLS_ROOT: slice,
    PI_TOOLS_GROUP: group,
    PI_TOOLS_MEM_MAX: String(6 * GiB),
    PI_TOOLS_MEM_HIGH: String(4 * GiB),
    PI_TOOLS_PIDS_MAX: '2048',
    PI_TOOLS_SWAP_MAX: String(2 * GiB),
    PI_TOOLS_DEGRADE_FILE: path.join(slice, 'degrade.log'),
    PI_TOOLS_SHELL: '/bin/bash',
  };
}

describe('placement wrapper script (real script against a fake cgroup root)', () => {
  const root = fakeRoot();
  afterAll(root.cleanup);

  it('script materialises executable with a POSIX shebang', () => {
    const p = materialiseWrapper(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: root.root }));
    const text = readFileSync(p, 'utf8');
    expect(text.startsWith('#!/bin/sh')).toBe(true);
    expect(existsSync(p)).toBe(true);
  });

  it('creates the group, writes limits, and execs a -c command that reads its placement', () => {
    const env = writeGroupEnv(root.slice, 'pi-s1');
    // A fake root cannot move the process (kernel placement was proven on the real
    // spike cgroups); here we prove the wrapper's logic: it joins the group file.
    const res = runWrapper(env, ['-c', 'cat "$PI_TOOLS_CG/cgroup.procs"'], root.root);
    expect(res.status).toBe(0);
    expect(res.cgroup).toMatch(/^\d+$/); // the wrapper's $$, written into the group file
    expect(readFileSync(path.join(root.slice, 'pi-s1', 'memory.max'), 'utf8').trim()).toBe(String(6 * GiB));
    expect(readFileSync(path.join(root.slice, 'pi-s1', 'memory.high'), 'utf8').trim()).toBe(String(4 * GiB));
    expect(readFileSync(path.join(root.slice, 'pi-s1', 'pids.max'), 'utf8').trim()).toBe('2048');
    expect(readFileSync(path.join(root.slice, 'pi-s1', 'memory.swap.max'), 'utf8').trim()).toBe(String(2 * GiB));
    expect(existsSync(path.join(root.slice, 'degrade.log'))).toBe(false);
  });

  it('joins an existing group without rewriting limits', () => {
    const env = writeGroupEnv(root.slice, 'pi-s2');
    mkdirSync(path.join(root.slice, 'pi-s2'), { recursive: true });
    writeFileSync(path.join(root.slice, 'pi-s2', 'memory.max'), '111\n');
    writeFileSync(path.join(root.slice, 'pi-s2', 'cgroup.procs'), '');
    const res = runWrapper(env, ['-c', 'cat /proc/self/cgroup'], root.root);
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(root.slice, 'pi-s2', 'memory.max'), 'utf8').trim()).toBe('111');
  });

  it('writes limits into a REAL-shaped fresh cgroup (cgroup.procs pre-exists, memory.max=max)', () => {
    // Regression for the limit-write bug the disposable proof caught: a kernel-created
    // cgroup directory already contains cgroup.procs, so a [ ! -f cgroup.procs ]
    // discriminator never fired and per-child limits were silently skipped.
    const env = writeGroupEnv(root.slice, 'pi-s5');
    mkdirSync(path.join(root.slice, 'pi-s5'), { recursive: true });
    writeFileSync(path.join(root.slice, 'pi-s5', 'cgroup.procs'), ''); // kernel shape
    writeFileSync(path.join(root.slice, 'pi-s5', 'memory.max'), 'max\n'); // kernel default
    const res = runWrapper(env, ['-c', 'cat "$PI_TOOLS_CG/cgroup.procs"'], root.root);
    expect(res.status).toBe(0);
    expect(readFileSync(path.join(root.slice, 'pi-s5', 'memory.max'), 'utf8').trim()).toBe(String(6 * GiB));
    expect(readFileSync(path.join(root.slice, 'pi-s5', 'memory.high'), 'utf8').trim()).toBe(String(4 * GiB));
    expect(readFileSync(path.join(root.slice, 'pi-s5', 'pids.max'), 'utf8').trim()).toBe('2048');
    expect(readFileSync(path.join(root.slice, 'pi-s5', 'memory.swap.max'), 'utf8').trim()).toBe(String(2 * GiB));
  });

  it('refuses a group path outside the tools root, degrades, and still runs the command', () => {
    const env = { ...writeGroupEnv(root.slice, 'pi-s3'), PI_TOOLS_CG: path.join(root.root, 'elsewhere', 'g') };
    const res = runWrapper(env, ['-c', 'cat /proc/self/cgroup'], root.root);
    expect(res.status).toBe(0);
    expect(res.cgroup).not.toContain('elsewhere');
    const degrade = readFileSync(path.join(root.slice, 'degrade.log'), 'utf8');
    expect(degrade).toContain('refused-outside-root');
    expect(degrade).toContain('pi-s3');
  });

  it('degrades and falls open when the group cannot be created', () => {
    const env = writeGroupEnv(root.slice, 'pi-s4');
    // Make the slice read-only for mkdir: point ROOT at the slice but make CG land under a file
    writeFileSync(path.join(root.slice, 'blocker'), 'x');
    const badEnv = { ...env, PI_TOOLS_CG: path.join(root.slice, 'blocker', 'child') };
    const res = runWrapper(badEnv, ['-c', 'echo ok'], root.root);
    expect(res.status).toBe(0);
    const degrade = readFileSync(path.join(root.slice, 'degrade.log'), 'utf8');
    expect(degrade).toContain('fell-open');
  });

  it('execs a bare argv command (non -c shape) with placement', () => {
    const env = writeGroupEnv(root.slice, 'rt-x');
    const res = runWrapper(env, ['/bin/sh', '-c', 'cat "$PI_TOOLS_CG/cgroup.procs"'], root.root);
    expect(res.status).toBe(0);
    expect(res.cgroup).toMatch(/^\d+$/);
  });

  it('runs with no placement env at all (fail-open, no crash)', () => {
    const res = runWrapper({}, ['-c', 'echo bare'], root.root);
    expect(res.status).toBe(0);
  });

  it('ROOT MISSING: refuses to create the tools root, degrades, runs unplaced', () => {
    const missingRoot = path.join(root.root, 'no-such-slice');
    const env = writeGroupEnv(root.slice, 'pi-rm');
    const badRoot = { ...env, PI_TOOLS_ROOT: missingRoot, PI_TOOLS_CG: path.join(missingRoot, 'pi-rm') };
    const res = runWrapper(badRoot, ['-c', 'echo ran'], root.root);
    expect(res.status).toBe(0);
    expect(existsSync(path.join(root.root, 'no-such-slice'))).toBe(false); // never mkdir the root
    expect(readFileSync(path.join(root.slice, 'degrade.log'), 'utf8')).toContain('root-missing');
  });

  it('ROOT UNBOUNDED: refuses a root whose memory.max is max with no numeric ancestor', () => {
    const env = writeGroupEnv(root.slice, 'pi-ub');
    const sharedMax = path.join(root.slice, 'memory.max');
    const saved = readFileSync(sharedMax, 'utf8');
    try {
      writeFileSync(sharedMax, 'max\n'); // unbounded slice
      const res = runWrapper(env, ['-c', 'echo ran'], root.root);
      expect(res.status).toBe(0);
      expect(existsSync(path.join(root.slice, 'pi-ub'))).toBe(false); // no group created
      expect(readFileSync(path.join(root.slice, 'degrade.log'), 'utf8')).toContain('root-unbounded');
    } finally {
      writeFileSync(sharedMax, saved); // restore the shared fixture for later tests
    }
  });

  it('LIMIT READ-BACK FAILURE: removes the group, degrades, runs unplaced', () => {
    const env = writeGroupEnv(root.slice, 'pi-rb');
    // Pre-create the leaf kernel-shaped; point its memory.max at /dev/null so the
    // wrapper's write vanishes and the read-back comes back empty (write-or-read
    // failure, deterministically, without needing a mutable filesystem).
    mkdirSync(path.join(root.slice, 'pi-rb'), { recursive: true });
    writeFileSync(path.join(root.slice, 'pi-rb', 'cgroup.procs'), '');
    rmSync(path.join(root.slice, 'pi-rb', 'memory.max'), { force: true });
    symlinkSync('/dev/null', path.join(root.slice, 'pi-rb', 'memory.max'));
    const res = runWrapper(env, ['-c', 'echo ran'], root.root);
    expect(res.status).toBe(0);
    expect(existsSync(path.join(root.slice, 'pi-rb'))).toBe(false); // group removed
    expect(readFileSync(path.join(root.slice, 'degrade.log'), 'utf8')).toContain('limit-readback-failed');
  });

  it('OOM SCORE (answer 04): a placed command runs at oom_score_adj 0', () => {
    const selfAdj = path.join('/proc/self', 'oom_score_adj');
    const before = readFileSync(selfAdj, 'utf8').trim();
    try {
      writeFileSync(selfAdj, '500'); // simulate the inherited -500-inherited... any non-zero inherit
      const env = writeGroupEnv(root.slice, 'pi-oom');
      const res = runWrapper(env, ['-c', 'cat /proc/self/oom_score_adj'], root.root);
      expect(res.status).toBe(0);
      expect(res.cgroup).toBe('0');
    } finally {
      writeFileSync(selfAdj, before);
    }
  });
});

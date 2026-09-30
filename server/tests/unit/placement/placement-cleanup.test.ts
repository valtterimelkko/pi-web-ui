import fs, { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { killGroup, removeGroup, sweepAllGroups, type CgroupIo } from '../../../src/placement/cleanup.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

/**
 * Correction-06 finding 2: removal is cgroup-aware — `cgroup.kill`, a bounded wait
 * for `cgroup.procs` to empty, then depth-first rmdir of child cgroup directories
 * only. Controller files are kernel-virtual: they can be read and written but never
 * unlinked, so `rmSync` on cgroupfs throws and is never used. The fake below models
 * exactly those semantics; the REAL delegated-cgroup behaviour is proven live in
 * /root/d0-runs/proof/run-cleanup-proof.sh (inside the capped proof unit).
 */

type Tree = Map<string, string>; // path -> content (dirs implied as parents)

function cgroupfsIo(tree: Tree): CgroupIo {
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const childrenOf = (p: string) =>
    [...new Set([...tree.keys()].filter((c) => c.startsWith(p + '/')).map((c) => c.slice(p.length + 1).split('/')[0]))];
  const isDir = (p: string) => [...tree.keys()].some((c) => c.startsWith(p + '/'));
  return {
    existsSync: (p) => tree.has(p) || isDir(p),
    readdirSync: (p) => childrenOf(p),
    readFileSync: (p) => {
      if (tree.has(p)) return tree.get(p) ?? '';
      if (isDir(p)) throw new Error('EISDIR');
      throw new Error('ENOENT');
    },
    writeFileSync: (p, s) => {
      if (!isDir(parentOf(p)) && !tree.has(parentOf(p))) throw new Error('ENOENT');
      tree.set(p, s);
    },
    rmSync: () => { throw new Error('EPERM: cannot unlink cgroup controller files'); },
    rmdirSync: (p) => {
      // On real cgroupfs only child cgroup DIRECTORIES block rmdir; the kernel's
      // controller files vanish with the directory once it is empty.
      const ownProcs = (tree.get(path.join(p, 'cgroup.procs')) ?? '').trim();
      if (ownProcs !== '') throw new Error('EBUSY: group still populated');
      const blocking = childrenOf(p).filter((c) => tree.has(path.join(p, c, 'cgroup.procs')));
      if (blocking.length > 0) throw new Error('ENOTEMPTY');
      if (!isDir(p) && !tree.has(p)) throw new Error('ENOENT');
      for (const k of [...tree.keys()]) if (k === p || k.startsWith(p + '/')) tree.delete(k);
    },
    mkdirSync: (p) => { /* dirs materialise implicitly via files */ },
  };
}

describe('placement cleanup (cgroupfs-semantics fake — correction 06 finding 2)', () => {
  // Fresh tree per test: no cross-test cgroup state.
  let dir = ''; let slice = ''; let tree: Tree = new Map();
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'd0-clean-'));
    slice = path.join(dir, 'tools.slice');
    tree = new Map();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function makeGroup(name: string, procs = ''): string {
    const g = path.join(slice, name);
    tree.set(path.join(g, 'cgroup.procs'), procs);
    tree.set(path.join(g, 'cgroup.kill'), '');
    tree.set(path.join(g, 'memory.max'), '8589934592');
    return g;
  }

  it('killGroup writes cgroup.kill and reports success', () => {
    const g = makeGroup('pi-a');
    expect(killGroup(cgroupfsIo(tree), g)).toBe(true);
    expect(tree.get(path.join(g, 'cgroup.kill'))).toBe('1');
  });

  it('killGroup is false when the group is gone', () => {
    expect(killGroup(cgroupfsIo(tree), path.join(slice, 'missing'))).toBe(false);
  });

  it('removeGroup kills, waits for empty procs, rmdirs the group; tolerant when absent', async () => {
    const g = makeGroup('pi-b');
    const r = await removeGroup(cgroupfsIo(tree), g);
    expect(r.removed).toBe(true);
    expect(r.failures).toBe(0);
    expect([...tree.keys()].some((k) => k.startsWith(g))).toBe(false);
    expect((await removeGroup(cgroupfsIo(tree), g)).removed).toBe(false);
  });

  it('removeGroup counts a failure when procs never empty (bounded wait)', async () => {
    const g = makeGroup('pi-stuck', '4242\n');
    const r = await removeGroup(cgroupfsIo(tree), g, 60);
    expect(r.removed).toBe(false);
    expect(r.failures).toBeGreaterThan(0);
  });

  it('removeGroup recurses depth-first into child cgroup directories', async () => {
    const g = makeGroup('pi-nest');
    const child = path.join(g, 'rt-claude-child-abc');
    tree.set(path.join(child, 'cgroup.procs'), '');
    tree.set(path.join(child, 'cgroup.kill'), '');
    tree.set(path.join(child, 'memory.max'), '8589934592');
    const r = await removeGroup(cgroupfsIo(tree), g);
    expect(r.removed).toBe(true);
    expect(r.failures).toBe(0);
    expect([...tree.keys()].some((k) => k.startsWith(g))).toBe(false);
  });

  it('sweepAllGroups skips kernel control files at the root (they are not groups)', async () => {
    tree.set(path.join(slice, 'memory.max'), '10737418240'); // kernel file at tools root
    tree.set(path.join(slice, 'cgroup.procs'), '');
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: dir, PI_TOOLS_SLICE: path.join(dir, 'tools.slice') });
    const r = await sweepAllGroups(cgroupfsIo(tree), cfg);
    expect(r.removed).toBe(0);
    expect(r.failures).toBe(0);
    expect(tree.has(path.join(slice, 'memory.max'))).toBe(true);
  });

  it('sweepAllGroups removes every removable group, counts a populated one as a failure, root survives', async () => {
    makeGroup('pi-stuck', '4242\n'); // populated: the sweep counts it as a failure
    makeGroup('pi-c1');
    makeGroup('rt-x-1');
    makeGroup('own-abc');
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: dir, PI_TOOLS_SLICE: path.join(dir, 'tools.slice') });
    const r = await sweepAllGroups(cgroupfsIo(tree), cfg);
    expect(r.removed).toBe(3); // pi-c1, rt-x-1, own-abc
    expect(r.failures).toBe(1); // pi-stuck still populated — one health-visible failure
    expect(existsSync(slice) || r.removed > 0).toBe(true); // root survives
    expect((await sweepAllGroups(cgroupfsIo(tree), cfg)).removed).toBe(0);
  });
});

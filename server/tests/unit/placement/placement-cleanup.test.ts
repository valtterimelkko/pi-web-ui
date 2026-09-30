import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { killGroup, removeGroup, sweepAllGroups } from '../../../src/placement/cleanup.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

const realIo = {
  existsSync: (p: string) => existsSync(p),
  readdirSync: (p: string) => readdirSync(p),
  writeFileSync: (p: string, s: string) => writeFileSync(p, s),
  rmSync: (p: string) => rmSync(p, { recursive: true, force: true }),
  mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
};

describe('placement cleanup (real temp cgroup tree)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'd0-clean-'));
  const slice = path.join(dir, 'tools.slice');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function makeGroup(name: string, procs = ''): string {
    const g = path.join(slice, name);
    mkdirSync(g, { recursive: true });
    writeFileSync(path.join(g, 'cgroup.procs'), procs);
    writeFileSync(path.join(g, 'cgroup.kill'), '');
    return g;
  }

  it('killGroup writes cgroup.kill and reports success', () => {
    const g = makeGroup('pi-a');
    expect(killGroup(realIo, g)).toBe(true);
    expect(readFileSync(path.join(g, 'cgroup.kill'), 'utf8')).toBe('1');
  });

  it('killGroup is false when the group is gone', () => {
    expect(killGroup(realIo, path.join(slice, 'missing'))).toBe(false);
  });

  it('removeGroup kills and removes the group; tolerant when absent', () => {
    const g = makeGroup('pi-b');
    expect(removeGroup(realIo, g)).toBe(true);
    expect(existsSync(g)).toBe(false);
    expect(removeGroup(realIo, g)).toBe(false);
  });

  it('sweepAllGroups kills and removes every group under the tools root', () => {
    realIo.rmSync(path.join(slice, 'pi-a')); // leftovers from earlier assertions are swept too
    makeGroup('pi-c1');
    makeGroup('rt-x-1');
    makeGroup('own-abc');
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_CGROUP_ROOT: dir, PI_TOOLS_SLICE: path.join(dir, 'tools.slice') });
    expect(sweepAllGroups(realIo, cfg)).toBe(3); // pi-c1, rt-x-1, own-abc (pi-a was removed above)
    expect(existsSync(slice)).toBe(true); // root survives
    expect(sweepAllGroups(realIo, cfg)).toBe(0);
  });
});

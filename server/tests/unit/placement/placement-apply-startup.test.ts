import { describe, expect, it, beforeEach } from 'vitest';
import { resolvePlacementConfig, resolveToolsRoot, type PlacementConfig } from '../../../src/placement/config.js';
import {
  applyStartupPlacement,
  getAppliedPlacement,
  resetAppliedPlacement,
} from '../../../src/placement/apply-startup.js';
import { planSpawnForSession, buildPlacementEnv } from '../../../src/placement/spawn-wrap.js';
import { readToolsSliceMemory } from '../../../src/placement/capacity.js';
import { exportToolsPlacementBridge, clearToolsPlacementBridge, readToolsPlacementBridge } from '../../../src/placement/bridge.js';
import { sweepAllGroups, removeSessionGroup, realCgroupIo, type CgroupIo } from '../../../src/placement/cleanup.js';
import { sessionGroupName } from '../../../src/placement/keys.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Correction-06 finding 1 (major): with a slice NAME (the rollout value), the
 * resolved tools root reached only some consumers. One start-up application must
 * feed EVERY consumer — planning, bridge, health sampler, sweep, session cleanup,
 * split admission read — from the same verified root.
 */

const RESOLVED = '/sys/fs/cgroup/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice';

function nameBasedConfig(): PlacementConfig {
  return resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'pi-web-ui-tools.slice' });
}

function fakeDeps() {
  return {
    systemctlShowControlGroup: () => '/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice',
    exists: (p: string) => p === RESOLVED || p.startsWith(RESOLVED + '/'),
    readFirstLine: (f: string) =>
      f.endsWith('pi-web-ui-tools.slice/cgroup.controllers')
        ? 'cpu memory pids\n'
        : f.endsWith('pi-web-ui-tools.slice/cgroup.subtree_control')
          ? 'cpu memory pids\n' // correction 09: already enabled (systemd-managed slice)
          : f.endsWith('pi-web-ui-tools.slice/memory.max')
            ? '12884901888\n'
            : undefined,
  };
}

function cgroupfsLikeIo(existing: Set<string>): CgroupIo {
  // Mimics cgroupfs: controller files cannot be unlinked; directories rmdir when empty.
  const dirs = existing;
  return {
    existsSync: (p) => dirs.has(p),
    readdirSync: (p) => [...new Set([...dirs].filter((c) => c.startsWith(p + '/')).map((c) => c.slice(p.length + 1).split('/')[0]))],
    readFileSync: (p) => (dirs.has(p) ? '' : (() => { throw new Error('ENOENT'); })()),
    writeFileSync: (p, s) => { if (!dirs.has(path.dirname(p))) throw new Error('ENOENT'); void s; },
    rmSync: () => { throw new Error('EPERM: cannot unlink cgroup controller files'); },
    rmdirSync: (p) => { if (!dirs.delete(p)) throw new Error('ENOTEMPTY'); },
    mkdirSync: (p) => { dirs.add(p); },
  };
}

describe('correction-06 finding 1: one resolved root reaches every consumer', () => {
  beforeEach(() => {
    resetAppliedPlacement();
    clearToolsPlacementBridge();
  });

  it('RED: applyStartupPlacement stores the RESOLVED config for a slice name', () => {
    const cfg = nameBasedConfig();
    expect(cfg.toolsRoot).toBeUndefined(); // name alone resolves nothing
    const applied = applyStartupPlacement(cfg, fakeDeps());
    expect(applied.active).toBe(true);
    expect(applied.config.toolsRoot).toBe(RESOLVED);
    expect(getAppliedPlacement()?.config.toolsRoot).toBe(RESOLVED);
  });

  it('RED: planning + bridge see the verified root after a name-based start-up', () => {
    const applied = applyStartupPlacement(nameBasedConfig(), fakeDeps());
    const plan = planSpawnForSession(applied.config, { runtime: 'claude', id: 'sess-1' }, ['/usr/bin/claude', '-p'], {});
    expect(plan).not.toBeNull();
    expect(plan!.env.PI_TOOLS_CG).toBe(`${RESOLVED}/${sessionGroupName('rt', 'claude', 'sess-1')}`);
    exportToolsPlacementBridge(applied.config);
    expect(readToolsPlacementBridge()?.root).toBe(RESOLVED);
    clearToolsPlacementBridge();
  });

  it('RED: the health sampler reads the tools slice through the applied config', () => {
    const applied = applyStartupPlacement(nameBasedConfig(), fakeDeps());
    const files: Record<string, string> = {
      [`${RESOLVED}/memory.current`]: '1073741824\n',
      [`${RESOLVED}/memory.max`]: '19327352832\n',
    };
    const r = readToolsSliceMemory(applied.config, (f) => files[f]);
    expect(r.source).toBe('tools-slice');
    expect(r.currentBytes).toBe(1073741824);
  });

  it('RED: sweep + session cleanup operate on the resolved root after a name-based start-up', async () => {
    const applied = applyStartupPlacement(nameBasedConfig(), fakeDeps());
    const stale = `${RESOLVED}/pi-stale-1234-abcd1234`;
    const existing = new Set<string>([RESOLVED, stale, `${stale}/cgroup.procs`, `${stale}/cgroup.kill`, `${stale}/memory.max`]);
    const io = cgroupfsLikeIo(existing);
    const swept = await sweepAllGroups(io, applied.config);
    expect(swept.removed).toBe(1);
    expect(existing.has(stale)).toBe(false);
    // session cleanup: deterministic group for a session id
    const group = sessionGroupName('pi', undefined, '01a0f2a6-55e9');
    const gp = `${RESOLVED}/${group}`;
    existing.add(gp); existing.add(`${gp}/cgroup.procs`); existing.add(`${gp}/cgroup.kill`); existing.add(`${gp}/memory.max`);
    const removed = await removeSessionGroup(applied.config, '01a0f2a6-55e9', io);
    expect(removed.removed).toBe(true);
    expect(existing.has(gp)).toBe(false);
  });

  it('CORRECTION 09: enables memory+pids in the tools root subtree_control at start-up', () => {
    // 09-correction root cause: a Delegate=yes slice with no systemd children has an
    // EMPTY cgroup.subtree_control, so child groups get NO limit files (the same class
    // as the 16:56 escape: a group without limits). Start-up must enable the
    // controllers, then read back; still-missing memory/pids => placement unavailable.
    const root = RESOLVED;
    const files = new Map<string, string>([
      [`${root}/cgroup.controllers`, 'cpu memory pids\n'],
      [`${root}/cgroup.subtree_control`, ''], // EMPTY: controllers not yet enabled
      [`${root}/memory.max`, '12884901888\n'],
    ]);
    const enableCalls: Array<{ root: string; controllers: string }> = [];
    const cfg = nameBasedConfig();
    const deps = {
      systemctlShowControlGroup: () => '/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice',
      exists: (p: string) => p === root || p.startsWith(root + '/'),
      readFirstLine: (f: string) => files.get(f),
      enableSubtreeControllers: (r: string, controllers: string) => {
        enableCalls.push({ root: r, controllers });
        const now = (files.get(`${r}/cgroup.subtree_control`) ?? '').split(/\s+/).filter(Boolean);
        for (const token of controllers.split(/\s+/).filter(Boolean)) {
          const c = token.replace(/^\+/, '');
          if (!now.includes(c)) now.push(c);
        }
        files.set(`${r}/cgroup.subtree_control`, now.join(' ') + '\n');
      },
    };
    const applied = applyStartupPlacement(cfg, deps);
    expect(applied.active).toBe(true);
    expect(enableCalls).toHaveLength(1);
    expect(enableCalls[0].root).toBe(root);
    expect(enableCalls[0].controllers).toMatch(/\+memory/);
    expect(enableCalls[0].controllers).toMatch(/\+pids/);
    expect(files.get(`${root}/cgroup.subtree_control`)).toMatch(/memory/);
    expect(files.get(`${root}/cgroup.subtree_control`)).toMatch(/pids/);
  });

  it('CORRECTION 09: placement unavailable when a controller cannot be enabled', () => {
    const root = RESOLVED;
    const cfg = nameBasedConfig();
    const deps = {
      systemctlShowControlGroup: () => '/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice',
      exists: (p: string) => p === root || p.startsWith(root + '/'),
      readFirstLine: (f: string) =>
        f.endsWith('cgroup.controllers') ? 'cpu memory pids\n'
        : f.endsWith('cgroup.subtree_control') ? '' // enable never takes effect
        : f.endsWith('memory.max') ? '12884901888\n'
        : undefined,
      enableSubtreeControllers: () => { /* write silently does nothing */ },
    };
    const applied = applyStartupPlacement(cfg, deps);
    expect(applied.active).toBe(false);
    expect(applied.reason).toMatch(/subtree_control/);
    expect(applied.reason).toMatch(/placement unavailable/i);
  });

  it('an unavailable root disables every consumer', async () => {
    const applied = applyStartupPlacement(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'not-a-known-slice.slice' }), {
      systemctlShowControlGroup: () => undefined,
    });
    expect(applied.active).toBe(false);
    expect(planSpawnForSession(applied.config, { runtime: 'claude', id: 's' }, ['/usr/bin/claude'], {})).toBeNull();
    expect(readToolsSliceMemory(applied.config).source).toBe('unavailable');
    expect((await sweepAllGroups(realCgroupIo, applied.config)).removed).toBe(0);
    expect(() => exportToolsPlacementBridge(applied.config)).toThrow();
    clearToolsPlacementBridge();
  });
});

// keep the import used (resolveToolsRoot exercised indirectly through applyStartupPlacement)
void resolveToolsRoot;
void buildPlacementEnv;
void fs;

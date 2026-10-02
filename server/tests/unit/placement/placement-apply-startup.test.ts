import { describe, expect, it, beforeEach } from 'vitest';
import { resolvePlacementConfig, resolveToolsRoot, type PlacementConfig } from '../../../src/placement/config.js';
import {
  applyStartupPlacement,
  getAppliedPlacement,
  resetAppliedPlacement,
  startupSweepConfig,
} from '../../../src/placement/apply-startup.js';
import { planSpawnForSession, buildPlacementEnv } from '../../../src/placement/spawn-wrap.js';
import { readToolsSliceMemory } from '../../../src/placement/capacity.js';
import { exportToolsPlacementBridge, clearToolsPlacementBridge, readToolsPlacementBridge } from '../../../src/placement/bridge.js';
import { sweepAllGroups, removeSessionGroup, realCgroupIo, type CgroupIo } from '../../../src/placement/cleanup.js';
import { sessionGroupName } from '../../../src/placement/keys.js';
import { validationPlacementRefusalForConfig } from '../../../src/placement/validation-gate.js';
import fs from 'node:fs';
import os from 'node:os';
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
    // J6 correction 02: the realpath dep defaults to the real fs; these fixtures
    // model a synthetic tree, so they pin canonicalisation to identity.
    realpath: (p: string) => p,
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
      realpath: (p: string) => p,
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
      realpath: (p: string) => p,
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

  it('CORRECTION 09: sweep kills only session-shaped groups — never foreign slice residents', async () => {
    // 09-correction live check: the sweep killed the slice HOLDER service (a systemd
    // .service cgroup inside the slice), which tore the slice down and emptied its
    // subtree_control. The sweep must only ever touch groups the server created.
    const applied = applyStartupPlacement(nameBasedConfig(), fakeDeps());
    const stale = `${RESOLVED}/pi-stale-1234-abcd1234`;
    const holder = `${RESOLVED}/d0-final-slice-holder.service`;
    const existing = new Set<string>([
      RESOLVED,
      stale, `${stale}/cgroup.procs`, `${stale}/cgroup.kill`, `${stale}/memory.max`,
      holder, `${holder}/cgroup.procs`, `${holder}/memory.max`, // foreign: systemd's own
      `${RESOLVED}/own-abc123`, `${RESOLVED}/own-abc123/cgroup.procs`, `${RESOLVED}/own-abc123/memory.max`,
      `${RESOLVED}/rt-claude-sess-9-1a2b3c4d`, `${RESOLVED}/rt-claude-sess-9-1a2b3c4d/cgroup.procs`,
    ]);
    const io = cgroupfsLikeIo(existing);
    const swept = await sweepAllGroups(io, applied.config);
    expect(swept.removed).toBe(3); // stale pi group + own group + rt group
    expect(existing.has(stale)).toBe(false);
    expect(existing.has(holder)).toBe(true); // UNTOUCHED
    expect(existing.has(`${holder}/cgroup.procs`)).toBe(true);
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

describe('J6 correction 02: the sweep runs only for a validated, active applied root', () => {
  beforeEach(() => {
    resetAppliedPlacement();
  });

  it('a resolution failure leaves NO sweepable root at startup (raw toolsRoot must never sweep)', async () => {
    // An absolute slicePath puts a RAW toolsRoot on the config before resolution.
    // Verification must fail here (no memory controller), and the failed resolution
    // must leave nothing for the startup or shutdown sweep to act on.
    const rawRoot = '/sys/fs/cgroup/system.slice/d0-scope/tools';
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: rawRoot });
    expect(cfg.toolsRoot).toBe(rawRoot); // raw, pre-verification
    const applied = applyStartupPlacement(cfg, {
      realpath: (p) => p,
      exists: () => true,
      readFirstLine: (f) => (f.endsWith('tools/cgroup.controllers') ? 'pids\n' : undefined), // no memory controller
    });
    expect(applied.active).toBe(false);
    const sc = startupSweepConfig(applied);
    expect(sc.enabled).toBe(false);
    expect(sc.toolsRoot).toBeUndefined();
    // Even with a populated group sitting at the raw root, the sweep must no-op.
    const stale = `${rawRoot}/pi-stale-1234-abcd1234`;
    const existing = new Set<string>([rawRoot, stale, `${stale}/cgroup.procs`, `${stale}/cgroup.kill`, `${stale}/memory.max`]);
    const swept = await sweepAllGroups(cgroupfsLikeIo(existing), sc);
    expect(swept).toEqual({ removed: 0, failures: 0 });
    expect(existing.has(stale)).toBe(true);
  });

  it('a production-shaped config (slice name) still resolves and the startup sweep still reaps a planted group', async () => {
    const root = '/sys/fs/cgroup/system.slice/fake-anchor.service';
    const applied = applyStartupPlacement(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'fake-anchor.service' }), {
      realpath: (p) => p,
      systemctlShowControlGroup: () => '/system.slice/fake-anchor.service',
      exists: (p) => p === root,
      readFirstLine: (f) =>
        f.endsWith('fake-anchor.service/cgroup.controllers')
          ? 'cpu memory pids\n'
          : f.endsWith('fake-anchor.service/cgroup.subtree_control')
            ? 'cpu memory pids\n'
            : f.endsWith('fake-anchor.service/memory.max')
              ? 'max\n' // the anchor itself is unlimited; its slice is the bound
              : f.endsWith('/memory.max')
                ? '12884901888\n'
                : undefined,
      enableSubtreeControllers: () => {},
    });
    expect(applied.active).toBe(true);
    const sc = startupSweepConfig(applied);
    expect(sc.enabled).toBe(true);
    expect(sc.toolsRoot).toBe(root);
    const stale = `${root}/pi-stale-1234-abcd1234`;
    const existing = new Set<string>([root, stale, `${stale}/cgroup.procs`, `${stale}/cgroup.kill`, `${stale}/memory.max`]);
    const swept = await sweepAllGroups(cgroupfsLikeIo(existing), sc);
    expect(swept.removed).toBe(1);
    expect(existing.has(stale)).toBe(false);
  });

  it('an inactive application never sweeps, even though the raw config still carries the absolute root', async () => {
    const rawRoot = '/sys/fs/cgroup/system.slice/d0-scope/tools';
    const applied = applyStartupPlacement(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: rawRoot }), {
      realpath: (p) => p,
      exists: () => false, // root missing: resolution fails
    });
    expect(applied.active).toBe(false);
    const sc = startupSweepConfig(applied);
    const stale = `${rawRoot}/pi-stale-1234-abcd1234`;
    const existing = new Set<string>([rawRoot, stale, `${stale}/cgroup.procs`]);
    const swept = await sweepAllGroups(cgroupfsLikeIo(existing), sc);
    expect(swept).toEqual({ removed: 0, failures: 0 });
    expect(existing.has(stale)).toBe(true);
  });
});

// keep the import used (resolveToolsRoot exercised indirectly through applyStartupPlacement)
void resolveToolsRoot;
void buildPlacementEnv;
void fs;

const { readFileSync } = fs;

describe('J6 correction 03: apply runs the SCREENED root — no second resolution of the raw alias', () => {
  beforeEach(() => {
    resetAppliedPlacement();
  });

  it('hands the screened canonical root through applyStartupPlacement; the raw alias is never re-resolved', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: '/tmp/alias-raw' });
    const screened = '/sys/fs/cgroup/system.slice/screened-run.service';
    const applied = applyStartupPlacement(
      cfg,
      {
        realpath: (p) => (p === screened ? screened : `/tmp/evil-${p}`),
        exists: (p) => p === screened,
        readFirstLine: (f) =>
          f.endsWith('screened-run.service/cgroup.controllers')
            ? 'cpu memory pids\n'
            : f.endsWith('screened-run.service/cgroup.subtree_control')
              ? 'cpu memory pids\n'
              : f.endsWith('/memory.max')
                ? '12884901888\n'
                : undefined,
      },
      { screenedCanonicalRoot: screened },
    );
    expect(applied.active).toBe(true);
    expect(applied.config.toolsRoot).toBe(screened); // the screened root, not a fresh raw resolution
  });

  it('RACE: gate screens a safe alias, the alias is retargeted to a fake pi-web-ui-tools.slice tree, apply fails closed — no write, no sweep, planted group survives', async () => {
    const { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync, realpathSync } = fs;
    const { tmpdir } = os;
    const tmp = mkdtempSync(path.join(tmpdir(), 'j6-c03-race-'));
    try {
      // The screened target: a plain safe unit directory in the run's own tree.
      const safe = path.join(tmp, 'real', 'safe-unit');
      mkdirSync(safe, { recursive: true });
      // The evil tree: a directory NAMED like the production tools slice holding a
      // planted managed group — a temp tree, never the real production path.
      const evil = path.join(tmp, 'real', 'pi-web-ui-tools.slice', 'evil-unit');
      mkdirSync(evil, { recursive: true });
      const planted = path.join(evil, 'pi-planted-1234-abcd1234');
      mkdirSync(planted, { recursive: true });
      writeFileSync(path.join(planted, 'cgroup.procs'), '');
      writeFileSync(path.join(planted, 'cgroup.kill'), '');
      // Make the evil tree look verifiable so a WRONG (re-resolving) apply would
      // happily activate it (this is exactly the pre-fix behaviour under test).
      writeFileSync(path.join(evil, 'cgroup.controllers'), 'cpu memory pids\n');
      const evilSubtreeFixture = 'cpu memory pids\n';
      writeFileSync(path.join(evil, 'cgroup.subtree_control'), evilSubtreeFixture);
      writeFileSync(path.join(tmp, 'memory.max'), '12884901888\n');

      const alias = path.join(tmp, 'alias');
      symlinkSync(safe, alias);
      const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: alias, PI_TOOLS_CGROUP_ROOT: tmp });

      // 1. The gate screens the SAFE target and hands back the canonical path.
      const verdict = validationPlacementRefusalForConfig(cfg, { cgroupRoot: tmp, realpath: (p) => realpathSync(p) });
      expect(verdict.refusal).toBeNull();
      const screened = verdict.canonical as string;
      expect(screened).toBe(safe);

      // 2. The race: retarget the alias at the evil tree and take the safe
      //    target away (the screened path no longer exists — a re-resolving
      //    apply would now activate the evil tree).
      rmSync(alias);
      symlinkSync(evil, alias);
      rmSync(safe, { recursive: true });

      // 3. Apply with the SCREENED root: fail closed — the screened path no longer
      //    canonicalises, so placement is unavailable and NOTHING is written.
      const applied = applyStartupPlacement(
        cfg,
        { realpath: (p) => realpathSync(p) },
        { screenedCanonicalRoot: screened },
      );
      expect(applied.active).toBe(false);
      expect(applied.reason).toMatch(/changed since screening/i);

      // No subtree_control write anywhere in the temp tree (the pre-fix code
      // resolved the alias afresh, activated the evil tree and enabled
      // controllers there — which would have appended '+memory +pids').
      expect(readFileSync(path.join(evil, 'cgroup.subtree_control'), 'utf8')).toBe(evilSubtreeFixture);

      // 4. The sweep runs on nothing: startupSweepConfig must not carry a root.
      const sc = startupSweepConfig(applied);
      expect(sc.enabled).toBe(false);
      expect(sc.toolsRoot).toBeUndefined();
      const existing = new Set<string>([evil, planted, `${planted}/cgroup.procs`, `${planted}/cgroup.kill`]);
      const swept = await sweepAllGroups(cgroupfsLikeIo(existing), sc);
      expect(swept).toEqual({ removed: 0, failures: 0 });
      expect(existing.has(planted)).toBe(true); // the planted fake group survives
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

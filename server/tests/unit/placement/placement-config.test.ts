import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePlacementConfig, resolveToolsRoot } from '../../../src/placement/config.js';

describe('test-process isolation from production placement (Luna D0 live re-run)', () => {
  it('a config built without PI_TOOLS_RUNTIME_DIR never points at production\'s runtime dir', () => {
    // Tests run as root: the default ~/.pi-web-ui/placement IS production's wrapper
    // and degrade log. materialiseWrapper and appendDegradeLine write there.
    const prod = path.join(os.homedir(), '.pi-web-ui', 'placement');
    expect(resolvePlacementConfig({}).runtimeDir).not.toBe(prod);
    expect(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on' }).runtimeDir).not.toBe(prod);
  });

  it('inherited placement variables are stripped (a placed production shell injects them)', () => {
    const inherited = Object.keys(process.env).filter((k) => k.startsWith('PI_TOOLS_') && k !== 'PI_TOOLS_RUNTIME_DIR');
    expect(inherited).toEqual([]);
  });
});

describe('placement config', () => {
  it('defaults to disabled', () => {
    const cfg = resolvePlacementConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it('enables only on PI_TOOLS_PLACEMENT=on', () => {
    expect(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on' }).enabled).toBe(true);
    expect(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'off' }).enabled).toBe(false);
    expect(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'yes' }).enabled).toBe(false);
  });

  it('a slice NAME leaves toolsRoot unset until resolveToolsRoot verifies it', () => {
    const cfg = resolvePlacementConfig({});
    expect(cfg.cgroupRoot).toBe('/sys/fs/cgroup');
    expect(cfg.slicePath).toBe('pi-web-ui-tools.slice');
    expect(cfg.toolsRoot).toBeUndefined(); // never derived from the name
  });

  it('honours env overrides for root, slice and runtime dir', () => {
    const cfg = resolvePlacementConfig({
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: '/tmp/fake-cg',
      PI_TOOLS_SLICE: '/tmp/fake-cg/test.slice',
      PI_TOOLS_RUNTIME_DIR: '/tmp/d0-runtime',
    });
    expect(cfg.toolsRoot).toBe('/tmp/fake-cg/test.slice');
    expect(cfg.runtimeDir).toBe('/tmp/d0-runtime');
  });

  it('applies the amendment-A minimum per-child defaults', () => {
    const cfg = resolvePlacementConfig({});
    const GiB = 1024 * 1024 * 1024;
    expect(cfg.perChild.memoryMaxBytes).toBeGreaterThanOrEqual(8 * GiB);
    expect(cfg.perChild.memoryHighBytes).toBeGreaterThanOrEqual(6 * GiB);
    expect(cfg.perChild.pidsMax).toBeGreaterThanOrEqual(2048);
    expect(cfg.perChild.swapMaxBytes).toBeGreaterThan(0);
  });

  it('parses numeric per-child overrides and rejects invalid ones', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PER_CHILD_MEM_MAX: String(9 * 1024 * 1024 * 1024) });
    expect(cfg.perChild.memoryMaxBytes).toBe(9 * 1024 * 1024 * 1024);
    const bad = resolvePlacementConfig({ PI_TOOLS_PER_CHILD_MEM_MAX: 'banana' });
    expect(bad.perChild.memoryMaxBytes).toBe(resolvePlacementConfig({}).perChild.memoryMaxBytes);
  });

  it('defaults to the production SLICE NAME, not a path', () => {
    expect(resolvePlacementConfig({}).slicePath).toBe('pi-web-ui-tools.slice');
  });
});

describe('tools root resolution (correction 03: name/path confusion)', () => {
  const base = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on' });

  it('resolves a slice NAME via systemctl show (never treated as a cgroup path)', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'pi-web-ui-tools.slice' });
    const root = '/sys/fs/cgroup/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice';
    const r = resolveToolsRoot(cfg, {
      systemctlShowControlGroup: () => '/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice',
      exists: (p) => p === root,
      readFirstLine: (f) => (f.endsWith('pi-web-ui-tools.slice/cgroup.controllers') ? 'cpu memory pids\n' : f.endsWith('pi-web-ui-tools.slice/cgroup.subtree_control') ? 'cpu memory pids\n' : f.endsWith('pi-web-ui-tools.slice/memory.max') ? '12884901888\n' : undefined),
    });
    expect(r.available).toBe(true);
    expect(r.toolsRoot).toBe(root);
  });

  it('resolves a delegated anchor SERVICE name via systemctl show; bounded by its slice (rollout finding 2026-09-30)', () => {
    // systemd 255 ignores Delegate= on slices, so every daemon-reload cleared the slice's
    // subtree_control. The tools root is a Delegate=yes service inside the slice instead.
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'pi-web-ui-tools-anchor.service' });
    const slice = '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice';
    const root = `${slice}/pi-web-ui-tools-anchor.service`;
    const files: Record<string, string> = {
      [`${root}/cgroup.controllers`]: 'cpuset cpu io memory pids\n',
      [`${root}/cgroup.subtree_control`]: 'cpu memory pids\n',
      [`${root}/memory.max`]: 'max\n', // the anchor itself is unlimited...
      [`${slice}/memory.max`]: '19327352832\n', // ...its slice is the bound
    };
    const r = resolveToolsRoot(cfg, {
      systemctlShowControlGroup: () => '/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service',
      exists: (p) => p === root,
      readFirstLine: (f) => files[f],
    });
    expect(r.available).toBe(true);
    expect(r.toolsRoot).toBe(root);
  });

  it('REJECTS a slice name systemd does not know (the 16:56 escape: an unresolved name must never become a path)', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'pi-d0-proof-tools.slice' });
    const r = resolveToolsRoot(cfg, { systemctlShowControlGroup: () => undefined });
    expect(r.available).toBe(false);
    expect(r.toolsRoot).toBeUndefined();
  });

  it('accepts an absolute cgroup path under the cgroup root', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: '/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools' });
    const r = resolveToolsRoot(cfg, {
      exists: () => true,
      readFirstLine: (f) => (f.endsWith('tools/cgroup.controllers') ? 'cpu memory pids\n' : f.endsWith('tools/cgroup.subtree_control') ? 'cpu memory pids\n' : f.endsWith('scope/memory.max') ? '12884901888\n' : undefined),
    });
    expect(r.available).toBe(true);
    expect(r.toolsRoot).toBe('/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools');
  });

  it('rejects a relative non-slice path (neither name nor absolute path)', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice' });
    const r = resolveToolsRoot(cfg, {});
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/not a slice name and not an absolute path/i);
  });

  it('rejects an absolute path outside the cgroup root', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: '/etc/passwd' });
    const r = resolveToolsRoot(cfg, {});
    expect(r.available).toBe(false);
  });

  it('verifies an existing absolute root: memory controller and a numeric bound up the chain', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: '/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools' });
    const files: Record<string, string> = {
      '/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools/cgroup.controllers': 'cpuset cpu memory pids\n',
      '/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools/cgroup.subtree_control': 'cpuset cpu memory pids\n', // correction 09: controllers enabled
      '/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools/memory.max': 'max\n', // leaf unbounded...
      '/sys/fs/cgroup/system.slice/d0-proof-run.scope/memory.max': '12884901888\n', // ...but the parent scope is numeric
    };
    const r = resolveToolsRoot(cfg, { exists: (p) => p === cfg.toolsRoot || p === '/sys/fs/cgroup/system.slice/d0-proof-run.scope', readFirstLine: (f) => files[f] });
    expect(r.available).toBe(true);
    const unbounded = resolveToolsRoot(cfg, {
      exists: (p) => p === cfg.toolsRoot || p === '/sys/fs/cgroup/system.slice/d0-proof-run.scope',
      readFirstLine: (f) => (f.endsWith('scope/memory.max') ? 'max\n' : files[f]),
    });
    expect(unbounded.available).toBe(false);
    expect(unbounded.reason).toMatch(/unbounded/i);
  });

  it('rejects an existing root without the memory controller', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: '/sys/fs/cgroup/system.slice/d0-proof-run.scope/tools' });
    const r = resolveToolsRoot(cfg, {
      exists: () => true,
      readFirstLine: (f) => (f.endsWith('tools/cgroup.controllers') ? 'pids\n' : 'max\n'),
    });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/memory controller/i);
  });
});

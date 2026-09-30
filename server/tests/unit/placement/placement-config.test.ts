import { describe, expect, it } from 'vitest';
import { resolvePlacementConfig, resolveToolsRoot } from '../../../src/placement/config.js';

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
      readFirstLine: (f) => (f.endsWith('pi-web-ui-tools.slice/cgroup.controllers') ? 'cpu memory pids\n' : f.endsWith('pi-web-ui-tools.slice/memory.max') ? '12884901888\n' : undefined),
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
      readFirstLine: (f) => (f.endsWith('tools/cgroup.controllers') ? 'cpu memory pids\n' : f.endsWith('scope/memory.max') ? '12884901888\n' : undefined),
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

import { describe, expect, it } from 'vitest';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

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

  it('derives the tools root from the cgroup root and slice path', () => {
    const cfg = resolvePlacementConfig({});
    expect(cfg.cgroupRoot).toBe('/sys/fs/cgroup');
    expect(cfg.slicePath).toBe('pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice');
    expect(cfg.toolsRoot).toBe('/sys/fs/cgroup/pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice');
  });

  it('honours env overrides for root, slice and runtime dir', () => {
    const cfg = resolvePlacementConfig({
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: '/tmp/fake-cg',
      PI_TOOLS_SLICE: 'test.slice',
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
});

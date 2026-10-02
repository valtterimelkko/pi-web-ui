/**
 * J6 defence-in-depth (01-design.md §3.2 as hardened by 01-answer.md): in
 * validation mode a disposable server must never enable placement — and
 * therefore never sweep — a tools root the run does not own:
 *
 *   1. the production anchor/tools-slice NAME forms, refused BEFORE
 *      `resolveToolsRoot` touches any `cgroup.subtree_control`;
 *   2. the absolute-path form of any path at or under the production tools
 *      slice (`pi-web-ui-tools.slice`), whatever the anchor is called;
 *   3. the RESOLVED root sitting at or under the production tools slice;
 *   4. the resolved root being the server's own cgroup or an ancestor of it.
 *
 * Outside validation mode the gate is inert: production behaviour is
 * byte-identical.
 */
import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_TOOLS_ANCHOR_SLICE,
  PRODUCTION_TOOLS_SLICE_NAME,
  validationPlacementRefusal,
} from '../../../src/placement/validation-gate.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

const ANCHOR_ABS = '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service';
const THROWAWAY_ROOT = '/sys/fs/cgroup/system.slice/j6ctl-76814d1a6b47.service';

function input(overrides: {
  validationMode?: boolean;
  slicePath?: string;
  resolvedRoot?: string;
  selfCgroupPath?: string | null;
}) {
  return {
    validationMode: true,
    cfg: resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: overrides.slicePath ?? THROWAWAY_ROOT }),
    resolvedRoot: overrides.resolvedRoot,
    selfCgroupPath: overrides.selfCgroupPath ?? '/system.slice/pi-web-ui.service',
  };
}

describe('J6 validation-mode placement gate', () => {
  it('exposes the production names it refuses', () => {
    expect(PRODUCTION_TOOLS_ANCHOR_SLICE).toBe('pi-web-ui-tools-anchor.service');
    expect(PRODUCTION_TOOLS_SLICE_NAME).toBe('pi-web-ui-tools.slice');
  });

  it('refuses the production anchor NAME before any resolution side effect', () => {
    expect(validationPlacementRefusal(input({ slicePath: PRODUCTION_TOOLS_ANCHOR_SLICE }))).toBe('production-name-form');
    // No resolvedRoot is consulted: the refusal is already decided.
  });

  it('refuses the production tools-slice NAME too (resolution would write its subtree_control)', () => {
    expect(validationPlacementRefusal(input({ slicePath: PRODUCTION_TOOLS_SLICE_NAME }))).toBe('production-name-form');
  });

  it('refuses the anchor ABSOLUTE-PATH form (raw path at or under the tools slice)', () => {
    expect(validationPlacementRefusal(input({ slicePath: ANCHOR_ABS }))).toBe('production-tools-slice-root');
  });

  it('refuses the tools-slice ABSOLUTE-PATH form itself', () => {
    const sliceAbs = ANCHOR_ABS.replace(/\/pi-web-ui-tools-anchor\.service$/, '');
    expect(validationPlacementRefusal(input({ slicePath: sliceAbs }))).toBe('production-tools-slice-root');
  });

  it('refuses a RESOLVED root at or under the production tools slice, whatever the anchor is called', () => {
    expect(
      validationPlacementRefusal(input({ slicePath: 'renamed-anchor.service', resolvedRoot: ANCHOR_ABS })),
    ).toBe('production-tools-slice-root');
  });

  it('refuses a resolved root that is the server own cgroup or an ancestor of it', () => {
    expect(
      validationPlacementRefusal(input({ resolvedRoot: '/system.slice/pi-web-ui.service' })),
    ).toBe('own-cgroup-root');
    expect(
      validationPlacementRefusal(input({ resolvedRoot: '/system.slice', selfCgroupPath: '/system.slice/pi-web-ui.service' })),
    ).toBe('own-cgroup-root');
    // A sibling root (the proof run's own throwaway unit) is NOT the server's own cgroup.
    expect(
      validationPlacementRefusal(input({ resolvedRoot: THROWAWAY_ROOT })),
    ).toBeNull();
  });

  it('allows a validation run pointed at its own throwaway unit root', () => {
    expect(validationPlacementRefusal(input({ slicePath: 'j6ctl-76814d1a6b47.service', resolvedRoot: THROWAWAY_ROOT }))).toBeNull();
  });

  it('is inert outside validation mode — production behaviour is unchanged', () => {
    const prod = { ...input({ slicePath: PRODUCTION_TOOLS_ANCHOR_SLICE, resolvedRoot: ANCHOR_ABS }), validationMode: false };
    expect(validationPlacementRefusal(prod)).toBeNull();
  });

  it('is inert when placement is disabled', () => {
    const off = input({ slicePath: PRODUCTION_TOOLS_ANCHOR_SLICE });
    (off.cfg as { enabled: boolean }).enabled = false;
    expect(validationPlacementRefusal(off)).toBeNull();
  });
});

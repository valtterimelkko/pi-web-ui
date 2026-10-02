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
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PRODUCTION_TOOLS_ANCHOR_SLICE,
  PRODUCTION_TOOLS_SLICE_NAME,
  validationPlacementRefusal,
  validationPlacementRefusalForConfig,
} from '../../../src/placement/validation-gate.js';
import { candidateToolsRootPath } from '../../../src/placement/config.js';
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

describe('J6 correction 02: own-cgroup comparison in one coordinate system', () => {
  it('refuses a cgroup-relative self path against a filesystem-form resolved root (prefix the cgroup root)', () => {
    expect(
      validationPlacementRefusal({
        validationMode: true,
        cfg: resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'some-run.service' }),
        cgroupRoot: '/sys/fs/cgroup',
        resolvedRoot: '/sys/fs/cgroup/system.slice/pi-web-ui.service',
        selfCgroupPath: '/system.slice/pi-web-ui.service',
      }),
    ).toBe('own-cgroup-root');
  });

  it('refuses an ancestor in the same coordinate system', () => {
    expect(
      validationPlacementRefusal({
        validationMode: true,
        cfg: resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'some-run.service' }),
        cgroupRoot: '/sys/fs/cgroup',
        resolvedRoot: '/sys/fs/cgroup/system.slice',
        selfCgroupPath: '/system.slice/pi-web-ui.service',
      }),
    ).toBe('own-cgroup-root');
  });

  it('still allows a sibling root after conversion', () => {
    expect(
      validationPlacementRefusal({
        validationMode: true,
        cfg: resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'some-run.service' }),
        cgroupRoot: '/sys/fs/cgroup',
        resolvedRoot: '/sys/fs/cgroup/system.slice/j6b-031fe826.service',
        selfCgroupPath: '/system.slice/pi-web-ui.service',
      }),
    ).toBeNull();
  });
});

describe('J6 correction 02: canonicalise the candidate before any write, then gate it', () => {
  it('candidateToolsRootPath computes the raw candidate: name via systemctl, absolute verbatim, garbage rejected', () => {
    const nameCfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'my-unit.service' });
    expect(candidateToolsRootPath(nameCfg, { systemctlShowControlGroup: () => '/system.slice/my-unit.service' })).toEqual({ ok: true, path: '/sys/fs/cgroup/system.slice/my-unit.service' });
    expect(candidateToolsRootPath(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'no-such-unit.service' }), { systemctlShowControlGroup: () => undefined }).ok).toBe(false);
    const absCfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: '/sys/fs/cgroup/system.slice/x.service' });
    expect(candidateToolsRootPath(absCfg, {})).toEqual({ ok: true, path: '/sys/fs/cgroup/system.slice/x.service' });
    expect(candidateToolsRootPath(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'not/a/name' }), {}).ok).toBe(false);
  });

  it('refuses an alias whose SYMLINK resolves under a directory named like the production tools slice (real fs, no write)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'j6-gate-alias-'));
    try {
      const target = join(tmp, 'real', PRODUCTION_TOOLS_SLICE_NAME, 'j6-throwaway-unit');
      mkdirSync(target, { recursive: true });
      const alias = join(tmp, 'alias');
      symlinkSync(target, alias);
      // Explicit fs realpath (the composed check must canonicalise, never
      // compare the raw symlink path — the raw form carries no slice segment).
      const refusal = validationPlacementRefusalForConfig(
        resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: alias }),
        { cgroupRoot: tmp, selfCgroupPath: '/system.slice/pi-web-ui.service', realpath: (p) => realpathSync(p) },
      );
      expect(refusal).toBe('production-tools-slice-root');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a candidate that cannot be canonicalised (dangling symlink)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'j6-gate-dangling-'));
    try {
      const dangling = join(tmp, 'dangling');
      symlinkSync(join(tmp, 'missing-target'), dangling);
      const refusal = validationPlacementRefusalForConfig(
        resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: dangling }),
        { cgroupRoot: tmp },
      );
      expect(refusal).toBe('not-canonicalisable');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses the REAL filesystem realpath by default for the alias check (no identity shortcut)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'j6-gate-real-'));
    try {
      const target = join(tmp, 'real', PRODUCTION_TOOLS_SLICE_NAME, 'j6-throwaway-unit');
      mkdirSync(target, { recursive: true });
      const alias = join(tmp, 'alias');
      symlinkSync(target, alias);
      const refusal = validationPlacementRefusalForConfig(
        resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: alias }),
        { cgroupRoot: tmp, selfCgroupPath: null },
      );
      expect(refusal).toBe('production-tools-slice-root');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes the CONFIG slice name to the systemctl dep, not the ambient environment (arm2 regression)', () => {
    // Pre-fix, forConfig forwarded { systemctlShowControlGroup: undefined }, the
    // merge clobbered the default with undefined, and the default itself read
    // the slice from process.env instead of the config — every explicit
    // slice-NAME placement run was refused as not-canonicalisable (live:
    // phaseB-run-20261002T150126Z arm2). The dep must be called with the
    // config's own slicePath.
    const asked: string[] = [];
    const refusal = validationPlacementRefusalForConfig(
      resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'j6-run.service' }),
      {
        cgroupRoot: '/sys/fs/cgroup',
        selfCgroupPath: '/system.slice/pi-web-ui.service',
        systemctlShowControlGroup: (unit) => {
          asked.push(unit);
          return unit === 'j6-run.service' ? '/system.slice/j6-run.service' : undefined;
        },
        realpath: (p) => p,
      },
    );
    expect(asked).toContain('j6-run.service');
    expect(refusal).toBeNull();
  });

  it('still refuses the production NAME forms and allows the run-owned unit through the composed check', () => {
    const deps = { cgroupRoot: '/sys/fs/cgroup', selfCgroupPath: '/system.slice/pi-web-ui.service' };
    expect(
      validationPlacementRefusalForConfig(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: PRODUCTION_TOOLS_ANCHOR_SLICE }), deps),
    ).toBe('production-name-form');
    expect(
      validationPlacementRefusalForConfig(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on', PI_TOOLS_SLICE: 'j6b-031fe826.service' }), {
        ...deps,
        systemctlShowControlGroup: () => '/system.slice/j6b-031fe826.service',
        realpath: (p) => p, // synthetic target: the run-owned path is not on the real fs
      }),
    ).toBeNull();
  });

  it('is inert outside validation mode', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'j6-gate-inert-'));
    try {
      const target = join(tmp, 'real', PRODUCTION_TOOLS_SLICE_NAME, 'unit');
      mkdirSync(target, { recursive: true });
      const alias = join(tmp, 'alias');
      symlinkSync(target, alias);
      expect(
        validationPlacementRefusalForConfig(resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'off', PI_TOOLS_SLICE: alias }), { cgroupRoot: tmp }),
      ).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * D0 placement configuration: agents' tool processes out of the control plane's cgroup.
 *
 * Mechanism (01-design.md, accepted in 01-answer.md): a delegated sibling tools slice
 * (`pi-web-ui-tools.slice`) holds one cgroup per child session; commands are placed by
 * a POSIX-sh wrapper (argv spawns) or an in-shell prefix line (bash tool / command
 * strings). Placement defaults to OFF; when off, argv and environment are byte-identical
 * to the pre-D0 behaviour.
 *
 * Per-child defaults implement amendment A's decision rule. The floors are the answer's
 * minimums; the shipped numbers come from the measured sizing run recorded in
 * `defaults.ts` and the D0 evidence bundle (orchestration-scaling/D0 in the plan's execution reports).
 */
import child from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PER_CHILD } from './defaults.js';
export { DEFAULT_PER_CHILD, MEASURED_SIZING } from './defaults.js';

export interface PlacementPerChildLimits {
  memoryMaxBytes: number;
  memoryHighBytes: number;
  pidsMax: number;
  swapMaxBytes: number;
}

export interface PlacementConfig {
  enabled: boolean;
  cgroupRoot: string;
  slicePath: string;
  /**
   * Absolute cgroup path of the tools root — set directly when PI_TOOLS_SLICE is an
   * absolute path; for a slice NAME it stays undefined until `resolveToolsRoot`
   * resolves and verifies it at start-up (correction 03). Plans treat an undefined
   * root as placement-unavailable (byte-identical fallback).
   */
  toolsRoot?: string;
  runtimeDir: string;
  perChild: PlacementPerChildLimits;
}

const GiB = 1024 * 1024 * 1024;

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function resolvePlacementConfig(env: NodeJS.ProcessEnv = process.env): PlacementConfig {
  const enabled = env.PI_TOOLS_PLACEMENT === 'on';
  const cgroupRoot = (env.PI_TOOLS_CGROUP_ROOT ?? '/sys/fs/cgroup').replace(/\/+$/, '');
  // Correction 03: this is a SLICE NAME (resolved via `systemctl show`) or an
  // absolute cgroup path. A bare relative path is neither and is rejected at
  // start-up — the 16:56 escape came from treating a name as a path.
  const slicePath = (env.PI_TOOLS_SLICE ?? 'pi-web-ui-tools.slice').replace(/\/+$/, '');
  const runtimeDir = env.PI_TOOLS_RUNTIME_DIR ?? path.join(os.homedir(), '.pi-web-ui', 'placement');
  // Amendment A decision rule: per-child max = max(8 GiB, 1.5 × measured peak),
  // high = max(6 GiB, 1.2 × peak), pids = max(2048, 2 × peak). `defaults.ts` holds the
  // measured peaks and the derived shipped values; env overrides win for ops tuning.
  const perChild: PlacementPerChildLimits = {
    memoryMaxBytes: parsePositiveInt(env.PI_TOOLS_PER_CHILD_MEM_MAX) ?? DEFAULT_PER_CHILD.memoryMaxBytes,
    memoryHighBytes: parsePositiveInt(env.PI_TOOLS_PER_CHILD_MEM_HIGH) ?? DEFAULT_PER_CHILD.memoryHighBytes,
    pidsMax: parsePositiveInt(env.PI_TOOLS_PER_CHILD_PIDS_MAX) ?? DEFAULT_PER_CHILD.pidsMax,
    swapMaxBytes: parsePositiveInt(env.PI_TOOLS_PER_CHILD_SWAP_MAX) ?? DEFAULT_PER_CHILD.swapMaxBytes,
  };
  const toolsRoot = slicePath.startsWith('/') && slicePath.startsWith(cgroupRoot + '/')
    ? slicePath.replace(/\/+$/, '')
    : undefined;
  return {
    enabled,
    cgroupRoot,
    slicePath,
    toolsRoot,
    runtimeDir,
    perChild,
  };
}

/** Wrapper script + degrade log live in the server-owned runtime dir. */
export function placementWrapperPath(cfg: PlacementConfig): string {
  return path.join(cfg.runtimeDir, 'placement-wrapper.sh');
}

export interface ToolsRootResolution {
  available: boolean;
  toolsRoot?: string;
  reason?: string;
}

export interface ToolsRootDeps {
  /** `systemctl show <unit> -p ControlGroup --value` output (undefined = unit unknown). */
  systemctlShowControlGroup?: () => string | undefined;
  exists?: (p: string) => boolean;
  readFirstLine?: (p: string) => string | undefined;
  /** Correction 09: write e.g. `+memory +pids` into `<root>/cgroup.subtree_control`.
   * A slice holds no processes directly, so enabling controllers there is allowed.
   * May throw (real cgroupfs returns EACCES/ENOENT); resolveToolsRoot falls back to
   * the read-back check. */
  enableSubtreeControllers?: (root: string, controllers: string) => void;
}

const defaultToolsRootDeps: ToolsRootDeps = {
  systemctlShowControlGroup: () => {
    try {
      const out = child.execFileSync('systemctl', ['show', resolvePlacementConfig().slicePath, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' });
      const v = out.trim();
      return v && v !== '' ? v : undefined;
    } catch {
      return undefined;
    }
  },
  exists: (p) => fs.existsSync(p),
  readFirstLine: (p) => {
    try {
      return fs.readFileSync(p, 'utf8').split('\n')[0];
    } catch {
      return undefined;
    }
  },
  // Correction 09: one write enables several controllers at once (cgroupfs v2 accepts
  // a space-separated list; already-enabled entries are a no-op).
  enableSubtreeControllers: (root, controllers) => {
    fs.writeFileSync(path.join(root, 'cgroup.subtree_control'), `${controllers}\n`);
  },
};

/**
 * Correction 03 item 2+4: resolve and VERIFY the tools root before use.
 * - a slice NAME is resolved with `systemctl show`; an unknown name is an error,
 *   never silently treated as a cgroup path (the 16:56 escape);
 * - an absolute path must sit under the cgroup root and exist;
 * - the root must exist, expose the memory controller, and be BOUNDED: its own
 *   `memory.max`, or an ancestor's up to 4 levels, must read as a number (not `max`).
 */
export function resolveToolsRoot(cfg: PlacementConfig, deps: ToolsRootDeps = {}): ToolsRootResolution {
  const d = { ...defaultToolsRootDeps, ...deps };
  const raw = cfg.slicePath;
  let root: string;
  if (raw.startsWith('/')) {
    if (!raw.startsWith(cfg.cgroupRoot + '/')) {
      return { available: false, reason: `tools root ${raw} is outside the cgroup root ${cfg.cgroupRoot}` };
    }
    root = raw.replace(/\/+$/, '');
  } else if (/^[A-Za-z0-9.@_-]+\.slice$/.test(raw)) {
    const cg = d.systemctlShowControlGroup?.();
    if (!cg || !cg.startsWith('/')) {
      return { available: false, reason: `slice ${raw} is not known to systemd — refusing to treat the name as a cgroup path` };
    }
    root = path.posix.join(cfg.cgroupRoot, cg.replace(/\/+$/, ''));
  } else {
    return { available: false, reason: `PI_TOOLS_SLICE value ${JSON.stringify(raw)} is not a slice name and not an absolute path` };
  }
  if (!d.exists?.(root)) {
    return { available: false, reason: `tools root ${root} does not exist (is the slice started?)` };
  }
  const controllers = d.readFirstLine?.(`${root}/cgroup.controllers`) ?? '';
  if (!controllers.split(/\s+/).includes('memory')) {
    return { available: false, reason: `tools root ${root} does not expose the memory controller` };
  }
  // Correction 09 (root cause of the failed decisive check): a Delegate=yes slice with
  // no systemd children has an EMPTY cgroup.subtree_control, so child groups are created
  // WITHOUT limit files (the same class as the 16:56 escape — a group without limits).
  // Enable the controllers this mechanism needs, then READ BACK; if memory or pids is
  // still missing, placement is unavailable (fail-open with a clear reason).
  const enabledNow = (): string[] =>
    (d.readFirstLine?.(`${root}/cgroup.subtree_control`) ?? '')
      .split(/\s+/).filter(Boolean).map((t) => t.replace(/^\+/, ''));
  const wanted = ['memory', 'pids', ...(controllers.split(/\s+/).includes('cpu') ? ['cpu'] : [])];
  const missing = wanted.filter((c) => !enabledNow().includes(c));
  if (missing.length > 0) {
    try {
      d.enableSubtreeControllers?.(root, missing.map((c) => `+${c}`).join(' '));
    } catch {
      // fall through to the read-back verification
    }
  }
  const stillMissing = ['memory', 'pids'].filter((c) => !enabledNow().includes(c));
  if (stillMissing.length > 0) {
    return {
      available: false,
      reason: `tools root ${root}: ${stillMissing.join(' and ')} controller(s) could not be enabled in cgroup.subtree_control — child groups would have no limit files (placement unavailable)`,
    };
  }
  // Boundedness: the root's own memory.max, or an ancestor's (up to 4 levels),
  // must be a number — a `max` root means a runaway group is unbounded.
  let dir = root;
  for (let depth = 0; depth <= 4 && dir.startsWith(cfg.cgroupRoot); depth++) {
    const v = d.readFirstLine?.(`${dir}/memory.max`)?.trim();
    if (v !== undefined && v !== '' && v !== 'max' && Number.isFinite(Number(v)) && Number(v) > 0) {
      return { available: true, toolsRoot: root };
    }
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { available: false, reason: `tools root ${root} is unbounded (no numeric memory.max within 4 ancestor levels)` };
}

export function placementDegradeFilePath(cfg: PlacementConfig): string {
  return path.join(cfg.runtimeDir, 'degrade.log');
}

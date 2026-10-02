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
  // The process-wide PI_TOOLS_RUNTIME_DIR is the fallback for callers passing their own
  // env object: in production env IS process.env; the test setup points it at a temp
  // dir so no test writes production's wrapper or degrade log (Luna D0 live re-run).
  const runtimeDir = env.PI_TOOLS_RUNTIME_DIR ?? process.env.PI_TOOLS_RUNTIME_DIR ?? path.join(os.homedir(), '.pi-web-ui', 'placement');
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
  /** `systemctl show <unit> -p ControlGroup --value` output for THE CONFIG'S unit (undefined = unit unknown). */
  systemctlShowControlGroup?: (unit: string) => string | undefined;
  exists?: (p: string) => boolean;
  readFirstLine?: (p: string) => string | undefined;
  /** Correction 09: write e.g. `+memory +pids` into `<root>/cgroup.subtree_control`.
   * A slice holds no processes directly, so enabling controllers there is allowed.
   * May throw (real cgroupfs returns EACCES/ENOENT); resolveToolsRoot falls back to
   * the read-back check. */
  enableSubtreeControllers?: (root: string, controllers: string) => void;
  /** J6 correction 02: canonicalise the candidate root (default fs.realpathSync).
   * Fixtures over synthetic trees pin this to identity; the real default follows
   * symlinks so an alias can never hide what it points at. */
  realpath?: (p: string) => string;
}

/** Defaults, with explicitly-undefined dep keys filtered so they cannot clobber them. */
function mergeDeps(deps: ToolsRootDeps): ToolsRootDeps {
  const supplied = Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined));
  return { ...defaultToolsRootDeps, ...supplied };
}

/**
 * J6 correction 03: a cgroup root of '' or '/' (the empty-ish forms
 * `PI_TOOLS_CGROUP_ROOT=/` and `PI_TOOLS_CGROUP_ROOT=` normalise to) makes
 * every `startsWith(cgroupRoot + '/')` containment check pass — degenerate,
 * and treated as invalid wherever a cgroup root is consumed. The production
 * default `/sys/fs/cgroup` is unaffected.
 */
export function isDegenerateCgroupRoot(cgroupRoot: string | undefined): boolean {
  return (cgroupRoot ?? '').replace(/\/+$/, '') === '';
}

const defaultToolsRootDeps: ToolsRootDeps = {
  // J6 correction 02: the unit comes from the ARGUMENT (the config's own
  // slicePath), never from a re-read of process.env — a caller whose config
  // differs from the environment would otherwise resolve the WRONG unit.
  systemctlShowControlGroup: (unit) => {
    try {
      const out = child.execFileSync('systemctl', ['show', unit, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' });
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
 * The candidate tools root PATH, computed WITHOUT touching the filesystem (a
 * slice NAME is resolved read-only via `systemctl show`; an absolute path is
 * taken verbatim). J6 correction 02: callers canonicalise this candidate and
 * gate on the canonical path BEFORE `resolveToolsRoot` performs any write.
 */
export type CandidateToolsRoot = { ok: true; path: string } | { ok: false; reason: string };

export function candidateToolsRootPath(cfg: Pick<PlacementConfig, 'cgroupRoot' | 'slicePath'>, deps: ToolsRootDeps = {}): CandidateToolsRoot {
  // J6 correction 02: an explicitly-undefined key must not clobber the default
  // ({ ...defaults, ...{ k: undefined } } sets k to undefined); callers that
  // forward optional deps verbatim would otherwise disable resolution.
  const d = mergeDeps(deps);
  const raw = cfg.slicePath;
  if (raw.startsWith('/')) {
    return { ok: true, path: raw.replace(/\/+$/, '') };
  }
  if (/^[A-Za-z0-9.@_-]+\.(slice|service)$/.test(raw)) {
    const cg = d.systemctlShowControlGroup?.(raw);
    if (!cg || !cg.startsWith('/')) {
      return { ok: false, reason: `unit ${raw} is not known to systemd — refusing to treat the name as a cgroup path` };
    }
    return { ok: true, path: path.posix.join(cfg.cgroupRoot, cg.replace(/\/+$/, '')) };
  }
  return { ok: false, reason: `PI_TOOLS_SLICE value ${JSON.stringify(raw)} is not a slice name and not an absolute path (nor a service name)` };
}

/**
 * Correction 03 item 2+4: resolve and VERIFY the tools root before use.
 * - a slice NAME is resolved with `systemctl show`; an unknown name is an error,
 *   never silently treated as a cgroup path (the 16:56 escape);
 * - an absolute path must sit under the cgroup root and exist;
 * - J6 correction 02: the candidate is CANONICALISED (fs.realpathSync — symlinks
 *   followed) BEFORE any write (the `cgroup.subtree_control` enable below
 *   included), and a canonical path that escapes the cgroup root, or a root
 *   that cannot be canonicalised at all, is refused — an alias can never hide
 *   where it really points;
 * - the root must exist, expose the memory controller, and be BOUNDED: its own
 *   `memory.max`, or an ancestor's up to 4 levels, must read as a number (not `max`).
 */
export interface ResolveToolsRootOptions {
  /**
   * J6 correction 03: the canonical root the validation gate already screened.
   * When given, resolution does NOT re-resolve the raw slice path (the alias
   * may have been retargeted between screening and apply — the TOCTOU window):
   * it uses the screened path and re-canonicalises it immediately before the
   * first write. Any difference fails closed: unavailable, "tools root changed
   * since screening", no write and no sweep.
   */
  screenedCanonicalRoot?: string;
}

export function resolveToolsRoot(cfg: PlacementConfig, deps: ToolsRootDeps = {}, options: ResolveToolsRootOptions = {}): ToolsRootResolution {
  const d = mergeDeps(deps);
  // J6 correction 03: a degenerate cgroup root invalidates every containment
  // check — refuse before resolving anything.
  if (isDegenerateCgroupRoot(cfg.cgroupRoot)) {
    return { available: false, reason: `cgroup root ${JSON.stringify(cfg.cgroupRoot)} is degenerate — refusing to resolve any tools root against it` };
  }
  const screened = options.screenedCanonicalRoot?.replace(/\/+$/, '');
  let root: string;
  if (screened) {
    // The root that is applied must be the root that was screened: re-
    // canonicalise the screened path immediately, fail closed on any change.
    let now: string;
    try {
      now = d.realpath ? d.realpath(screened) : fs.realpathSync(screened);
    } catch {
      return { available: false, reason: `tools root ${screened} changed since screening (cannot be canonicalised)` };
    }
    if (now !== screened) {
      return { available: false, reason: `tools root changed since screening (${screened} -> ${now})` };
    }
    // The screened root skips the raw-path branch below, so its containment
    // check runs here, before any write.
    if (!screened.startsWith(cfg.cgroupRoot + '/')) {
      return { available: false, reason: `tools root ${screened} is outside the cgroup root ${cfg.cgroupRoot}` };
    }
    root = screened;
  } else {
    const cand = candidateToolsRootPath(cfg, d);
    if (!cand.ok) {
      return { available: false, reason: cand.reason };
    }
    root = cand.path;
    if (root.startsWith('/') && !root.startsWith(cfg.cgroupRoot + '/')) {
      return { available: false, reason: `tools root ${root} is outside the cgroup root ${cfg.cgroupRoot}` };
    }
    // J6 correction 02: canonicalise BEFORE any write, then re-check containment —
    // a symlink inside the cgroup root may point anywhere.
    try {
      root = d.realpath ? d.realpath(root) : fs.realpathSync(root);
    } catch {
      return { available: false, reason: `tools root ${cand.path} cannot be canonicalised` };
    }
    if (!root.startsWith(cfg.cgroupRoot + '/')) {
      return { available: false, reason: `tools root ${root} resolves outside the cgroup root ${cfg.cgroupRoot}` };
    }
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

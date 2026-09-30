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
 * `defaults.ts` and `docs/plans/execution-reports/orchestration-scaling/D0.md`.
 */
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
  toolsRoot: string;
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
  const slicePath = (env.PI_TOOLS_SLICE ?? 'pi.slice/pi-web-ui.slice/pi-web-ui-tools.slice').replace(/^\/+|\/+$/g, '');
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
  return {
    enabled,
    cgroupRoot,
    slicePath,
    toolsRoot: path.posix.join(cgroupRoot, slicePath),
    runtimeDir,
    perChild,
  };
}

/** Wrapper script + degrade log live in the server-owned runtime dir. */
export function placementWrapperPath(cfg: PlacementConfig): string {
  return path.join(cfg.runtimeDir, 'placement-wrapper.sh');
}

export function placementDegradeFilePath(cfg: PlacementConfig): string {
  return path.join(cfg.runtimeDir, 'degrade.log');
}

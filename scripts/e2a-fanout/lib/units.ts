/**
 * systemd-run argv builders for the lane's disposable units. Every unit is
 * named `e2a-4-*`, lives in the `e2a-4.slice` lane slice, and carries a hard
 * memory cap + swap cap + runtime cap (STRESS-GATE containment).
 */
/**
 * The anchor's start script, written to disk by the driver: finds the anchor's
 * own cgroup (minus the DelegateSubgroup=supervisor leaf), enables the
 * subtree controllers, then sleeps. Kept in a FILE because a transient
 * unit's ExecStart argv would otherwise go through systemd's `$` expansion
 * (the deploy unit file escapes `$$`; argv must carry no `$` at all).
 */
export function anchorStartScript(): string {
  return [
    '#!/bin/sh',
    '# E2a-4 lane tools anchor (mirrors deploy/pi-web-ui-tools-anchor.service).',
    "r=$(sed -n 's|^0::||;s|/supervisor$||p' /proc/self/cgroup)",
    '[ -d "$r" ] || exit 1',
    "echo '+cpu +memory +pids' > \"$r/cgroup.subtree_control\" || exit 1",
    'exec sleep infinity',
    '',
  ].join('\n');
}

export interface AnchorUnitOptions {
  unit: string;
  slice: string;
  scriptPath: string;
}

/**
 * Mirror of deploy/pi-web-ui-tools-anchor.service as a transient unit: a
 * delegated service whose ExecStart enables the subtree controllers and then
 * sleeps, so the server can create limited per-child groups under it.
 */
export function buildAnchorUnitArgs(opts: AnchorUnitOptions): string[] {
  return [
    'systemd-run',
    '--unit=' + opts.unit,
    '--slice=' + opts.slice,
    '--collect',
    '--property=Type=exec',
    '--property=Delegate=cpu memory pids',
    '--property=DelegateSubgroup=supervisor',
    '--property=OOMPolicy=continue',
    '--property=OOMScoreAdjust=-1000',
    '--property=ExitType=cgroup',
    '--property=Restart=no',
    '--',
    '/bin/sh',
    opts.scriptPath,
  ];
}

export interface ServerUnitOptions {
  unit: string;
  slice: string;
  worktreeRoot: string;
  validationDir: string;
  httpPort: number;
  memoryMax: string; // ≤ 8G for this lane (smoke: 2G)
  runtimeMaxSec: number;
  env: Record<string, string>;
  /** Extra --setenv entries (isolation env), merged after the mirrored env. */
  extraEnv?: Record<string, string>;
}

const PLACEMENT_UNSET_VARS = 'PI_TOOLS_PLACEMENT PI_TOOLS_SLICE PI_TOOLS_CGROUP_ROOT PI_TOOLS_RUNTIME_DIR';

/**
 * The disposable server: production-like (compiled dist), bounded, explicit
 * env allowlist (the J6-belt pattern from scripts/heap-soak/launcher.ts) with
 * UnsetEnvironment clearing the inherited production placement first.
 */
export function buildServerUnitArgs(opts: ServerUnitOptions): string[] {
  const argv = [
    'systemd-run',
    '--unit=' + opts.unit,
    '--slice=' + opts.slice,
    '--collect',
    '--property=Restart=no',
    '--working-directory=' + opts.worktreeRoot,
    '--property=MemoryMax=' + opts.memoryMax,
    '--property=MemorySwapMax=1G',
    '--property=RuntimeMaxSec=' + String(opts.runtimeMaxSec),
    '--property=TasksMax=8192',
    '--property=UnsetEnvironment=' + PLACEMENT_UNSET_VARS,
  ];
  for (const [k, v] of Object.entries({ ...opts.env, ...(opts.extraEnv ?? {}) })) {
    argv.push(`--setenv=${k}=${v}`);
  }
  argv.push(
    '--',
    'npx',
    'tsx',
    'scripts/validation-server.ts',
    `--dir=${opts.validationDir}`,
    '--compiled',
    `--port=${String(opts.httpPort)}`,
  );
  return argv;
}

/** Unit names must always carry the lane prefix (the guard stops e2a-4-* units on a hard trip). */
export function assertLaneUnitName(unit: string): void {
  if (!unit.startsWith('e2a-4-') && unit !== 'e2a-4-tools-anchor.service') {
    throw new Error(`unit name outside the lane namespace: ${unit}`);
  }
}

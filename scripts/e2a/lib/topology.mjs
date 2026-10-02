// E2a-3 harness — disposable topology builders: the e2a-3.slice + anchor + server transient units
// mirroring production's pi-web-ui.service / pi-web-ui-tools.slice / pi-web-ui-tools-anchor.service
// at scaled-down limits (lane brief "Production topology to mirror").
//
// Every unit this module builds is named e2a-3-* so the host guard's stop path covers it.

export const LANE = 'e2a-3';

export function sliceName() {
  return `${LANE}.slice`;
}

export function serverUnitName() {
  return `${LANE}-server.service`;
}

export function anchorUnitName() {
  return `${LANE}-tools-anchor.service`;
}

/**
 * The anchor: production's pi-web-ui-tools-anchor.service, scaled down.
 * Delegate on a SERVICE (systemd 255 ignores it on slices — D0.md §10),
 * DelegateSubgroup=supervisor so the subtree controllers can be enabled,
 * ExitType=cgroup + OOMPolicy=continue so a child kill never tears the unit,
 * ExecStart re-enables +cpu +memory +pids itself (no-internal-processes rule).
 */
export function buildAnchorUnitArgv({ anchorUnit = anchorUnitName(), slice = sliceName() } = {}) {
  // Positional command (becomes the unit's ExecStart): re-enables +cpu +memory +pids in
  // the anchor's own subtree (no-internal-processes rule), then sleeps forever. Passed as
  // argv (no shell of ours), so plain `$` — no unit-file `$$` escaping here.
  const payload =
    'r=/sys/fs/cgroup$(sed -n "s|^0::||;s|/supervisor$||p" /proc/self/cgroup); ' +
    '[ -d "$r" ] || exit 1; ' +
    'echo "+cpu +memory +pids" > "$r/cgroup.subtree_control" || exit 1; ' +
    'exec sleep infinity';
  return [
    'systemd-run',
    `--unit=${anchorUnit}`,
    '--collect',
    '--quiet',
    `--property=Slice=${slice}`,
    '--property=Delegate=cpu memory pids',
    '--property=DelegateSubgroup=supervisor',
    '--property=OOMPolicy=continue',
    '--property=OOMScoreAdjust=-1000',
    '--property=ExitType=cgroup',
    '--property=Restart=always',
    '--property=RestartSec=2',
    '--',
    '/bin/sh',
    '-c',
    payload,
  ];
}

/**
 * The disposable server unit. Production placement env must arrive through the
 * validation server's own --env-file/--env-key mechanism (the wrapper strips
 * every inherited PI_TOOLS_* key unconditionally), and the unit additionally
 * carries UnsetEnvironment so the manager's environment can never leak them.
 */
export function buildServerUnitArgv({
  unit = serverUnitName(),
  slice = sliceName(),
  memoryMax = '2G',
  runtimeMaxSec = 300,
  workdir,
  validationDir,
  port,
  env = {},
  envFile,
  envKeys = ['PI_TOOLS_PLACEMENT', 'PI_TOOLS_SLICE'],
  executable = 'npx',
  executableArgs = ['tsx', 'scripts/validation-server.ts'],
} = {}) {
  if (!workdir || !validationDir || !port || !envFile) throw new Error('workdir, validationDir, port and envFile are required');
  const argv = [
    'systemd-run',
    `--unit=${unit}`,
    '--collect',
    '--quiet',
    `--property=Slice=${slice}`,
    `--property=MemoryMax=${memoryMax}`,
    '--property=MemorySwapMax=1G',
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    '--property=Restart=no',
    '--property=UnsetEnvironment=PI_TOOLS_PLACEMENT PI_TOOLS_SLICE PI_TOOLS_CGROUP_ROOT PI_TOOLS_RUNTIME_DIR',
    `--property=WorkingDirectory=${workdir}`,
  ];
  for (const [k, v] of Object.entries(env)) argv.push(`--setenv=${k}=${v}`);
  argv.push(
    '--',
    executable,
    ...executableArgs,
    // Space-separated flag form: the wrapper's getFlag() only matches the exact
    // flag token followed by the value (equals-form is silently ignored there).
    '--dir', validationDir,
    '--port', String(port),
    '--env-file', envFile,
    ...envKeys.flatMap((k) => ['--env-key', k]),
    '--compiled',
  );
  return argv;
}

/** Content of the placement env file consumed by the disposable server's --env-file. */
export function buildPlacementEnvFile({ slice = anchorUnitName() } = {}) {
  return `PI_TOOLS_PLACEMENT=on\nPI_TOOLS_SLICE=${slice}\n`;
}

/**
 * Isolation env for the server unit beyond what the validation wrapper does
 * itself (fake HOME redirect, isolated agent dir, Agent OS stubs — the
 * scripts/heap-soak/launcher.ts pattern).
 */
export function buildServerIsolationEnv({ runDir, agentDir }) {
  const fakeHome = `${runDir}/home`;
  return {
    HOME: fakeHome,
    PI_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    AGENT_OS_BIN: `${runDir}/agent-os-stub.mjs`,
    BOARD_STORE_DIR: `${runDir}/board-store`,
    AGENT_OS_VAULT_ROOT: `${fakeHome}/agent-os-memory-vault`,
    PI_WEB_UI_GOAL_HOME: `${runDir}/goal-home`,
    PI_BG_TASKS_DIR: `${runDir}/bg-tasks`,
    PI_COMPACTION_LOG: `${runDir}/compaction.log`,
  };
}

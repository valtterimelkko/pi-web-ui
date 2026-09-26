/**
 * Minimal transient-systemd-unit wrapper for the heap soak harness's two
 * long-lived processes (the disposable server, and the sampler+driver
 * supervisor). Deliberately simpler than
 * server/src/workers/worker-launcher.ts's TransientSystemdWorkerLauncher
 * (that one contains untrusted short-lived per-turn workers with strict
 * cgroup/token verification); these two units are the harness's own trusted
 * long-lived infrastructure, started once per run and torn down by run id.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface SystemdRunOptions {
  unitName: string;
  /** Slice for grouping (optional). */
  sliceName?: string;
  properties?: Record<string, string>;
  env?: Record<string, string>;
  restart?: 'no' | 'on-failure';
  workingDirectory?: string;
  executable: string;
  args: string[];
}

export interface UnitStatus {
  loadState: string;
  activeState: string;
  subState: string;
  mainPid?: number;
}

function parseProperties(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const sep = line.indexOf('=');
    if (sep <= 0) continue;
    result[line.slice(0, sep)] = line.slice(sep + 1);
  }
  return result;
}

/** Start a transient systemd unit running `executable args…`, detached from this process's lifetime. */
export async function startTransientUnit(options: SystemdRunOptions): Promise<void> {
  const args = [
    '--unit', options.unitName,
    ...(options.sliceName ? ['--slice', options.sliceName] : []),
    '--collect',
    `--property=Restart=${options.restart ?? 'no'}`,
    ...(options.workingDirectory ? [`--working-directory=${options.workingDirectory}`] : []),
    ...Object.entries(options.properties ?? {}).map(([k, v]) => `--property=${k}=${v}`),
    ...Object.entries(options.env ?? {}).map(([k, v]) => `--setenv=${k}=${v}`),
    '--',
    options.executable,
    ...options.args,
  ];
  await execFile('systemd-run', args);
}

export async function getUnitStatus(unitName: string): Promise<UnitStatus> {
  try {
    const { stdout } = await execFile('systemctl', [
      'show', unitName, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '--no-pager',
    ]);
    const props = parseProperties(stdout);
    const mainPid = Number(props.MainPID);
    return {
      loadState: props.LoadState ?? 'not-found',
      activeState: props.ActiveState ?? 'unknown',
      subState: props.SubState ?? 'unknown',
      mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : undefined,
    };
  } catch {
    return { loadState: 'not-found', activeState: 'unknown', subState: 'unknown' };
  }
}

export async function stopUnit(unitName: string): Promise<void> {
  try {
    await execFile('systemctl', ['stop', unitName]);
  } catch {
    // Already gone — stop is idempotent for our purposes.
  }
}

/**
 * `systemctl kill` with a signal — used by Gate 1 to prove supervisor-restart-
 * and-reattach. `--kill-who=main` targets only the unit's main PID: the
 * default (`--kill-who=all`, sending the signal to every process in the
 * unit's cgroup including any short-lived auxiliary/control process) was
 * observed live to fail with "Failed to send signal SIGKILL to auxiliary
 * processes: Invalid argument" on this host/systemd version even though the
 * main process itself was perfectly killable — main-only is also the more
 * precise target for this use (kill exactly the supervisor process, not
 * whatever else happens to share its cgroup).
 */
export async function killUnit(unitName: string, signal: string = 'SIGKILL'): Promise<void> {
  await execFile('systemctl', ['kill', unitName, `--signal=${signal}`, '--kill-who=main']);
}

/** Wait until the unit's LoadState reaches 'not-found' (collected) or the deadline passes. */
export async function waitForUnitGone(unitName: string, timeoutMs = 10_000, pollMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getUnitStatus(unitName);
    if (status.loadState === 'not-found') return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return (await getUnitStatus(unitName)).loadState === 'not-found';
}

/** Wait until the unit reports a live MainPID (server/supervisor process has actually started). */
export async function waitForMainPid(unitName: string, timeoutMs = 15_000, pollMs = 200): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last: UnitStatus | undefined;
  while (Date.now() < deadline) {
    last = await getUnitStatus(unitName);
    if (last.mainPid) return last.mainPid;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Unit ${unitName} never reported a MainPID (last status: ${JSON.stringify(last)})`);
}

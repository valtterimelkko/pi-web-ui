/**
 * Disposable Pi Web UI server in production's topology for the E2a-6c
 * crash-recovery arms: own containing slice (hard MemoryMax ≤ 12G), a
 * delegated tools anchor copied from production's unit properties
 * (/root/pi-web-ui/deploy/, read-only), and the server with placement ON
 * pointing at OUR anchor — asserted by script never to be production's root.
 *
 * The server itself is the repo's own disposable validation server entrypoint
 * (isolated dirs, isolated socket/token, J6 placement-env strip + explicit
 * --env-file/--env-key channel), launched as a transient `k-K-arm-server`
 * unit. Arm mode mirrors production's restart properties (Restart=always,
 * RestartSec=10s, TimeoutStopSec=30s — 01-answer Q3): the SIGKILLed unit is
 * restarted by systemd, not by the driver (smoke stays Restart=no).
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import { anchorUnitName, serverUnitName, sliceName, type RunPaths } from './paths.ts';

const execFile = promisify(execFileCb);

export interface ServerMode {
  memoryMax: string;
  runtimeMaxSec: number;
  /** 01-answer Q3: the kill arm mirrors production — systemd restarts the
   * SIGKILLed unit (Restart=always, RestartSec=10s, TimeoutStopSec=30s) and
   * the driver must NOT start it by hand. Smoke stays Restart=no. */
  restart: 'no' | 'always';
}

export const SMOKE_MODE: ServerMode = { memoryMax: '6G', runtimeMaxSec: 300, restart: 'no' };
// SMOKE_MODE deviation from STRESS-GATE's "MemoryMax=2G" smoke bound, measured
// 2026-10-02: at 2G the server's own admission preflight refuses ALL model
// turns (emergencyMode, memory_pressure: base RSS ~0.94G + 512M reserved/turn
// leaves projected headroom 673M < minimum 1.6G — /capacity evidence in the
// report). 6G is the smallest practical cap that admits ≤2 small children,
// still ≤ the binding 12G containment cap, with the same 300 s runtime,
// ≤2 children, and no deliberate allocation/CPU burn. Flagged to the parent.
export const ARM_MODE: ServerMode = { memoryMax: '8G', runtimeMaxSec: 7200, restart: 'always' };
// ARM restart properties mirror production's unit verbatim (01-answer Q3):
// Restart=always, RestartSec=10s, TimeoutStopSec=30s, KillMode=control-group.
// MemoryMax=8G (not 12G) per 07-answer: the guard soft-alerts below 8 GiB
// MemAvailable — the arm server must stay comfortably inside it.

async function systemctl(...args: string[]): Promise<string> {
  const { stdout } = await execFile('systemctl', [...args, '--no-pager']);
  return stdout;
}

async function systemdRun(args: string[]): Promise<void> {
  await execFile('systemd-run', ['--collect', '--quiet', ...args]);
}

export async function findFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no ephemeral port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface UnitStatus {
  activeState: string;
  mainPid?: number;
  controlGroup?: string;
}

export async function getUnitStatus(unit: string): Promise<UnitStatus> {
  try {
    const out = await systemctl('show', unit, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlGroup');
    const props: Record<string, string> = {};
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    const mainPid = Number(props.MainPID);
    return {
      activeState: props.ActiveState ?? 'unknown',
      mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : undefined,
      controlGroup: props.ControlGroup || undefined,
    };
  } catch {
    return { activeState: 'not-found' };
  }
}

/** The production anchor's properties this harness copies (from /root/pi-web-ui/deploy/, read-only). */
export const ANCHOR_PROPERTIES_COPIED = [
  'Delegate=cpu memory pids',
  'DelegateSubgroup=supervisor',
  'OOMPolicy=continue',
  'OOMScoreAdjust=-1000',
  'ExitType=cgroup',
  'Restart=always',
  'RestartSec=2',
] as const;

// The anchor's ExecStart logic from the production unit (subtree_control
// re-enable trick), written as a shell script by prepareServerEnv and used as
// the transient unit's command (systemd-run requires a positional command).
const ANCHOR_START_SCRIPT = [
  '#!/bin/sh',
  "# E2a-6c delegated anchor start (copied from production's anchor ExecStart).",
  'r=/sys/fs/cgroup$(sed -n "s|^0::||;s|/supervisor$||p" /proc/self/cgroup)',
  '[ -d "$r" ] || exit 1',
  'echo "+cpu +memory +pids" > "$r/cgroup.subtree_control" || exit 1',
  'exec sleep infinity',
  '',
].join('\n');

/** Start the delegated anchor (idempotent: no-op when already active). */
export async function startAnchorUnit(anchorScriptPath: string): Promise<void> {
  const unit = anchorUnitName();
  const status = await getUnitStatus(unit);
  if (status.activeState === 'active') return;
  await systemdRun([
    '--unit', unit,
    '--slice', sliceName(),
    '--property', 'Restart=always',
    '--property', 'RestartSec=2',
    '--property', 'MemoryMax=6G',
    '--property', 'MemoryHigh=5G',
    '--property', 'Delegate=cpu memory pids',
    '--property', 'DelegateSubgroup=supervisor',
    '--property', 'OOMPolicy=continue',
    '--property', 'OOMScoreAdjust=-1000',
    '--property', 'ExitType=cgroup',
    '--',
    '/bin/sh', anchorScriptPath,
  ]);
  // Wait for it to report a MainPID.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const s = await getUnitStatus(unit);
    if (s.mainPid) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Anchor unit ${unit} never reported a MainPID`);
}

/**
 * Assert the resolved placement root is OURS, never production's: the anchor
 * unit's cgroup must live under the k-K-arm slice and must not be (or live
 * under) the production tools anchor.
 */
export async function assertPlacementRootIsolated(): Promise<string> {
  const anchor = await getUnitStatus(anchorUnitName());
  const cg = anchor.controlGroup ?? '';
  if (!cg.includes('k-K-arm')) {
    throw new Error(`Placement assertion FAILED: anchor cgroup "${cg}" is not under the k-K-arm slice`);
  }
  if (cg.includes('pi-web-ui-tools')) {
    throw new Error(`Placement assertion FAILED: anchor cgroup "${cg}" aliases the production tools anchor`);
  }
  const prodAnchor = '/sys/fs/cgroup/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service';
  if (path.resolve(`/sys/fs/cgroup${cg}`) === path.resolve(prodAnchor)) {
    throw new Error('Placement assertion FAILED: resolved root equals the production anchor path');
  }
  return cg;
}

export interface StartedServer {
  unit: string;
  mainPid: number;
  socketPath: string;
  tokenPath: string;
  httpPort: number;
  anchorCgroup: string;
  memoryMax: string;
  runtimeMaxSec: number;
  /** ISO instant captured BEFORE the unit launches — journal assertions must query from it (boot lines predate readiness). */
  launchedAt: string;
}

/** Prepare the env file + stub bin dir the server unit needs. */
export function prepareServerEnv(paths: RunPaths, repoRoot: string): void {
  mkdirSync(paths.fakeHomeDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(paths.fakeHomeDir, 'agent-os-memory-vault'), { recursive: true, mode: 0o700 });
  mkdirSync(paths.binDir, { recursive: true });
  mkdirSync(paths.boardStoreDir, { recursive: true });
  mkdirSync(paths.bgTasksDir, { recursive: true });
  // Placement channel: the server strips ALL inherited PI_TOOLS_* and then
  // loads ONLY the allowlisted keys from this file (J6 design). The auth
  // secrets are DISPOSABLE per-run randoms generated here — never copied from
  // production (the production .env.production is never read by this harness).
  writeFileSync(
    paths.serverEnvFile,
    [
      'PI_TOOLS_PLACEMENT=on',
      `PI_TOOLS_SLICE=${anchorUnitName()}`,
      `JWT_SECRET=${randomBytes(32).toString('hex')}`,
      `AUTH_PASSWORD=${randomBytes(24).toString('hex')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  // The anchor's start script (production ExecStart logic, file content — no
  // systemd escaping needed).
  writeFileSync(path.join(paths.binDir, 'anchor-start.sh'), ANCHOR_START_SCRIPT, { mode: 0o755 });
  // agent-os interception stub on PATH (same stub the heap-soak harness uses).
  const stubTarget = path.join(paths.binDir, 'agent-os');
  const stubSource = path.join(repoRoot, 'scripts', 'heap-soak', 'agent-os-stub.mjs');
  if (!existsSync(stubSource)) throw new Error(`agent-os stub missing at ${stubSource}`);
  try { unlinkSync(stubTarget); } catch { /* absent */ }
  symlinkSync(stubSource, stubTarget);
}

/** Start the disposable server (idempotent per run dir). Asserts placement isolation first. */
export async function startServerUnit(repoRoot: string, paths: RunPaths, mode: ServerMode): Promise<StartedServer> {
  const launchedAt = new Date().toISOString(); // BEFORE launch: boot's own journal lines must be inside the assertion window
  await startAnchorUnit(path.join(paths.binDir, 'anchor-start.sh'));
  const anchorCgroup = await assertPlacementRootIsolated();

  const socketPath = path.join(paths.validationDir, 'internal-api.sock');
  const tokenPath = path.join(paths.validationDir, 'internal-api-token');
  const existing = await getUnitStatus(serverUnitName());
  if (existing.activeState === 'active' && existing.mainPid && existsSync(socketPath)) {
    // Idempotent re-entry: reuse the running server, but the journal assertion
    // window still needs a pre-boot instant — read the one the state file kept.
    const prior = readFileSync(path.join(paths.stateDir, 'server.json'), 'utf8');
    return {
      unit: serverUnitName(),
      mainPid: existing.mainPid,
      socketPath,
      tokenPath,
      httpPort: Number(readFileSync(path.join(paths.stateDir, 'http-port'), 'utf8') || 0),
      anchorCgroup,
      memoryMax: mode.memoryMax,
      runtimeMaxSec: mode.runtimeMaxSec,
      launchedAt: (JSON.parse(prior) as { launchedAt?: string }).launchedAt ?? launchedAt,
    };
  }

  const unit = serverUnitName();
  const httpPort = await findFreeTcpPort();
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(paths.stateDir, 'http-port'), String(httpPort));
  // stop-server disposes the env file (secrets policy); a re-start in the same
  // run dir must regenerate it — disposable per-run randoms, never copied.
  if (!existsSync(paths.serverEnvFile)) prepareServerEnv(paths, repoRoot);

  const inheritedPath = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const setenv: Array<[string, string]> = [
    ['NODE_ENV', 'production'],
    ['NODE_OPTIONS', '--max-old-space-size=4096'],
    ['PI_CODING_AGENT_DIR', paths.agentDir],
    ['PI_AGENT_DIR', paths.agentDir],
    ['HOME', paths.fakeHomeDir],
    ['PATH', `${paths.binDir}:${inheritedPath}`],
    ['AGENT_OS_BIN', path.join(repoRoot, 'scripts', 'heap-soak', 'agent-os-stub.mjs')],
    ['AGENT_OS_STUB_LOG', paths.agentOsStubLog],
    ['AGENT_OS_VAULT_ROOT', path.join(paths.fakeHomeDir, 'agent-os-memory-vault')],
    ['BOARD_STORE_DIR', paths.boardStoreDir],
    ['PI_WEB_UI_GOAL_HOME', paths.goalHomeDir],
    ['PI_COMPACTION_LOG', paths.compactionLogPath],
    ['PI_BG_TASKS_DIR', paths.bgTasksDir],
    ['PI_WEB_UI_WATCH_WAKE_SOCKET', socketPath],
    ['PI_WEB_UI_WATCH_WAKE_TOKEN_FILE', tokenPath],
    ['NOTIFICATIONS_ENABLED', 'false'],
  ];

  await systemdRun([
    '--unit', unit,
    '--slice', sliceName(),
    '--property', `Restart=${mode.restart}`,
    '--property', mode.restart === 'always' ? 'RestartSec=10s' : 'RestartSec=2',
    '--property', mode.restart === 'always' ? 'TimeoutStopSec=30s' : 'TimeoutStopSec=10s',
    '--property', `MemoryMax=${mode.memoryMax}`,
    '--property', 'MemorySwapMax=1G',
    '--property', `RuntimeMaxSec=${mode.runtimeMaxSec}`,
    '--property', 'OOMScoreAdjust=-500',
    '--property', 'OOMPolicy=continue',
    '--property', 'KillMode=control-group',
    '--property', 'TasksMax=8192',
    '--property', `WorkingDirectory=${repoRoot}`,
    '--property', 'UnsetEnvironment=PI_TOOLS_PLACEMENT PI_TOOLS_SLICE PI_TOOLS_CGROUP_ROOT PI_TOOLS_RUNTIME_DIR',
    ...setenv.map(([k, v]) => ['--setenv', `${k}=${v}`]).flat(),
    '--',
    'npx', 'tsx', 'scripts/validation-server.ts',
    '--dir', paths.validationDir,
    '--compiled',
    '--port', String(httpPort),
    '--env-file', paths.serverEnvFile,
    '--env-key', 'PI_TOOLS_PLACEMENT',
    '--env-key', 'PI_TOOLS_SLICE',
    '--env-key', 'JWT_SECRET',
    '--env-key', 'AUTH_PASSWORD',
  ]);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const s = await getUnitStatus(unit);
    if (s.activeState === 'failed' || s.activeState === 'inactive') {
      throw new Error(`Server unit ${unit} reached ${s.activeState} during startup — check journalctl -u ${unit}`);
    }
    if (s.mainPid && existsSync(socketPath) && existsSync(tokenPath)) {
      // The token file is written before the socket binds; give the socket a
      // beat to accept connections (heap-soak learned this the hard way).
      await new Promise((r) => setTimeout(r, 500));
      return { unit, mainPid: s.mainPid as number, socketPath, tokenPath, httpPort, anchorCgroup, memoryMax: mode.memoryMax, runtimeMaxSec: mode.runtimeMaxSec, launchedAt };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server unit ${unit} did not become ready within 60s`);
}

/** SIGKILL the whole server unit cgroup (the kill arm). Falls back to main-pid + cgroup procs. */
export async function killServerUnit(): Promise<{ method: string }> {
  const unit = serverUnitName();
  try {
    await execFile('systemctl', ['kill', unit, '--signal=SIGKILL']);
    return { method: 'systemctl kill --signal=SIGKILL (kill-who=all)' };
  } catch {
    // Observed on this host: kill-who=all can fail on auxiliary processes.
    const status = await getUnitStatus(unit);
    const cgroup = status.controlGroup;
    if (cgroup) {
      let procs: string[] = [];
      try {
        procs = readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8').split('\n').filter(Boolean);
      } catch { /* cgroup gone */ }
      for (const pid of procs) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
      }
      return { method: `cgroup.procs SIGKILL fallback (${procs.length} pids)` };
    }
    throw new Error(`Could not kill ${unit}: no fallback available`);
  }
}

function nowIsoS(): string {
  return new Date().toISOString();
}

/**
 * Wait for systemd's AUTO-restart of the killed unit (01-answer Q3: the kill
 * arm lets systemd restart it — Restart=always/RestartSec=10s). Resolves when
 * the unit reports a NEW main pid; socket-ready is measured separately.
 */
export async function waitForSystemdAutoRestart(oldMainPid: number, timeoutMs = 120_000): Promise<{ unitActiveAgainAt: string; newMainPid: number; durationMs: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await getUnitStatus(serverUnitName());
    if (s.activeState === 'active' && s.mainPid && s.mainPid !== oldMainPid) {
      return { unitActiveAgainAt: nowIsoS(), newMainPid: s.mainPid, durationMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`systemd did not auto-restart ${serverUnitName()} within ${timeoutMs / 1000}s (old pid ${oldMainPid})`);
}

/** Poll the Internal API until it answers — the server is READY after a restart. */
export async function waitForServerReadyViaApi(socketPath: string, tokenPath: string, timeoutMs = 90_000): Promise<{ readyAt: string; durationMs: number }> {
  const { internalApiRequest } = await import('./dispatch.ts');
  const t0 = Date.now();
  let lastErr = 'none';
  while (Date.now() - t0 < timeoutMs) {
    try {
      await internalApiRequest<unknown>(socketPath, tokenPath, 'GET', '/api/v1/health', undefined, 3_000);
      return { readyAt: nowIsoS(), durationMs: Date.now() - t0 };
    } catch (err) {
      lastErr = err instanceof Error ? err.message.slice(0, 120) : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`server not ready via API within ${timeoutMs / 1000}s (last error: ${lastErr})`);
}

/**
 * 09-correction item 2: placement must be really ENABLED. The 03:2xZ arms ran
 * with `[Placement] DISABLED — tools root unavailable` because the anchor had
 * no numeric memory.max. Fail closed: any DISABLED line after the boot time
 * aborts; the placement journal lines are returned for the evidence record.
 */
export async function assertPlacementEnabledInJournal(sinceIso: string): Promise<{ placementLines: string[]; verifiedLine: string }> {
  // The placement verification logs from the validation server's DETACHED child
  // process, which keeps its own syslog identifier and may escape the unit
  // filter — query unfiltered (time-bounded) and fall back to the unit query.
  const query = async (args: string[]): Promise<string> => {
    const { stdout } = await execFile('journalctl', args);
    return stdout;
  };
  let stdout = await query(['--since', sinceIso, '--no-pager', '-n', '8000']);
  let lines = stdout.split(/\r?\n/).filter((l) => /\[Placement\]/.test(l));
  if (lines.length === 0) {
    stdout = await query(['-u', serverUnitName(), '--since', sinceIso, '--no-pager', '-n', '8000']);
    lines = stdout.split(/\r?\n/).filter((l) => /\[Placement\]/.test(l));
  }
  const disabled = lines.filter((l) => /DISABLED/.test(l));
  if (disabled.length > 0) {
    throw new Error(`Placement assertion FAILED: ${disabled.length} '[Placement] DISABLED' journal line(s) since ${sinceIso}: ${disabled[0].slice(0, 200)}`);
  }
  const verified = lines.find((l) => /tools root verified/.test(l));
  if (!verified) {
    throw new Error(`Placement assertion FAILED: no '[Placement] tools root verified:' line since ${sinceIso} — placement did not positively resolve (placement lines seen: ${lines.length})`);
  }
  return { placementLines: lines.slice(-8), verifiedLine: verified };
}

/** Journal evidence lines for a restart window (01-answer Q3: record systemd's restart time). */
export async function journalRestartEvidence(sinceIso: string): Promise<string[]> {
  try {
    const { stdout } = await execFile('journalctl', [
      '-u', serverUnitName(), '--since', sinceIso, '--no-pager', '-n', '80',
    ]);
    return stdout.split(/\r?\n/).filter((l) =>
      /Main process exited|Failed with result|Scheduled restart job|Started|Deactivated|Consumed/.test(l),
    ).slice(-12);
  } catch {
    return ['(journalctl unavailable)'];
  }
}

/** Stop the server and anchor units (idempotent). Does NOT touch the slice. */
export async function stopServerUnits(): Promise<void> {
  for (const unit of [serverUnitName(), anchorUnitName()]) {
    try {
      await execFile('systemctl', ['stop', unit]);
    } catch { /* already stopped */ }
  }
}

export async function unitIsActive(unit: string): Promise<boolean> {
  return (await getUnitStatus(unit)).activeState === 'active';
}

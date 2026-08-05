import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile as readFileFs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface WorkerAssignmentIdentity {
  sessionId: string;
  sessionPath: string;
  runId: string;
  executionInstanceId: string;
  attemptEpoch: number;
  profile: 'heavy';
}

export interface WorkerLaunchSpec {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  assignment?: WorkerAssignmentIdentity;
}

export interface PlainWorkerResourceIdentity {
  kind: 'plain';
  mainPid?: number;
  launcherPid?: number;
}

export interface SystemdWorkerResourceIdentity {
  kind: 'systemd-transient';
  mainPid: number;
  launcherPid?: number;
  unitName: string;
  sliceName: string;
  cgroupPath: string;
  launchTokenSha256: string;
  observedProperties: Readonly<Record<string, string>>;
}

export type WorkerResourceIdentity = PlainWorkerResourceIdentity | SystemdWorkerResourceIdentity;

export interface WorkerResourceSnapshot {
  observedAt: string;
  populated: boolean;
  memberPids: number[];
  memoryCurrentBytes?: number;
  memoryEvents?: Record<string, number>;
  pidsCurrent?: number;
  pidsEvents?: Record<string, number>;
}

export interface WorkerLaunchHandle {
  process: ChildProcess;
  resourceIdentity: WorkerResourceIdentity;
  snapshot(): Promise<WorkerResourceSnapshot>;
  terminate(): Promise<void>;
}

export interface WorkerLauncher {
  launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchHandle>;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type ExecFile = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;
type ReadFile = (path: string) => Promise<string>;

export interface PlainWorkerLauncherOptions {
  spawnProcess?: SpawnProcess;
  readFile?: ReadFile;
  /** Only the frozen Phase 6 comparison harness may run heavy assignments uncontained. */
  allowHeavyBaseline?: boolean;
}

/** Existing direct-child worker launch path, retained as the Phase 6 baseline. */
export class PlainWorkerLauncher implements WorkerLauncher {
  private readonly spawnProcess: SpawnProcess;
  private readonly readFile: ReadFile;
  private readonly allowHeavyBaseline: boolean;

  constructor(options: PlainWorkerLauncherOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.readFile = options.readFile ?? (async (file) => readFileFs(file, 'utf8'));
    this.allowHeavyBaseline = options.allowHeavyBaseline ?? false;
  }

  async launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchHandle> {
    if (spec.assignment?.profile === 'heavy' && !this.allowHeavyBaseline) {
      throw new Error('Heavy worker assignments require containment outside the explicit Phase 6 plain baseline');
    }
    const process = this.spawnProcess(spec.executable, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spec.env,
    });
    return {
      process,
      resourceIdentity: {
        kind: 'plain',
        mainPid: process.pid,
        launcherPid: process.pid,
      },
      snapshot: async () => this.snapshotProcessTree(process),
      terminate: () => terminateChild(process),
    };
  }

  private async snapshotProcessTree(process: ChildProcess): Promise<WorkerResourceSnapshot> {
    const rootPid = process.pid;
    if (!rootPid || process.exitCode != null || process.signalCode != null) {
      return { observedAt: new Date().toISOString(), populated: false, memberPids: [] };
    }
    const pending = [rootPid];
    const members = new Set<number>();
    while (pending.length > 0 && members.size < 256) {
      const pid = pending.shift();
      if (!pid || members.has(pid)) continue;
      members.add(pid);
      try {
        const children = await this.readFile(`/proc/${pid}/task/${pid}/children`);
        for (const rawChild of children.trim().split(/\s+/)) {
          const childPid = Number(rawChild);
          if (Number.isSafeInteger(childPid) && childPid > 0 && !members.has(childPid)) pending.push(childPid);
        }
      } catch {
        // A process can leave between bounded /proc samples.
      }
    }
    const memberPids = [...members].sort((a, b) => a - b);
    let memoryCurrentBytes = 0;
    await Promise.all(memberPids.map(async (pid) => {
      try {
        const status = await this.readFile(`/proc/${pid}/status`);
        const rssKiB = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1]);
        if (Number.isSafeInteger(rssKiB) && rssKiB >= 0) memoryCurrentBytes += rssKiB * 1024;
      } catch {
        // Preserve the process-membership sample even if RSS races with exit.
      }
    }));
    return {
      observedAt: new Date().toISOString(),
      populated: memberPids.length > 0,
      memberPids,
      memoryCurrentBytes,
      pidsCurrent: memberPids.length,
    };
  }
}

const PHASE6_HEAVY_PROPERTIES = Object.freeze({
  MemoryHigh: '128M',
  MemoryMax: '384M',
  MemorySwapMax: '0',
  TasksMax: '64',
  CPUWeight: '100',
  KillMode: 'control-group',
  TimeoutStopSec: '10s',
});

const REQUIRED_OBSERVED_PROPERTIES = Object.freeze({
  MemoryHigh: '134217728',
  MemoryMax: '402653184',
  MemorySwapMax: '0',
  TasksMax: '64',
  CPUWeight: '100',
  KillMode: 'control-group',
  TimeoutStopUSec: '10s',
  CPUQuotaPerSecUSec: 'infinity',
});

export interface WorkerReconciliationResult {
  workerStopped: true;
  cgroupEmpty: true;
  unitCollected: true;
}

export interface TransientSystemdWorkerLauncherOptions {
  /** Validation-run nonce. Used only after strict syntax validation. */
  nonce: string;
  spawnProcess?: SpawnProcess;
  execFile?: ExecFile;
  readFile?: ReadFile;
  systemdRunPath?: string;
  systemctlPath?: string;
  pollIntervalMs?: number;
  identityTimeoutMs?: number;
  cgroupRoot?: string;
}

/**
 * Phase 6 heavy-worker launcher. It never falls back to plain spawn: failure to
 * observe the named transient service, its real MainPID, cgroup, or frozen
 * resource properties rejects the launch.
 */
export class TransientSystemdWorkerLauncher implements WorkerLauncher {
  private readonly nonce: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly execFile: ExecFile;
  private readonly readFile: ReadFile;
  private readonly systemdRunPath: string;
  private readonly systemctlPath: string;
  private readonly pollIntervalMs: number;
  private readonly identityTimeoutMs: number;
  private readonly cgroupRoot: string;

  constructor(options: TransientSystemdWorkerLauncherOptions) {
    if (!/^[a-z0-9]{6,32}$/.test(options.nonce)) {
      throw new Error('Phase 6 launcher nonce must be 6-32 lowercase alphanumeric characters');
    }
    this.nonce = options.nonce;
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    const nativeExecFile = promisify(execFileCallback);
    this.execFile = options.execFile ?? (async (command, args) => {
      const result = await nativeExecFile(command, [...args], { encoding: 'utf8' });
      return { stdout: String(result.stdout) };
    });
    this.readFile = options.readFile ?? (async (file) => readFileFs(file, 'utf8'));
    this.systemdRunPath = options.systemdRunPath ?? 'systemd-run';
    this.systemctlPath = options.systemctlPath ?? 'systemctl';
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.identityTimeoutMs = options.identityTimeoutMs ?? 2_000;
    this.cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  }

  async launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchHandle> {
    const assignment = spec.assignment;
    if (!assignment || assignment.profile !== 'heavy' || !Number.isSafeInteger(assignment.attemptEpoch) || assignment.attemptEpoch < 1) {
      throw new Error('Contained worker launch requires a server-derived heavy assignment with a positive attempt epoch');
    }
    const sliceName = `pi-web-ui-phase6-${this.nonce}.slice`;
    const token = createHash('sha256')
      .update(JSON.stringify([
        assignment.sessionId,
        assignment.sessionPath,
        assignment.runId,
        assignment.executionInstanceId,
        assignment.attemptEpoch,
      ]), 'utf8')
      .digest('hex')
      .slice(0, 8);
    const unitName = `pi-web-ui-phase6-${this.nonce}-worker-${token}.service`;
    await this.assertUnitAbsent(unitName);
    const launchToken = randomBytes(16).toString('hex');
    const args = [
      '--quiet',
      `--unit=${unitName}`,
      `--slice=${sliceName}`,
      '--service-type=exec',
      '--pipe',
      '--wait',
      '--collect',
      ...Object.entries(PHASE6_HEAVY_PROPERTIES).map(([key, value]) => `--property=${key}=${value}`),
      '--setenv=NODE_OPTIONS=--max-old-space-size=128',
      `--setenv=PI_WEB_UI_WORKER_LAUNCH_TOKEN=${launchToken}`,
      '--',
      spec.executable,
      ...spec.args,
    ];
    const process = this.spawnProcess(this.systemdRunPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spec.env,
    });

    try {
      const observed = await this.observeIdentity(unitName, sliceName, process.pid, launchToken);
      let termination: Promise<void> | undefined;
      return {
        process,
        resourceIdentity: observed,
        snapshot: () => this.snapshot(observed),
        terminate: () => {
          termination ??= this.reconcile(observed).then(() => undefined);
          return termination;
        },
      };
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.reconcileFailedLaunch(unitName, sliceName, process.pid, launchToken);
      } catch (caught) {
        cleanupError = caught;
      }
      try { process.kill('SIGTERM'); } catch { /* launcher client may already have exited */ }
      if (cleanupError) {
        throw new AggregateError([error, cleanupError], `Contained worker launch failed and exact-unit reconciliation also failed: ${unitName}`);
      }
      throw error;
    }
  }

  private async assertUnitAbsent(unitName: string): Promise<void> {
    try {
      const { stdout } = await this.execFile(this.systemctlPath, [
        'show', unitName, '-p', 'LoadState', '--no-pager',
      ]);
      const loadState = parseProperties(stdout).LoadState;
      if (loadState === 'not-found') return;
      throw new Error(`Refusing contained launch because the generation unit already exists: ${unitName} (${loadState ?? 'unknown'})`);
    } catch (error) {
      if (/not found|not-found|could not be found/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
  }

  private async reconcileFailedLaunch(
    unitName: string,
    sliceName: string,
    launcherPid: number | undefined,
    launchToken: string,
  ): Promise<void> {
    let stdout: string;
    try {
      ({ stdout } = await this.execFile(this.systemctlPath, [
        'show', unitName, '-p', 'LoadState', '-p', 'InvocationID', '-p', 'MainPID', '-p', 'ControlGroup', '-p', 'Slice', '--no-pager',
      ]));
    } catch (error) {
      if (/not found|not-found|could not be found/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
    const properties = parseProperties(stdout);
    if (properties.LoadState === 'not-found') return;
    const mainPid = Number(properties.MainPID);
    const cgroupPath = properties.ControlGroup;
    const exactCgroup = isCanonicalCgroupPath(cgroupPath)
      && cgroupPath.includes(`/${sliceName}/`)
      && cgroupPath.endsWith(`/${unitName}`);
    if (
      properties.Slice !== sliceName
      || !Number.isSafeInteger(mainPid)
      || mainPid < 0
      || !/^[a-f0-9]{32}$/i.test(properties.InvocationID ?? '')
    ) {
      throw new Error(`Refusing cleanup of unverified failed-launch unit: ${unitName}`);
    }
    if (mainPid > 0) {
      if (!exactCgroup || !(await this.processHasLaunchToken(mainPid, launchToken))) {
        throw new Error(`Refusing cleanup of failed-launch unit without exact invocation identity: ${unitName}`);
      }
      await this.stopObservedUnit({
        kind: 'systemd-transient', mainPid, launcherPid, unitName, sliceName,
        cgroupPath, launchTokenSha256: sha256(launchToken), observedProperties: Object.freeze({ ...properties }),
      });
      return;
    }
    if (cgroupPath && !exactCgroup) {
      throw new Error(`Refusing cleanup of failed-launch unit with an unexpected cgroup: ${unitName}`);
    }
    if (exactCgroup) {
      await this.stopObservedUnit({
        kind: 'systemd-transient', mainPid: 0, launcherPid, unitName, sliceName,
        cgroupPath, launchTokenSha256: sha256(launchToken), observedProperties: Object.freeze({ ...properties }),
      });
    } else {
      await this.stopFailedUnitWithoutCgroup(unitName, properties.InvocationID);
    }
  }

  private async stopFailedUnitWithoutCgroup(unitName: string, invocationId: string): Promise<void> {
    const { stdout } = await this.execFile(this.systemctlPath, [
      'show', unitName, '-p', 'LoadState', '-p', 'InvocationID', '-p', 'MainPID', '-p', 'ControlGroup', '--no-pager',
    ]);
    const current = parseProperties(stdout);
    if (current.LoadState === 'not-found') return;
    if (
      current.InvocationID !== invocationId
      || Number(current.MainPID) !== 0
      || current.ControlGroup !== ''
    ) {
      throw new Error(`Refusing cleanup after failed-launch unit identity changed: ${unitName}`);
    }
    await this.execFile(this.systemctlPath, ['stop', unitName]);
    await this.waitForUnitCollection(unitName, Date.now() + this.identityTimeoutMs);
  }

  async reconcile(identity: SystemdWorkerResourceIdentity): Promise<WorkerReconciliationResult> {
    const expectedSlice = `pi-web-ui-phase6-${this.nonce}.slice`;
    const expectedUnitPrefix = `pi-web-ui-phase6-${this.nonce}-worker-`;
    if (
      identity.sliceName !== expectedSlice
      || !identity.unitName.startsWith(expectedUnitPrefix)
      || !/^pi-web-ui-phase6-[a-z0-9]{6,32}-worker-[a-f0-9]{8}\.service$/.test(identity.unitName)
      || !/^[a-f0-9]{64}$/i.test(identity.launchTokenSha256)
      || !/^[a-f0-9]{32}$/i.test(identity.observedProperties.InvocationID ?? '')
      || !isCanonicalCgroupPath(identity.cgroupPath)
      || !identity.cgroupPath.includes(`/${expectedSlice}/`)
      || !identity.cgroupPath.endsWith(`/${identity.unitName}`)
    ) {
      throw new Error('Refusing reconciliation outside the launcher nonce-owned slice');
    }
    await this.stopObservedUnit(identity);
    return { workerStopped: true, cgroupEmpty: true, unitCollected: true };
  }

  private async snapshot(identity: SystemdWorkerResourceIdentity): Promise<WorkerResourceSnapshot> {
    const cgroupDir = resolveCgroupDirectory(this.cgroupRoot, identity.cgroupPath);
    const [events, procs, memoryCurrent, memoryEvents, pidsCurrent, pidsEvents] = await Promise.all([
      this.readFile(`${cgroupDir}/cgroup.events`),
      this.readFile(`${cgroupDir}/cgroup.procs`),
      this.readFile(`${cgroupDir}/memory.current`),
      this.readFile(`${cgroupDir}/memory.events`),
      this.readFile(`${cgroupDir}/pids.current`),
      this.readFile(`${cgroupDir}/pids.events`),
    ]);
    return {
      observedAt: new Date().toISOString(),
      populated: /^populated\s+1$/m.test(events),
      memberPids: procs.split(/\s+/).filter(Boolean).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b),
      memoryCurrentBytes: parseScalar(memoryCurrent),
      memoryEvents: parseCounterFile(memoryEvents),
      pidsCurrent: parseScalar(pidsCurrent),
      pidsEvents: parseCounterFile(pidsEvents),
    };
  }

  private async stopObservedUnit(identity: SystemdWorkerResourceIdentity): Promise<void> {
    const { stdout } = await this.execFile(this.systemctlPath, [
      'show', identity.unitName, '-p', 'LoadState', '-p', 'InvocationID', '-p', 'MainPID', '-p', 'ControlGroup', '--no-pager',
    ]);
    const current = parseProperties(stdout);
    const alreadyCollected = current.LoadState === 'not-found';
    const currentMainPid = Number(current.MainPID);
    const invocationMatches = current.InvocationID === identity.observedProperties.InvocationID;
    const tokenMatches = currentMainPid > 0
      ? await this.processHasLaunchTokenHash(currentMainPid, identity.launchTokenSha256)
      : true;
    if (!alreadyCollected && (
      !invocationMatches
      || !tokenMatches
      || (currentMainPid !== identity.mainPid && currentMainPid !== 0)
      || current.ControlGroup !== identity.cgroupPath
    )) {
      throw new Error('Refusing to stop transient worker after unit identity changed');
    }
    if (!alreadyCollected) await this.execFile(this.systemctlPath, ['stop', identity.unitName]);

    const cgroupDir = resolveCgroupDirectory(this.cgroupRoot, identity.cgroupPath);
    const deadline = Date.now() + this.identityTimeoutMs;
    let lastEvidence = 'not sampled';
    let drained = false;
    while (Date.now() <= deadline) {
      try {
        const [events, procs] = await Promise.all([
          this.readFile(`${cgroupDir}/cgroup.events`),
          this.readFile(`${cgroupDir}/cgroup.procs`),
        ]);
        const populated = /^populated\s+1$/m.test(events);
        const members = procs.split(/\s+/).filter(Boolean);
        if (!populated && members.length === 0) {
          drained = true;
          break;
        }
        lastEvidence = `populated=${populated} members=${members.join(',')}`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          drained = true;
          break;
        }
        lastEvidence = error instanceof Error ? error.message : String(error);
      }
      await delay(this.pollIntervalMs);
    }
    if (!drained) throw new Error(`Transient worker cgroup did not drain: ${lastEvidence}`);

    await this.waitForUnitCollection(identity.unitName, deadline);
  }

  private async waitForUnitCollection(unitName: string, deadline: number): Promise<void> {
    let lastLoadState = 'unknown';
    while (Date.now() <= deadline) {
      try {
        const { stdout: loadStateOutput } = await this.execFile(this.systemctlPath, [
          'show', unitName, '-p', 'LoadState', '--no-pager',
        ]);
        lastLoadState = parseProperties(loadStateOutput).LoadState ?? 'missing';
        if (lastLoadState === 'not-found') return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found|not-found|could not be found/i.test(message)) return;
        lastLoadState = message;
      }
      await delay(this.pollIntervalMs);
    }
    throw new Error(`Transient worker unit was not collected: ${unitName} (${lastLoadState})`);
  }

  private async processHasLaunchToken(mainPid: number, launchToken: string): Promise<boolean> {
    return this.processHasLaunchTokenHash(mainPid, sha256(launchToken));
  }

  private async processHasLaunchTokenHash(mainPid: number, expectedHash: string): Promise<boolean> {
    try {
      const environ = await this.readFile(`/proc/${mainPid}/environ`);
      const token = environ.split('\0')
        .find((entry) => entry.startsWith('PI_WEB_UI_WORKER_LAUNCH_TOKEN='))
        ?.slice('PI_WEB_UI_WORKER_LAUNCH_TOKEN='.length);
      return typeof token === 'string' && sha256(token) === expectedHash;
    } catch {
      return false;
    }
  }

  private async observeIdentity(
    unitName: string,
    sliceName: string,
    launcherPid: number | undefined,
    launchToken: string,
  ): Promise<SystemdWorkerResourceIdentity> {
    const deadline = Date.now() + this.identityTimeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const { stdout } = await this.execFile(this.systemctlPath, [
          'show', unitName,
          '-p', 'MainPID',
          '-p', 'InvocationID',
          '-p', 'ControlGroup',
          '-p', 'Slice',
          '-p', 'MemoryHigh',
          '-p', 'MemoryMax',
          '-p', 'MemorySwapMax',
          '-p', 'TasksMax',
          '-p', 'CPUWeight',
          '-p', 'KillMode',
          '-p', 'TimeoutStopUSec',
          '-p', 'CPUQuotaPerSecUSec',
          '--no-pager',
        ]);
        const properties = parseProperties(stdout);
        const mainPid = Number(properties.MainPID);
        const invocationId = properties.InvocationID;
        const cgroupPath = properties.ControlGroup;
        if (
          !Number.isSafeInteger(mainPid)
          || mainPid <= 0
          || !/^[a-f0-9]{32}$/i.test(invocationId ?? '')
          || !cgroupPath
        ) {
          throw new Error('transient worker has no observable invocation/MainPID/cgroup yet');
        }
        for (const [key, expected] of Object.entries(REQUIRED_OBSERVED_PROPERTIES)) {
          if (properties[key] !== expected) {
            throw new Error(`transient worker property mismatch: ${key}=${properties[key] ?? 'missing'} expected ${expected}`);
          }
        }
        const [procCgroupFile, tokenMatches] = await Promise.all([
          this.readFile(`/proc/${mainPid}/cgroup`),
          this.processHasLaunchToken(mainPid, launchToken),
        ]);
        const procCgroup = parseUnifiedCgroup(procCgroupFile);
        if (procCgroup !== cgroupPath) {
          throw new Error(`transient worker cgroup mismatch: unit=${cgroupPath} process=${procCgroup}`);
        }
        if (!tokenMatches) throw new Error('transient worker invocation token mismatch');
        if (
          properties.Slice !== sliceName
          || !isCanonicalCgroupPath(cgroupPath)
          || !cgroupPath.includes(`/${sliceName}/`)
          || !cgroupPath.endsWith(`/${unitName}`)
        ) {
          throw new Error('transient worker cgroup is outside the nonce-owned slice/unit');
        }
        return {
          kind: 'systemd-transient',
          mainPid,
          launcherPid,
          unitName,
          sliceName,
          cgroupPath,
          launchTokenSha256: sha256(launchToken),
          observedProperties: Object.freeze({ ...properties }),
        };
      } catch (error) {
        lastError = error;
        await delay(this.pollIntervalMs);
      }
    }
    throw new Error(`Failed to observe exact transient worker identity: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isCanonicalCgroupPath(cgroupPath: string): boolean {
  return cgroupPath.startsWith('/')
    && !cgroupPath.includes('\0')
    && path.posix.normalize(cgroupPath) === cgroupPath;
}

function resolveCgroupDirectory(cgroupRoot: string, cgroupPath: string): string {
  if (!isCanonicalCgroupPath(cgroupPath)) throw new Error('Worker cgroup path is not canonical');
  const root = path.resolve(cgroupRoot);
  const resolved = path.resolve(root, `.${cgroupPath}`);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Worker cgroup path escapes the cgroup root');
  return resolved;
}

function parseProperties(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function parseScalar(input: string): number | undefined {
  const value = Number(input.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseCounterFile(input: string): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const line of input.split(/\r?\n/)) {
    const [key, rawValue] = line.trim().split(/\s+/, 2);
    const value = Number(rawValue);
    if (key && Number.isSafeInteger(value) && value >= 0) counters[key] = value;
  }
  return counters;
}

function parseUnifiedCgroup(input: string): string {
  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith('0::/')) return line.slice(3);
  }
  throw new Error('worker process is not in an observable cgroup-v2 unified path');
}

function terminateChild(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.off('exit', finish);
      process.off('close', finish);
      resolve();
    };
    process.once('exit', finish);
    process.once('close', finish);
    try { process.kill('SIGTERM'); } catch { finish(); }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

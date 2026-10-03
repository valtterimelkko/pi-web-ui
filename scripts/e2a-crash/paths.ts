/**
 * Run-directory layout for the E2a-6c crash-recovery harness.
 * Everything lives under /root/e2a-runs/a6c/<run-id>/ — never in the repo.
 * Units are named k-K-arm-* (wave K lane; the guard's unit-scoped protection applies).
 */
import path from 'node:path';

export const RUNS_ROOT = '/root/e2a-runs/k';

export function runIdPath(runId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(runId)) {
    throw new Error(`Invalid run id (must be a short filesystem-safe token): ${runId}`);
  }
  return path.join(RUNS_ROOT, runId);
}

export interface RunPaths {
  runDir: string;
  /** Isolated agent dir (real extension set, zai credential only). */
  agentDir: string;
  /** Fake $HOME for the disposable server (redirects os.homedir() paths). */
  fakeHomeDir: string;
  /** The disposable server's state directory (socket, token, watches, receipts, sessions). */
  validationDir: string;
  /** Env file consumed through the --env-file/--env-key channel (placement keys). */
  serverEnvFile: string;
  /** Fixture repos root: fixtures/fixture-N/repo. */
  fixturesRoot: string;
  /** Transcript/ps samples taken by the driver. */
  samplesDir: string;
  /** Driver state: run-state.json, arm records, logs. */
  stateDir: string;
  /** agent-os interception stub log + PATH stub dir. */
  binDir: string;
  agentOsStubLog: string;
  boardStoreDir: string;
  goalHomeDir: string;
  compactionLogPath: string;
  bgTasksDir: string;
}

export function resolveRunPaths(runId: string): RunPaths {
  const base = runIdPath(runId);
  return {
    runDir: base,
    agentDir: path.join(base, 'agent-dir'),
    fakeHomeDir: path.join(base, 'fake-home'),
    validationDir: path.join(base, 'server'),
    serverEnvFile: path.join(base, 'server.env'),
    fixturesRoot: path.join(base, 'fixtures'),
    samplesDir: path.join(base, 'samples'),
    stateDir: path.join(base, 'state'),
    binDir: path.join(base, 'bin'),
    agentOsStubLog: path.join(base, 'agent-os-stub.jsonl'),
    boardStoreDir: path.join(base, 'board-store'),
    goalHomeDir: path.join(base, 'fake-home'),
    compactionLogPath: path.join(base, 'compaction-log.jsonl'),
    bgTasksDir: path.join(base, 'bg-tasks'),
  };
}

export function anchorUnitName(): string {
  return 'k-K-arm-tools-anchor.service';
}

export function serverUnitName(): string {
  return 'k-K-arm-server.service';
}

export function sliceName(): string {
  return 'k-K-arm.slice';
}

/**
 * L1 admission-count leak reproduction — run-dir layout and unit names.
 *
 * Run dirs live under /root/k-runs/l1/<run-id>/ (never in the repo). Units are
 * named k-l1-* per COMMON-BRIEF-k containment rules, inside k-l1.slice.
 */
import path from 'node:path';

export const RUNS_ROOT = '/root/k-runs/l1';

export function runIdPath(runId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(runId)) {
    throw new Error(`Invalid run id (must be a short filesystem-safe token): ${runId}`);
  }
  return path.join(RUNS_ROOT, runId);
}

export const SERVER_UNIT = 'k-l1-server.service';
export const ANCHOR_UNIT = 'k-l1-tools-anchor.service';
export const SLICE = 'k-l1.slice';

export interface RunPaths {
  runDir: string;
  /** Isolated agent dir (real extension set, zai credential only). */
  agentDir: string;
  /** Fake $HOME for the disposable server. */
  fakeHomeDir: string;
  /** Disposable server state dir (socket, token, receipts, sessions). */
  validationDir: string;
  /** Env file channel for placement + per-run disposable auth randoms. */
  serverEnvFile: string;
  /** Timeline + summary evidence written by the probe. */
  evidenceDir: string;
  stateDir: string;
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
    evidenceDir: path.join(base, 'evidence'),
    stateDir: path.join(base, 'state'),
    binDir: path.join(base, 'bin'),
    agentOsStubLog: path.join(base, 'agent-os-stub.jsonl'),
    boardStoreDir: path.join(base, 'board-store'),
    goalHomeDir: path.join(base, 'fake-home'),
    compactionLogPath: path.join(base, 'compaction-log.jsonl'),
    bgTasksDir: path.join(base, 'bg-tasks'),
  };
}

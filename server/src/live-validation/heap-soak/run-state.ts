import type { CircuitBreakerState, LaneName } from './types.js';

export interface RunStateServerInfo {
  unitName: string;
  socketPath: string;
  tokenPath: string;
  inspectorPort: number;
  /** MainPID of the server unit, observed once at start and re-verified on reattach. */
  mainPid: number;
  /** HTTP port (parent amendment 2026-09-26) — used by the browser-like WS client. */
  httpPort: number;
}

export interface RunStateSupervisorInfo {
  unitName: string;
}

/** How a run ended. `server_died` is terminal: the disposable server process under test vanished. */
export type RunTerminalState = 'complete' | 'server_died';

/** Evidence recorded when the disposable server dies mid-run (B0 defect 1). */
export interface ServerDeathRecord {
  /** ISO timestamp the death was detected by the supervisor. */
  detectedAt: string;
  /** Milliseconds since run start at detection. */
  elapsedMs: number;
  /** Why the death was declared (unit state, MainPID change, or sustained socket unreachability). */
  reason: string;
  /** systemd ActiveState/SubState at detection, when known. */
  activeState?: string;
  /** systemd Result and/or ExecMainStatus, when known (e.g. 'exit-code/1'). */
  exitStatus?: string;
  /** Bounded tail of the server unit's journal at detection. */
  journalLines?: string[];
}

export interface RunState {
  runId: string;
  mode: 'micro' | 'full';
  startedAt: string;
  /** Wall-clock deadline; the supervisor stops the load driver (not the server) past this. */
  endsAt: string;
  runDir: string;
  server: RunStateServerInfo;
  supervisor: RunStateSupervisorInfo;
  cycleCount: number;
  laneBreakers: Record<LaneName, CircuitBreakerState>;
  lastSampleAt?: string;
  lastCheckpointHourMark?: number;
  csvPath: string;
  eventsLogPath: string;
  /** Checkpoint/snapshot offsets (ms since start) already fired — tolerant of a supervisor restart. */
  firedCheckpointOffsetsMs?: number[];
  firedSnapshotOffsetsMs?: number[];
  /** Heap-threshold snapshots already taken (MB), see heap-threshold-snapshots.ts. */
  firedHeapThresholdsMB?: number[];
  /** zai quota guard (owner amendment 2026-09-26) — persisted so a supervisor restart resumes the same state, not 'normal'. */
  quotaState?: 'normal' | 'throttled' | 'paused';
  quotaConsecutiveFailures?: number;
  lastQuotaPollAtMs?: number;
  /** Production-write audit marker path (owner amendment 2026-09-26), created once at launch. */
  prodAuditMarkerPath?: string;
  /** B0 defect 1: how the run ended. Absent means the run has not terminated (or predates B0). */
  terminalState?: RunTerminalState;
  /** B0 defect 1: the recorded death evidence, when `terminalState === 'server_died'`. */
  serverDeath?: ServerDeathRecord;
  /** B0 defect 1: elapsed ms of the last sample successfully written to the CSV (used for honest coverage). */
  lastGoodSampleElapsedMs?: number;
  /** B0 defect 6: extension directories overlaid into the isolated agent dir before launch. */
  extensionsOverlays?: string[];
  /** Position in HEAP_SOAK_INJECT_QUOTA_SEQUENCE (Gate 1 test seam only) — persisted so a supervisor restart doesn't replay the sequence from the start. */
  quotaInjectedIndex?: number;
}

export function serializeRunState(state: RunState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function parseRunState(raw: string): RunState {
  const parsed = JSON.parse(raw) as RunState;
  if (!parsed.runId || !parsed.server?.unitName || !parsed.supervisor?.unitName) {
    throw new Error('run-state.json is missing required fields (runId/server.unitName/supervisor.unitName)');
  }
  return parsed;
}

export interface ServerUnitObservation {
  /** systemctl LoadState for the server unit. */
  loadState: string;
  /** systemctl MainPID for the server unit, or 0/undefined if not running. */
  mainPid?: number;
}

export type ReattachDecision =
  | { action: 'reattach'; reason: string }
  | { action: 'server-gone'; reason: string }
  | { action: 'pid-mismatch'; reason: string };

/**
 * Decide whether a restarted supervisor should reattach to the already-running
 * server unit recorded in run-state, given a freshly observed systemctl status.
 * This NEVER recommends restarting the server — only whether the previously
 * recorded identity still matches what's actually running, so a restarted
 * supervisor can tell "still the same server" apart from "server died" and
 * refuse to silently attach to some other process that reused the unit name.
 */
export function decideReattach(state: RunState, observation: ServerUnitObservation): ReattachDecision {
  if (observation.loadState !== 'loaded' && observation.loadState !== 'active') {
    return {
      action: 'server-gone',
      reason: `server unit ${state.server.unitName} is not loaded/active (LoadState=${observation.loadState})`,
    };
  }
  if (!observation.mainPid || observation.mainPid <= 0) {
    return { action: 'server-gone', reason: `server unit ${state.server.unitName} has no live MainPID` };
  }
  if (observation.mainPid !== state.server.mainPid) {
    return {
      action: 'pid-mismatch',
      reason: `server unit ${state.server.unitName} MainPID changed (recorded ${state.server.mainPid}, observed ${observation.mainPid}) — `
        + 'refusing to reattach to what may be a different process; the heap history would be silently invalidated.',
    };
  }
  return { action: 'reattach', reason: `server unit ${state.server.unitName} MainPID ${observation.mainPid} still running — reattaching without restart` };
}

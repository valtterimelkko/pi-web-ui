import type { CircuitBreakerState, LaneName } from './types.js';

export interface RunStateServerInfo {
  unitName: string;
  socketPath: string;
  tokenPath: string;
  inspectorPort: number;
  /** MainPID of the server unit, observed once at start and re-verified on reattach. */
  mainPid: number;
}

export interface RunStateSupervisorInfo {
  unitName: string;
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
  /** zai quota guard (owner amendment 2026-09-26) — persisted so a supervisor restart resumes the same state, not 'normal'. */
  quotaState?: 'normal' | 'throttled' | 'paused';
  quotaConsecutiveFailures?: number;
  lastQuotaPollAtMs?: number;
  /** Production-write audit marker path (owner amendment 2026-09-26), created once at launch. */
  prodAuditMarkerPath?: string;
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

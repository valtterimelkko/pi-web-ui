/**
 * Server-death detection for the heap soak harness (B0).
 *
 * A1's harness kept cycling against a dead socket for 19 h and then reported
 * "complete" after its disposable server had hit V8 heap OOM (see
 * docs/plans/execution-reports/orchestration-scaling/A1-soak.md §6, defect 1).
 * The supervisor checks the server unit's state and MainPID (and socket
 * reachability) every cycle and ends the run with a terminal `server_died`
 * state instead.
 *
 * The decision is deliberately NOT inferred from the sampler's own failures:
 * a failed GC or a broken socket call is a symptom, not proof of death. Death
 * is proved from the unit/PID identity the run was launched with (the same
 * identity `decideReattach` guards). Socket unreachability alone is treated as
 * a transient blip until it persists for `SOCKET_UNREACHABLE_STRIKES`
 * consecutive observations, which catches a hung-but-still-alive process
 * without killing a run over one dropped inspector round-trip.
 *
 * Pure and unit-tested; the systemd/journal I/O lives in scripts/heap-soak/.
 */
import type { RunState, RunTerminalState, ServerDeathRecord } from './run-state.js';
import { decideReattach } from './run-state.js';

export interface ServerLivenessObservation {
  /** `systemctl show -p LoadState`. */
  loadState: string;
  /** `systemctl show -p ActiveState`. */
  activeState: string;
  /** `systemctl show -p MainPID` — absent/0 when not running. */
  mainPid?: number;
  /** Whether the disposable server's Internal API socket accepted a connection. */
  socketReachable: boolean;
}

export type ServerLiveness = 'alive' | 'dead' | 'unconfirmed';

export interface ServerLivenessDecision {
  status: ServerLiveness;
  reason: string;
}

/** Consecutive socket-unreachable observations before a still-active unit is declared dead. */
export const SOCKET_UNREACHABLE_STRIKES = 3;

/** Classify the disposable server's liveness against the identity recorded at launch. */
export function classifyServerLiveness(state: RunState, observation: ServerLivenessObservation): ServerLivenessDecision {
  const unit = state.server.unitName;
  if (observation.loadState !== 'loaded' && observation.loadState !== 'active') {
    return { status: 'dead', reason: `server unit ${unit} is ${observation.loadState} (not loaded/active)` };
  }
  if (!observation.mainPid || observation.mainPid <= 0) {
    return { status: 'dead', reason: `server unit ${unit} has no live MainPID` };
  }
  if (observation.mainPid !== state.server.mainPid) {
    return {
      status: 'dead',
      reason: `server unit ${unit} MainPID changed (recorded ${state.server.mainPid}, observed ${observation.mainPid}) — the process under test is gone`,
    };
  }
  if (!observation.socketReachable) {
    return { status: 'unconfirmed', reason: `server unit ${unit} is active (PID ${observation.mainPid}) but its socket is unreachable` };
  }
  return { status: 'alive', reason: `server unit ${unit} is active (PID ${observation.mainPid}) and its socket is reachable` };
}

export interface ServerDeathDecision {
  died: boolean;
  reason?: string;
}

/**
 * Decide whether the run should end as `server_died`, given the recorded
 * server identity, a fresh observation, and how many consecutive observations
 * have already been socket-unreachable while the unit/PID still looked right.
 */
export function decideServerDeath(
  state: RunState,
  observation: ServerLivenessObservation,
  consecutiveSocketUnreachable = 0,
): ServerDeathDecision {
  const liveness = classifyServerLiveness(state, observation);
  if (liveness.status === 'dead') return { died: true, reason: liveness.reason };
  if (liveness.status === 'unconfirmed' && consecutiveSocketUnreachable >= SOCKET_UNREACHABLE_STRIKES) {
    return { died: true, reason: `${liveness.reason} (${consecutiveSocketUnreachable} consecutive unreachable checks)` };
  }
  return { died: false };
}

/**
 * Advance the consecutive-unreachable counter for the next cycle: increments
 * on an `unconfirmed` observation and resets to 0 on a confirmed-alive one.
 * A hard death (`dead`) is handled immediately by `decideServerDeath` and
 * never reaches this function's caller for another cycle.
 */
export function nextSocketUnreachableCount(previousCount: number, observation: ServerLivenessObservation): number {
  return observation.socketReachable ? 0 : previousCount + 1;
}

/** The evidence recorded when a death is terminalised (gathered by the caller from systemd/journal). */
export interface ServerDeathEvidence {
  reason: string;
  /** ISO timestamp the death was detected/finalised. */
  detectedAt: string;
  /** Milliseconds since run start. */
  elapsedMs: number;
  activeState?: string;
  exitStatus?: string;
  journalLines?: string[];
}

/**
 * Terminalise a run as `server_died` from saved run state, idempotently.
 *
 * Used both by the in-run liveness loop and by STARTUP RECOVERY: if the server
 * died during the supervisor's systemd restart window (or the supervisor
 * restarted after persisting the death but before finalising), a fresh
 * supervisor must be able to terminalise from what it can still observe. An
 * already-recorded death is never overwritten, so a restart cannot rewrite the
 * original detection time or evidence.
 */
export function recordServerDeath(state: RunState, evidence: ServerDeathEvidence): RunState {
  if (state.terminalState === 'server_died' && state.serverDeath) return state;
  state.terminalState = 'server_died';
  state.serverDeath = {
    detectedAt: evidence.detectedAt,
    elapsedMs: evidence.elapsedMs,
    reason: evidence.reason,
    activeState: evidence.activeState,
    exitStatus: evidence.exitStatus,
    journalLines: evidence.journalLines,
  };
  return state;
}

export interface ReportedRunOutcome {
  terminalState: RunTerminalState;
  serverDeath?: ServerDeathRecord;
  /** Window (ms) a report should measure coverage/verdict against. */
  coveredWindowMs?: number;
}

/**
 * Decide how a `report` renders a run. A **nonterminal** run whose server is
 * gone is a server death, never `complete` (B0 correction: a supervisor that
 * died in its restart window used to leave the run nonterminal, and `report`
 * then defaulted it to a full-schedule `complete`). A run that recorded
 * `complete` stays complete even after its transient server unit has since
 * been stopped or collected.
 */
export function resolveReportedRunOutcome(
  state: RunState,
  observation: { loadState: string; activeState?: string; mainPid?: number },
  evidence: ServerDeathEvidence,
): ReportedRunOutcome {
  if (state.terminalState === 'server_died' && state.serverDeath) {
    return { terminalState: 'server_died', serverDeath: state.serverDeath, coveredWindowMs: state.serverDeath.elapsedMs };
  }
  if (state.terminalState === 'complete') return { terminalState: 'complete' };
  const decision = decideReattach(state, { loadState: observation.loadState, mainPid: observation.mainPid });
  if (decision.action !== 'reattach') {
    return {
      terminalState: 'server_died',
      serverDeath: {
        detectedAt: evidence.detectedAt,
        elapsedMs: evidence.elapsedMs,
        reason: evidence.reason,
        activeState: evidence.activeState,
        exitStatus: evidence.exitStatus,
        journalLines: evidence.journalLines,
      },
      coveredWindowMs: evidence.elapsedMs,
    };
  }
  return { terminalState: 'complete' };
}

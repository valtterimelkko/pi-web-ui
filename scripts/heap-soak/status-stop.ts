import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.js';
import { getUnitStatus } from './systemd-units.js';
import { teardownUnits } from './teardown.js';
import { loadRunState } from './run-state-io.js';
import { parseCsvWithHeader } from '../../server/src/live-validation/heap-soak/csv.js';
import { DEFAULT_FULL_RUN_HOURS, MICRO_SCHEDULE, checkpointOffsetsMs, endSnapshotOffsetMs, fullScheduleForHours, interimSnapshotOffsetsMs } from '../../server/src/live-validation/heap-soak/phases.js';

export async function runStatus(runId: string): Promise<string> {
  const dir = runDir(runId);
  const runStatePath = path.join(dir, 'run-state.json');
  if (!existsSync(runStatePath)) return `No run-state.json for ${runId} at ${runStatePath}`;
  const state = loadRunState(runStatePath);
  const [server, supervisor] = await Promise.all([getUnitStatus(state.server.unitName), getUnitStatus(state.supervisor.unitName)]);
  const csvPath = path.join(dir, 'samples.csv');
  const rows = existsSync(csvPath) ? parseCsvWithHeader(readFileSync(csvPath, 'utf8')).rows.length : 0;
  const heartbeatPath = path.join(dir, 'sampler.heartbeat');
  const heartbeat = existsSync(heartbeatPath) ? readFileSync(heartbeatPath, 'utf8').trim() : '(none)';
  // B0.1 defect 5: show the schedule the run is actually on (a full run's `--hours` window scales every offset).
  const schedule = state.mode === 'micro' ? MICRO_SCHEDULE : fullScheduleForHours(state.windowHours ?? DEFAULT_FULL_RUN_HOURS);
  const scheduleLine = state.mode === 'micro'
    ? `schedule: micro window=${schedule.totalMs}ms checkpoints(ms)=${checkpointOffsetsMs(schedule).join(',')} snapshots(ms)=${interimSnapshotOffsetsMs(schedule).join(',')}+end@${endSnapshotOffsetMs(schedule)}`
    : `schedule: full window=${state.windowHours ?? DEFAULT_FULL_RUN_HOURS}h (${schedule.totalMs}ms) checkpoints(ms)=${checkpointOffsetsMs(schedule).join(',')} snapshots(ms)=${interimSnapshotOffsetsMs(schedule).join(',')}+end@${endSnapshotOffsetMs(schedule)}`;
  const endSnapshotLine = state.endSnapshotPath
    ? `end snapshot: ${state.endSnapshotPath}${state.endSnapshotError ? ` (later error: ${state.endSnapshotError})` : ''}`
    : state.endSnapshotError
      ? `end snapshot: FAILED — ${state.endSnapshotError}`
      : 'end snapshot: not taken yet';
  const drainLine = state.endSnapshotDrain
    ? `pre-snapshot drain: drained=${state.endSnapshotDrain.drained} (bound ${state.endSnapshotDrain.timeoutMs}ms) liveChildrenAtEndSnapshot=${state.liveChildrenAtEndSnapshot ?? 'unknown'}${state.liveChildrenAtEndSnapshotIds && state.liveChildrenAtEndSnapshotIds.length > 0 ? ` ids=${state.liveChildrenAtEndSnapshotIds.slice(0, 5).join(',')}` : ''}`
    : 'pre-snapshot drain: not recorded';
  const teardownLine = state.serverStoppedAt
    ? `server stopped: ${state.serverStoppedAt} verifiedGone=${state.serverStopVerifiedGone ?? 'unknown'}`
    : state.keepServer ? 'server kept up (HEAP_SOAK_KEEP_SERVER set)' : 'server not yet stopped';
  const buildLine = state.build
    ? `build: commit=${state.build.headSha?.slice(0, 12) ?? 'unknown'} fresh=${state.build.fresh}${state.build.sourceTreeDirty ? ' (dirty tree)' : ''}`
    : 'build: not recorded';
  return [
    `run: ${runId} (${state.mode})`,
    `server unit: ${state.server.unitName} — loadState=${server.loadState} activeState=${server.activeState} mainPid=${server.mainPid ?? '(none)'}`,
    `supervisor unit: ${state.supervisor.unitName} — loadState=${supervisor.loadState} activeState=${supervisor.activeState} mainPid=${supervisor.mainPid ?? '(none)'}`,
    `cycles: ${state.cycleCount}`,
    `csv rows: ${rows}`,
    `last heartbeat: ${heartbeat}`,
    `started: ${state.startedAt}  ends: ${state.endsAt}`,
    scheduleLine,
    endSnapshotLine,
    drainLine,
    teardownLine,
    buildLine,
  ].join('\n');
}

export async function runStop(runId: string): Promise<string> {
  const dir = runDir(runId);
  const runStatePath = path.join(dir, 'run-state.json');
  if (!existsSync(runStatePath)) return `No run-state.json for ${runId} at ${runStatePath}`;
  const state = loadRunState(runStatePath);
  const result = await teardownUnits(state.server.unitName, state.supervisor.unitName);
  return `stopped ${runId}: server gone=${result.serverGone} supervisor gone=${result.supervisorGone}`;
}

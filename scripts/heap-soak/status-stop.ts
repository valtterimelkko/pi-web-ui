import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.js';
import { getUnitStatus } from './systemd-units.js';
import { teardownUnits } from './teardown.js';
import { loadRunState } from './run-state-io.js';
import { parseCsvWithHeader } from '../../server/src/live-validation/heap-soak/csv.js';

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
  return [
    `run: ${runId} (${state.mode})`,
    `server unit: ${state.server.unitName} — loadState=${server.loadState} activeState=${server.activeState} mainPid=${server.mainPid ?? '(none)'}`,
    `supervisor unit: ${state.supervisor.unitName} — loadState=${supervisor.loadState} activeState=${supervisor.activeState} mainPid=${supervisor.mainPid ?? '(none)'}`,
    `cycles: ${state.cycleCount}`,
    `csv rows: ${rows}`,
    `last heartbeat: ${heartbeat}`,
    `started: ${state.startedAt}  ends: ${state.endsAt}`,
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

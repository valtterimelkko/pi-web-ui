import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseRunState, serializeRunState, type RunState } from '../../server/src/live-validation/heap-soak/run-state.js';

export function loadRunState(runStatePath: string): RunState {
  return parseRunState(readFileSync(runStatePath, 'utf8'));
}

export function runStateExists(runStatePath: string): boolean {
  return existsSync(runStatePath);
}

/** Atomic save: write to a temp path then rename, so a crash mid-write never corrupts the last-good state. */
export function saveRunState(runStatePath: string, state: RunState): void {
  const tmp = `${runStatePath}.tmp-${process.pid}`;
  writeFileSync(tmp, serializeRunState(state));
  renameSync(tmp, runStatePath);
}

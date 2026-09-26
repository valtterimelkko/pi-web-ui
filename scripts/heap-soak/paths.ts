/**
 * Run-directory layout for the heap soak harness. Artefacts always land under
 * /root/.pi-web-ui/validation/heap-soak/<run-id>/ — never in the repo, never
 * in /tmp (see CLAUDE.md's heap-soak safety rules).
 */
import { homedir } from 'node:os';
import path from 'node:path';

export const HEAP_SOAK_ROOT = path.join(homedir(), '.pi-web-ui', 'validation', 'heap-soak');

export function runDir(runId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(runId)) {
    throw new Error(`Invalid run id (must be a short filesystem-safe token): ${runId}`);
  }
  return path.join(HEAP_SOAK_ROOT, runId);
}

export interface RunPaths {
  runDir: string;
  agentDir: string;
  workspace: string;
  childWorkspaceRoot: string;
  validationDir: string;
  csvPath: string;
  eventsLogPath: string;
  runStatePath: string;
  heartbeatPath: string;
  snapshotDir: string;
  reportPath: string;
  reportJsonPath: string;
}

export function resolveRunPaths(runId: string): RunPaths {
  const base = runDir(runId);
  return {
    runDir: base,
    agentDir: path.join(base, 'agent-dir'),
    workspace: path.join(base, 'workspace'),
    childWorkspaceRoot: path.join(base, 'children'),
    validationDir: path.join(base, 'validation'),
    csvPath: path.join(base, 'samples.csv'),
    eventsLogPath: path.join(base, 'events.jsonl'),
    runStatePath: path.join(base, 'run-state.json'),
    heartbeatPath: path.join(base, 'sampler.heartbeat'),
    snapshotDir: path.join(base, 'snapshots'),
    reportPath: path.join(base, 'report.md'),
    reportJsonPath: path.join(base, 'report.json'),
  };
}

export function serverUnitName(runId: string): string {
  return `pi-web-ui-soak-server-${runId}`;
}

export function supervisorUnitName(runId: string): string {
  return `pi-web-ui-soak-supervisor-${runId}`;
}

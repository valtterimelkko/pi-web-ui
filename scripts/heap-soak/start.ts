import { randomUUID } from 'node:crypto';
import { launchDisposableServer, startSupervisorUnit } from './launcher.js';
import { notify } from './telegram.js';

/** `start` command: launches the real 24h run as two transient systemd units, then returns (they keep running). */
export async function runStart(explicitRunId?: string): Promise<string> {
  const runId = explicitRunId ?? `full-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const launch = await launchDisposableServer(runId, 'full');
  await startSupervisorUnit(runId, launch.paths, launch.supervisorUnit);
  await notify('milestone', '24h heap soak started', `run ${runId}; server unit=${launch.serverUnit} pid=${launch.serverMainPid}; supervisor unit=${launch.supervisorUnit}; run dir=${launch.paths.runDir}`);
  return `started ${runId}\nrun dir: ${launch.paths.runDir}\nserver unit: ${launch.serverUnit}\nsupervisor unit: ${launch.supervisorUnit}\nstatus: npx tsx scripts/heap-soak/cli.ts status --run-id ${runId}`;
}

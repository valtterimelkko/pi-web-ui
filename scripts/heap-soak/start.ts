import { randomUUID } from 'node:crypto';
import { launchDisposableServer, startSupervisorUnit } from './launcher.js';
import { notify } from './telegram.js';

/** `start` command: launches the real 24h run as two transient systemd units, then returns (they keep running). */
export async function runStart(explicitRunId?: string, options: { extensionsOverlays?: readonly string[] } = {}): Promise<string> {
  const runId = explicitRunId ?? `full-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const launch = await launchDisposableServer(runId, 'full', { extensionsOverlays: options.extensionsOverlays });
  await startSupervisorUnit(runId, launch.paths, launch.supervisorUnit);
  const overlayNote = launch.extensionsOverlaysApplied.length > 0
    ? `; extensions overlay=${launch.extensionsOverlaysApplied.map((a) => a.name).join(',')}`
    : '';
  await notify('milestone', '24h heap soak started', `run ${runId}; server unit=${launch.serverUnit} pid=${launch.serverMainPid}; supervisor unit=${launch.supervisorUnit}${overlayNote}; run dir=${launch.paths.runDir}`);
  return `started ${runId}\nrun dir: ${launch.paths.runDir}\nserver unit: ${launch.serverUnit}\nsupervisor unit: ${launch.supervisorUnit}${overlayNote}\nstatus: npx tsx scripts/heap-soak/cli.ts status --run-id ${runId}`;
}

import { randomUUID } from 'node:crypto';
import { launchDisposableServer, startSupervisorUnit, fullRunHours } from './launcher.js';
import { notify } from './telegram.js';
import { parseFullRunHours } from '../../server/src/live-validation/heap-soak/phases.js';

/** `start` command: launches the real (default 24h, or `--hours <n>`) run as two transient systemd units, then returns (they keep running). */
export async function runStart(explicitRunId?: string, options: { extensionsOverlays?: readonly string[]; hours?: number; keepServer?: boolean } = {}): Promise<string> {
  const runId = explicitRunId ?? `full-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const parsedHours = parseFullRunHours(options.hours ?? 24);
  if (!parsedHours.ok) throw new Error(`refusing to start: ${parsedHours.error}`);
  const launch = await launchDisposableServer(runId, 'full', { extensionsOverlays: options.extensionsOverlays, hours: parsedHours.hours, ...(options.keepServer ? { keepServer: true } : {}) });
  await startSupervisorUnit(runId, launch.paths, launch.supervisorUnit);
  const overlayNote = launch.extensionsOverlaysApplied.length > 0
    ? `; extensions overlay=${launch.extensionsOverlaysApplied.map((a) => a.name).join(',')}`
    : '';
  const windowNote = `; window=${fullRunHours({ hours: parsedHours.hours })}h`;
  const buildNote = `; build=${launch.build.headSha?.slice(0, 8) ?? 'unknown'} (${launch.build.fresh ? 'fresh' : 'STALE'})`;
  const keepNote = options.keepServer ? '; server kept up after completion (--keep-server)' : '';
  await notify('milestone', parsedHours.hours === 24 ? '24h heap soak started' : `${parsedHours.hours}h heap soak started`, `run ${runId}; server unit=${launch.serverUnit} pid=${launch.serverMainPid}; supervisor unit=${launch.supervisorUnit}${windowNote}${buildNote}${keepNote}${overlayNote}; run dir=${launch.paths.runDir}`);
  return `started ${runId}\nrun dir: ${launch.paths.runDir}\nserver unit: ${launch.serverUnit}\nsupervisor unit: ${launch.supervisorUnit}${windowNote}${buildNote}${keepNote}${overlayNote}\nstatus: npx tsx scripts/heap-soak/cli.ts status --run-id ${runId}`;
}

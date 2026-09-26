import { rmSync } from 'node:fs';
import { getUnitStatus, stopUnit, waitForUnitGone } from './systemd-units.js';

export interface TeardownResult {
  serverGone: boolean;
  supervisorGone: boolean;
}

/** Stop both units and verify they are gone (LoadState=not-found). Never touches production. */
export async function teardownUnits(serverUnit: string, supervisorUnit: string): Promise<TeardownResult> {
  // Supervisor first (it depends on the server being reachable; stopping it
  // first avoids a spurious "server unreachable" anomaly ping mid-teardown).
  await stopUnit(supervisorUnit);
  const supervisorGone = await waitForUnitGone(supervisorUnit, 10_000);
  await stopUnit(serverUnit);
  const serverGone = await waitForUnitGone(serverUnit, 10_000);
  return { serverGone, supervisorGone };
}

export async function assertUnitsAbsent(serverUnit: string, supervisorUnit: string): Promise<void> {
  const [server, supervisor] = await Promise.all([getUnitStatus(serverUnit), getUnitStatus(supervisorUnit)]);
  if (server.loadState !== 'not-found') throw new Error(`Server unit still present after teardown: ${serverUnit} (${server.loadState})`);
  if (supervisor.loadState !== 'not-found') throw new Error(`Supervisor unit still present after teardown: ${supervisorUnit} (${supervisor.loadState})`);
}

/** Full disposal of the run directory (Gate 0 preflight only — Gate 1 keeps its run dir per spec). */
export function deleteRunDir(runDir: string): void {
  rmSync(runDir, { recursive: true, force: true });
}

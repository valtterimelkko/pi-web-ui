/** Read-only status for the harness units and placement assertion. */
import { anchorUnitName, serverUnitName, sliceName } from './paths.ts';
import { getUnitStatus, assertPlacementRootIsolated } from './server.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function statusUnits(): Promise<void> {
  const slice = await getUnitStatus(sliceName());
  const anchor = await getUnitStatus(anchorUnitName());
  const server = await getUnitStatus(serverUnitName());
  console.log(JSON.stringify({ slice, anchor, server }, null, 2));
  try {
    const cg = await assertPlacementRootIsolated();
    console.log(`placement assertion OK: anchor cgroup ${cg}`);
  } catch (err) {
    console.error(`placement assertion FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  try {
    const { stdout } = await run('sh', ['-c', 'free -g | awk \'/Memailable|MemAvailable/{print} /Mem:/{print}\'; df -h / | tail -1']);
    console.log(stdout.trim());
  } catch { /* best-effort */ }
}

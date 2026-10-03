/**
 * E2a-4 arm-A / smoke entrypoint.
 *
 *   node --import tsx scripts/e2a-fanout/driver.ts --mode smoke --run-root /root/e2a-runs/a4/smoke-<ts>
 *   node --import tsx scripts/e2a-fanout/driver.ts --mode arm-a  --run-root /root/e2a-runs/a4/arm-a-<ts>
 *
 * Run the driver itself inside a bounded scope (containment rule):
 *   systemd-run --scope --quiet --collect --unit=e2a-4-<mode>-driver \
 *     -p MemoryMax=... -p MemorySwapMax=1G -- node --import tsx scripts/e2a-fanout/driver.ts ...
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { armOptionsFor, runArm } from './lib/run.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = (arg('mode') ?? 'smoke') as 'smoke' | 'arm-a';
const runRoot = arg('run-root') ?? join('/root/e2a-runs/a4', `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(runRoot, { recursive: true });

const opts = armOptionsFor(mode, runRoot);
const result = await runArm(opts);
if (!result.ok) {
  console.error(`DRIVER FAILED: ${result.error ?? 'unknown error'}`);
  process.exit(1);
}
console.log(`DRIVER OK summary=${result.summaryPath}`);

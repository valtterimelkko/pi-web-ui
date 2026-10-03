#!/usr/bin/env npx tsx
/**
 * CLI entry for the E2a-6c crash-recovery harness.
 *
 *   cli.ts prepare   --run-id a6c-r1 --fixtures 6
 *   cli.ts start-server --run-id a6c-r1 --mode smoke|arm
 *   cli.ts smoke     --run-id a6c-r1
 *   cli.ts kill-arm  --run-id a6c-r1 --children 4
 *   cli.ts drain-arm --run-id a6c-r1 --children 4
 *   cli.ts analyse   --run-id a6c-r1 --arm kill
 *   cli.ts stop-server --run-id a6c-r1
 *   cli.ts status
 */
import { statusUnits } from './harness-status.ts';
import { prepare, startServerForRun, stopServerForRun, runSmoke, runKillArm, runDrainArm, runPlacementSmoke, analyseArm } from './driver.ts';

function flag(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const runId = flag(rest, 'run-id', 'a6c-r1') as string;
  switch (command) {
    case 'prepare': {
      const fixtures = Number(flag(rest, 'fixtures', '6'));
      const from = Number(flag(rest, 'from', '1'));
      await prepare(runId, fixtures, from);
      break;
    }
    case 'start-server': {
      const mode = (flag(rest, 'mode', 'arm') === 'smoke' ? 'smoke' : 'arm') as 'smoke' | 'arm';
      await startServerForRun(runId, mode);
      break;
    }
    case 'stop-server':
      await stopServerForRun(runId);
      break;
    case 'smoke':
      await runSmoke(runId);
      break;
    case 'kill-arm': {
      const children = Number(flag(rest, 'children', '4'));
      await runKillArm(runId, children);
      break;
    }
    case 'drain-arm': {
      const children = Number(flag(rest, 'children', '4'));
      await runDrainArm(runId, children);
      break;
    }
    case 'analyse':
      await analyseArm(runId, flag(rest, 'arm', 'kill') as string);
      break;
    case 'placement-smoke':
      await runPlacementSmoke(runId);
      break;
    case 'status':
      await statusUnits();
      break;
    default:
      console.error(`unknown command: ${command ?? '(none)'}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[e2a-crash] FAILED:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

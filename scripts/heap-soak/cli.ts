#!/usr/bin/env npx tsx
/**
 * Heap soak harness CLI. See scripts/heap-soak/README.md.
 *
 *   npx tsx scripts/heap-soak/cli.ts preflight
 *   npx tsx scripts/heap-soak/cli.ts micro
 *   npx tsx scripts/heap-soak/cli.ts start [--run-id <id>]
 *   npx tsx scripts/heap-soak/cli.ts status --run-id <id>
 *   npx tsx scripts/heap-soak/cli.ts stop --run-id <id>
 *   npx tsx scripts/heap-soak/cli.ts report --run-id <id> [--mode micro|full]
 */
import { runGate0 } from './gate0.js';
import { runGate1 } from './gate1.js';
import { runStart } from './start.js';
import { runStatus, runStop } from './status-stop.js';
import { runAnalyze } from './analyze.js';

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'preflight': {
      const result = await runGate0();
      for (const c of result.checks) {
        console.log(`[${c.ok ? 'PASS' : 'FAIL'}]${c.required ? '' : ' (best-effort)'} ${c.name} — ${c.detail}`);
      }
      console.log(result.passed ? `\nGate 0: PASS (run ${result.runId})` : `\nGate 0: FAIL (run ${result.runId})`);
      process.exit(result.passed ? 0 : 1);
      return;
    }
    case 'micro': {
      await runGate1();
      process.exit(0);
      return;
    }
    case 'start': {
      console.log(await runStart(getFlag(rest, '--run-id')));
      process.exit(0);
      return;
    }
    case 'status': {
      const runId = getFlag(rest, '--run-id');
      if (!runId) throw new Error('status requires --run-id <id>');
      console.log(await runStatus(runId));
      process.exit(0);
      return;
    }
    case 'stop': {
      const runId = getFlag(rest, '--run-id');
      if (!runId) throw new Error('stop requires --run-id <id>');
      console.log(await runStop(runId));
      process.exit(0);
      return;
    }
    case 'report': {
      const runId = getFlag(rest, '--run-id');
      if (!runId) throw new Error('report requires --run-id <id>');
      const mode = (getFlag(rest, '--mode') ?? 'full') as 'micro' | 'full';
      console.log(await runAnalyze(runId, mode));
      process.exit(0);
      return;
    }
    default:
      console.error('Usage: cli.ts <preflight|micro|start|status|stop|report> [...args]');
      process.exit(64);
  }
}

main().catch((error) => {
  console.error('[heap-soak] Fatal:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

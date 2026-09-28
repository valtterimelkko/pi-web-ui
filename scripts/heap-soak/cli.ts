#!/usr/bin/env npx tsx
/**
 * Heap soak harness CLI. See scripts/heap-soak/README.md.
 *
 *   npx tsx scripts/heap-soak/cli.ts preflight
 *   npx tsx scripts/heap-soak/cli.ts micro [--keep-server]
 *   npx tsx scripts/heap-soak/cli.ts plan [--hours <n>]
 *   npx tsx scripts/heap-soak/cli.ts start [--run-id <id>] [--hours <n>] [--keep-server]
 *   npx tsx scripts/heap-soak/cli.ts status --run-id <id>
 *   npx tsx scripts/heap-soak/cli.ts stop --run-id <id>
 *   npx tsx scripts/heap-soak/cli.ts report --run-id <id> [--mode micro|full]
 */
import { runGate0 } from './gate0.js';
import { runGate1 } from './gate1.js';
import { runStart } from './start.js';
import { runStatus, runStop } from './status-stop.js';
import { runAnalyze } from './analyze.js';
import { DEFAULT_FULL_RUN_HOURS, fullRunPlan, parseFullRunHours } from '../../server/src/live-validation/heap-soak/phases.js';

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Collect every occurrence of a repeatable flag, in order. */
function getFlags(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) values.push(argv[i + 1]);
  }
  return values;
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
      await runGate1({ extensionsOverlays: getFlags(rest, '--extensions-overlay'), ...(rest.includes('--keep-server') ? { keepServer: true } : {}) });
      process.exit(0);
      return;
    }
    case 'plan': {
      // B0.1 defect 5: dry run — show the scaled schedule a `start --hours <n>` would run, without starting anything.
      const parsed = parseFullRunHours(getFlag(rest, '--hours') ?? String(DEFAULT_FULL_RUN_HOURS));
      if (!parsed.ok) { console.error(`[heap-soak] ${parsed.error}`); process.exit(64); return; }
      const plan = fullRunPlan(parsed.hours);
      console.log([
        `mode: ${plan.mode}`,
        `hours: ${plan.hours}`,
        `window: ${plan.totalMs} ms (${plan.hours} h)`,
        `waveMs: ${plan.waveMs}  idleMs: ${plan.idleMs}  sampleIntervalMs: ${plan.sampleIntervalMs}`,
        `checkpoints (ms): ${plan.checkpointOffsetsMs.join(', ') || '(none)'}`,
        `snapshots in-window (ms): ${plan.interimSnapshotOffsetsMs.join(', ') || '(none)'}`,
        `end snapshot (ms): ${plan.endSnapshotOffsetMs} (taken after the window closes, before teardown)`,
      ].join('\n'));
      process.exit(0);
      return;
    }
    case 'start': {
      const hoursRaw = getFlag(rest, '--hours');
      const parsedHours = hoursRaw === undefined ? { ok: true as const, hours: DEFAULT_FULL_RUN_HOURS } : parseFullRunHours(hoursRaw);
      if (!parsedHours.ok) { console.error(`[heap-soak] ${parsedHours.error}`); process.exit(64); return; }
      console.log(await runStart(getFlag(rest, '--run-id'), {
        extensionsOverlays: getFlags(rest, '--extensions-overlay'),
        hours: parsedHours.hours,
        ...(rest.includes('--keep-server') ? { keepServer: true } : {}),
      }));
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
      console.error('Usage: cli.ts <preflight|micro|plan|start|status|stop|report> [...args]');
      console.error('  plan   [--hours <n>]                                        dry-run the scaled full schedule');
      console.error('  start  [--run-id <id>] [--hours <n>] [--keep-server] [--extensions-overlay <dir>]');
      console.error('  micro  [--keep-server] [--extensions-overlay <dir>]          (server is stopped at completion unless --keep-server)');
      process.exit(64);
  }
}

main().catch((error) => {
  console.error('[heap-soak] Fatal:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

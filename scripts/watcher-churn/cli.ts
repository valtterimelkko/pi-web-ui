#!/usr/bin/env npx tsx
/**
 * B1.1 synthetic watcher-churn driver.
 *
 * Attaches to a disposable validation server's loopback inspector, takes a
 * forced-GC heap snapshot, churns session files in its watched sessions
 * directory (see `churn.ts`), takes a second forced-GC snapshot, and writes a
 * retainer summary (`summarize.ts`) so watcher-retained `Timeout`/`Stats`/
 * `Date`/`FSWatcher` counts and watcher map sizes can be compared.
 *
 * No model tokens are spent: this never starts a Pi child.
 *
 * Usage:
 *   node --import tsx scripts/watcher-churn/cli.ts \
 *     --sessions-dir <validationDir>/pi-sessions \
 *     --inspect-port <port> --out-dir <runDir> --label <name> \
 *     [--files-per-case 1000] [--directories 12] [--settle-ms 8000]
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InspectorClient, assertInspectorLoopbackOnly } from '../heap-soak/inspector.js';
import { prepareChurnDirectories, runChurn, type ChurnCase, type ChurnResult } from './churn.js';
import { assertSessionsDirSafe } from './safety.js';

const CHURN_CASES: ChurnCase[] = ['before-stability', 'inside-debounce', 'after-debounce'];

interface CliArgs {
  sessionsDir: string;
  inspectPort: number;
  outDir: string;
  label: string;
  filesPerCase: number;
  directories: number;
  settleMs: number;
  cases?: ChurnCase[];
  waits?: Partial<Record<ChurnCase, number>>;
  batchSizes?: Partial<Record<ChurnCase, number>>;
  allowUnsafeSessionsDir: boolean;
}

function getFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireFlag(args: string[], flag: string): string {
  const value = getFlag(args, flag);
  if (!value) throw new Error(`missing required ${flag}`);
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  const inspectPortRaw = requireFlag(argv, '--inspect-port');
  const inspectPort = Number(inspectPortRaw);
  if (!Number.isInteger(inspectPort) || inspectPort < 1 || inspectPort > 65535) {
    throw new Error('--inspect-port must be an integer between 1 and 65535');
  }
  return {
    sessionsDir: path.resolve(requireFlag(argv, '--sessions-dir')),
    inspectPort,
    outDir: path.resolve(requireFlag(argv, '--out-dir')),
    label: getFlag(argv, '--label') ?? 'watcher-churn',
    filesPerCase: Number(getFlag(argv, '--files-per-case') ?? '1000'),
    directories: Number(getFlag(argv, '--directories') ?? '12'),
    settleMs: Number(getFlag(argv, '--settle-ms') ?? '8000'),
    cases: getFlag(argv, '--cases')?.split(',').map((s) => s.trim()).filter(Boolean) as ChurnCase[] | undefined,
    waits: parsePerCaseNumbers(argv, '--wait-ms'),
    batchSizes: parsePerCaseNumbers(argv, '--batch-size'),
    allowUnsafeSessionsDir: argv.includes('--allow-unsafe-sessions-dir'),
  };
}

/** Parse `--wait-ms inside-debounce=700,before-stability=15` style overrides. */
function parsePerCaseNumbers(argv: string[], flag: string): Partial<Record<ChurnCase, number>> | undefined {
  const raw = getFlag(argv, flag);
  if (!raw) return undefined;
  const out: Partial<Record<ChurnCase, number>> = {};
  for (const part of raw.split(',')) {
    const [name, value] = part.split('=');
    if (!CHURN_CASES.includes(name as ChurnCase)) throw new Error(`${flag}: unknown case '${name}'`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag}: '${name}' must be a non-negative number`);
    out[name as ChurnCase] = parsed;
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ConstructorDelta {
  constructor: string;
  instancesBefore: number;
  instancesAfter: number;
  instancesDelta: number;
  sessionWatcherHeldBefore: number;
  sessionWatcherHeldAfter: number;
  sessionWatcherHeldDelta: number;
  watcherHeldBefore: number;
  watcherHeldAfter: number;
  watcherHeldDelta: number;
}

interface Verdict {
  label: string;
  filesPerCase: number;
  totalFiles: number;
  retainedChurnPathStringsDelta: number;
  constructors: ConstructorDelta[];
  /** Growth that is attributable to watcher-held state only. */
  sessionWatcherHeldGrowthTotal: number;
  watcherHeldGrowthTotal: number;
  churn: ChurnResult;
  memory: { before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage };
}

function renderVerdict(verdict: Verdict): string {
  const lines: string[] = [];
  lines.push(`label: ${verdict.label}`);
  lines.push(`files churned: ${verdict.totalFiles} (${verdict.filesPerCase}/case)`);
  lines.push(`retained churn path strings Δ: ${verdict.retainedChurnPathStringsDelta}`);
  lines.push('');
  lines.push('constructor        before  after  delta  sWatcherHeldΔ  anyWatcherHeldΔ');
  for (const ctor of verdict.constructors) {
    lines.push(
      `${ctor.constructor.padEnd(18)} ${String(ctor.instancesBefore).padStart(6)} ${String(ctor.instancesAfter).padStart(6)} ` +
      `${String(ctor.instancesDelta).padStart(6)} ${String(ctor.sessionWatcherHeldDelta).padStart(15)} ${String(ctor.watcherHeldDelta).padStart(16)}`,
    );
  }
  lines.push('');
  lines.push(`session-watcher-held growth total: ${verdict.sessionWatcherHeldGrowthTotal}`);
  lines.push(`any-watcher-held growth total: ${verdict.watcherHeldGrowthTotal}`);
  lines.push('');
  lines.push('per-case measured lifetime (delete time minus write completion):');
  for (const c of verdict.churn.cases) {
    lines.push(`  ${c.case.padEnd(18)} target=${c.waitMs}ms measured p50=${c.lifetimeMs.p50}ms p95=${c.lifetimeMs.p95}ms max=${c.lifetimeMs.max}ms (${c.written} files)`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Fail closed before creating anything: the churn writes synthetic session
  // files into this directory and must never touch a production sessions root.
  assertSessionsDirSafe(args.sessionsDir, { allowUnsafe: args.allowUnsafeSessionsDir });
  mkdirSync(args.outDir, { recursive: true });

  const bound = await assertInspectorLoopbackOnly(args.inspectPort);
  console.log(`inspector bound at ${bound}`);

  // Fixed child directories first, so the baseline snapshot already includes
  // their directory watches — any later FSWatcher growth is per-file retention.
  await prepareChurnDirectories(args.sessionsDir, args.directories);

  const inspector = await InspectorClient.connect(args.inspectPort, 20_000);
  await inspector.enable();

  await inspector.collectGarbage();
  const memoryBefore = await inspector.readMemoryUsage();
  const beforePath = path.join(args.outDir, 'before.heapsnapshot');
  const beforeSnap = await inspector.takeHeapSnapshot(beforePath);
  console.log(`before snapshot: ${(beforeSnap.bytesWritten / 1e6).toFixed(1)} MB, heapUsed ${(memoryBefore.heapUsed / 1e6).toFixed(1)} MB`);

  const churn = await runChurn(args.sessionsDir, {
    filesPerCase: args.filesPerCase,
    directories: args.directories,
    cases: args.cases,
    waits: args.waits,
    batchSizes: args.batchSizes,
    onProgress: (line) => console.log(line),
  });
  console.log(`churn done: ${churn.totalWritten} written / ${churn.totalDeleted} deleted in ${(churn.elapsedMs / 1000).toFixed(1)}s`);

  // Let the directory readdir diffs, debounce timers and unlink events settle.
  await sleep(args.settleMs);
  await inspector.collectGarbage();
  const memoryAfter = await inspector.readMemoryUsage();
  const afterPath = path.join(args.outDir, 'after.heapsnapshot');
  const afterSnap = await inspector.takeHeapSnapshot(afterPath);
  console.log(`after snapshot: ${(afterSnap.bytesWritten / 1e6).toFixed(1)} MB, heapUsed ${(memoryAfter.heapUsed / 1e6).toFixed(1)} MB`);
  inspector.close();

  writeFileSync(
    path.join(args.outDir, 'churn.json'),
    JSON.stringify({ args, churn, snapshots: { beforeSnap, afterSnap }, memory: { before: memoryBefore, after: memoryAfter } }, null, 2),
  );

  const summarizeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'summarize.ts');
  const casesJson = JSON.stringify(churn.cases.map(({ case: name, files }) => ({ case: name, files })));
  const summaryJsonPath = path.join(args.outDir, 'summary.json');
  const summaryMdPath = path.join(args.outDir, 'summary.md');
  const summary = spawnSync(process.execPath, [
    '--max-old-space-size=12288',
    '--import', 'tsx',
    summarizeScript,
    '--before', beforePath,
    '--after', afterPath,
    '--targets', 'Timeout,Stats,Date,FSWatcher,SessionWatcher',
    '--out-json', summaryJsonPath,
    '--out-md', summaryMdPath,
    '--label', args.label,
    '--cases-json', casesJson,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (summary.status !== 0) {
    console.error(`summarize failed (exit ${summary.status}):\n${summary.stderr}`);
    process.exitCode = 1;
    return;
  }

  const parsed = JSON.parse(readFileSync(summaryJsonPath, 'utf8')) as {
    before: { retainedChurnPathStrings: number; constructors: Array<{ constructor: string; instances: number; sessionWatcherHeldInstances: number; watcherHeldInstances: number }> };
    after: { retainedChurnPathStrings: number; constructors: Array<{ constructor: string; instances: number; sessionWatcherHeldInstances: number; watcherHeldInstances: number }> };
  };
  const beforeByName = new Map(parsed.before.constructors.map((c) => [c.constructor, c]));
  const constructors: ConstructorDelta[] = parsed.after.constructors.map((after) => {
    const before = beforeByName.get(after.constructor);
    return {
      constructor: after.constructor,
      instancesBefore: before?.instances ?? 0,
      instancesAfter: after.instances,
      instancesDelta: after.instances - (before?.instances ?? 0),
      sessionWatcherHeldBefore: before?.sessionWatcherHeldInstances ?? 0,
      sessionWatcherHeldAfter: after.sessionWatcherHeldInstances,
      sessionWatcherHeldDelta: after.sessionWatcherHeldInstances - (before?.sessionWatcherHeldInstances ?? 0),
      watcherHeldBefore: before?.watcherHeldInstances ?? 0,
      watcherHeldAfter: after.watcherHeldInstances,
      watcherHeldDelta: after.watcherHeldInstances - (before?.watcherHeldInstances ?? 0),
    };
  });

  const verdict: Verdict = {
    label: args.label,
    filesPerCase: args.filesPerCase,
    totalFiles: churn.totalWritten,
    retainedChurnPathStringsDelta: parsed.after.retainedChurnPathStrings - parsed.before.retainedChurnPathStrings,
    constructors,
    sessionWatcherHeldGrowthTotal: constructors.reduce((sum, c) => sum + Math.max(0, c.sessionWatcherHeldDelta), 0),
    watcherHeldGrowthTotal: constructors.reduce((sum, c) => sum + Math.max(0, c.watcherHeldDelta), 0),
    churn,
    memory: { before: memoryBefore, after: memoryAfter },
  };
  writeFileSync(path.join(args.outDir, 'verdict.json'), JSON.stringify(verdict, null, 2));
  writeFileSync(path.join(args.outDir, 'verdict.txt'), renderVerdict(verdict) + '\n');
  console.log('');
  console.log(renderVerdict(verdict));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

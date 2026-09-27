/**
 * First-vs-latest heap snapshot comparison: aggregate self-size and count by
 * constructor name, top growers, retainer paths and a cut test. Runs the
 * actual parse+analysis in a separate Node process with a large heap
 * (snapshot-diff-worker.ts) so a multi-hundred-MB `.heapsnapshot` file never
 * pressures this process.
 *
 * B0 defect 2: the "after" snapshot is the latest VALID one. A1's 12 h
 * declared snapshot was 0 bytes (its server had died hours earlier); the old
 * code picked it blindly and crashed. Now an empty/unparseable candidate is
 * skipped and the previous latest snapshot (the heap-threshold snapshots) is
 * used, with the skipped files named in the report.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConstructorAggregate, ConstructorGrowth } from '../../server/src/live-validation/heap-soak/snapshot-parse.js';
import {
  parseSnapshotFilename,
  selectSnapshotCandidates,
  type SnapshotFileInfo,
} from '../../server/src/live-validation/heap-soak/snapshot-selection.js';
import type { ConstructorRetainerAnalysis, CutTestResult } from '../../server/src/live-validation/heap-soak/snapshot-retainers.js';

const execFile = promisify(execFileCb);

/** Above this combined size, skip the in-process comparison (default 1.5 GB combined). */
export const MAX_COMBINED_SNAPSHOT_BYTES = 1_500_000_000;
const WORKER_HEAP_MB = 12_288;

export interface SnapshotDiffResult {
  ok: true;
  before: ConstructorAggregate[];
  after: ConstructorAggregate[];
  growth: ConstructorGrowth[];
  /** Which snapshot the comparison actually used (the latest one that parsed). */
  usedAfterPath: string;
  usedAfterName: string;
  retainers: ConstructorRetainerAnalysis[];
  cutSpecs: string[];
  cutBaseline: CutTestResult;
  cutApplied: CutTestResult;
}

export interface SnapshotDiffSkipped {
  ok: false;
  reason: string;
  devToolsInstructions: string;
}

const DEVTOOLS_INSTRUCTIONS =
  'Open Chrome DevTools -> Memory tab -> Load both .heapsnapshot files (start and end) -> '
  + 'select the later snapshot -> switch the view dropdown to "Comparison" against the earlier one -> '
  + 'sort by "Size Delta" to see the top-growing constructors.';

/** List a run's snapshot files with their sizes, parsed by the harness naming convention. */
export function listSnapshotFiles(snapshotDir: string): SnapshotFileInfo[] {
  if (!existsSync(snapshotDir)) return [];
  const files: SnapshotFileInfo[] = [];
  for (const name of readdirSync(snapshotDir)) {
    const parsed = parseSnapshotFilename(name);
    if (!parsed) continue;
    const fullPath = path.join(snapshotDir, name);
    try {
      files.push({ name, path: fullPath, sizeBytes: statSync(fullPath).size, ...parsed });
    } catch { /* vanished mid-scan */ }
  }
  return files;
}

interface WorkerOutput {
  before: ConstructorAggregate[];
  after: ConstructorAggregate[];
  growth: ConstructorGrowth[];
  retainers: ConstructorRetainerAnalysis[];
  cutSpecs: string[];
  cutBaseline: CutTestResult;
  cutApplied: CutTestResult;
}

export async function compareSnapshots(beforePath: string, afterPath: string): Promise<SnapshotDiffResult | SnapshotDiffSkipped> {
  const beforeSize = statSync(beforePath).size;
  const afterSize = statSync(afterPath).size;
  if (beforeSize + afterSize > MAX_COMBINED_SNAPSHOT_BYTES) {
    return {
      ok: false,
      reason: `Combined snapshot size ${((beforeSize + afterSize) / 1e9).toFixed(2)} GB exceeds the ${(MAX_COMBINED_SNAPSHOT_BYTES / 1e9).toFixed(2)} GB comparison threshold — skipping in-process parsing rather than risking an OOM.`,
      devToolsInstructions: DEVTOOLS_INSTRUCTIONS,
    };
  }

  const workerPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'snapshot-diff-worker.ts');
  try {
    const { stdout } = await execFile(process.execPath, [
      `--max-old-space-size=${WORKER_HEAP_MB}`, '--import', 'tsx', workerPath, beforePath, afterPath,
    ], { maxBuffer: 1_000_000_000, timeout: 20 * 60_000 });
    const parsed = JSON.parse(stdout) as WorkerOutput;
    return {
      ok: true,
      ...parsed,
      usedAfterPath: afterPath,
      usedAfterName: path.basename(afterPath),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Snapshot comparison worker failed: ${error instanceof Error ? error.message : String(error)}`,
      devToolsInstructions: DEVTOOLS_INSTRUCTIONS,
    };
  }
}

/** Find the earliest- and latest-offset `.heapsnapshot` files in a run's snapshots/ dir (legacy helper, name-based). */
export function findFirstLastSnapshots(snapshotDir: string): { firstPath: string; lastPath: string } | undefined {
  const files = listSnapshotFiles(snapshotDir).sort((a, b) => a.offsetMs - b.offsetMs);
  if (files.length < 2) return undefined;
  return { firstPath: files[0].path, lastPath: files[files.length - 1].path };
}

/**
 * Full section: pick the start + latest-valid after candidates, try each until
 * one parses, and render the comparison. Names any skipped (empty) snapshots.
 */
export async function snapshotComparisonSection(runDir: string): Promise<string> {
  const files = listSnapshotFiles(path.join(runDir, 'snapshots'));
  const selection = selectSnapshotCandidates(files);
  if (!selection.start || selection.afterCandidates.length === 0) {
    return '## Snapshot comparison\n\nFewer than 2 valid (non-empty) snapshots were taken — nothing to compare.\n';
  }

  const attempts: string[] = [];
  for (const candidate of selection.afterCandidates) {
    const result = await compareSnapshots(selection.start.path, candidate.path);
    if (result.ok) {
      return renderSnapshotDiffMarkdown(result, { skipped: selection.skipped, attempts });
    }
    attempts.push(`${candidate.name}: ${result.reason}`);
  }
  return `## Snapshot comparison\n\nAll ${selection.afterCandidates.length} candidate snapshots failed to parse:\n\n${attempts.map((a) => `- ${a}`).join('\n')}\n\n${DEVTOOLS_INSTRUCTIONS}\n`;
}

export function renderSnapshotDiffMarkdown(
  result: SnapshotDiffResult,
  context: { skipped?: { name: string; reason: string }[]; attempts?: string[] } = {},
  topN = 15,
): string {
  const lines = ['## Snapshot comparison (first vs latest valid) — top growers by self-size delta', ''];
  lines.push(`Compared against: \`${result.usedAfterName}\`.`);
  if (context.skipped && context.skipped.length > 0) {
    lines.push('');
    lines.push(`Skipped ${context.skipped.length} invalid snapshot(s): ${context.skipped.map((s) => `\`${s.name}\` (${s.reason})`).join(', ')}.`);
  }
  if (context.attempts && context.attempts.length > 0) {
    lines.push('');
    lines.push('Fell back past unparseable candidates:');
    for (const attempt of context.attempts) lines.push(`- ${attempt}`);
  }
  lines.push('');
  lines.push('### Top growers by constructor/type');
  lines.push('| constructor/type | count before | count after | size before (MB) | size after (MB) | delta (MB) |');
  lines.push('|---|---|---|---|---|---|');
  for (const g of result.growth.slice(0, topN)) {
    lines.push(`| ${g.label} | ${g.countBefore} | ${g.countAfter} | ${(g.sizeBeforeBytes / 1e6).toFixed(2)} | ${(g.sizeAfterBytes / 1e6).toFixed(2)} | ${(g.deltaBytes / 1e6).toFixed(2)} |`);
  }

  if (result.retainers.length > 0) {
    lines.push('');
    lines.push('### Dominant shortest retainer chains (latest valid snapshot)');
    for (const retainer of result.retainers) {
      lines.push('');
      lines.push(`**${retainer.constructor}**: ${retainer.instances} instance(s), ${retainer.reachableInstances} reachable from the root.`);
      if (retainer.chains.length === 0) {
        lines.push('- (no reachable instances)');
        continue;
      }
      for (const group of retainer.chains) {
        lines.push(`- ${group.instances} instance(s) via:`);
        lines.push('  ```');
        for (const line of group.chain.split('\n')) lines.push(`  ${line}`);
        lines.push('  ```');
      }
    }
  }

  lines.push('');
  lines.push('### Cut test (what stays reachable when chosen retainers are removed)');
  const appliedCuts = result.cutApplied.appliedCuts;
  if (appliedCuts.length === 0) {
    lines.push('No named-property retainer structures were derived from the dominant chains; baseline only.');
  } else {
    lines.push(`Cutting ${appliedCuts.map((s) => `\`${s}\``).join(', ')} (baseline vs cut):`);
  }
  lines.push(`- Baseline: ${result.cutBaseline.reachableBytes} bytes reachable, ${result.cutBaseline.reachableInstances}/${result.cutBaseline.targetInstances} AgentSession instances reachable.`);
  lines.push(`- After cuts: ${result.cutApplied.reachableBytes} bytes reachable, ${result.cutApplied.reachableInstances}/${result.cutApplied.targetInstances} AgentSession instances reachable.`);
  return lines.join('\n');
}

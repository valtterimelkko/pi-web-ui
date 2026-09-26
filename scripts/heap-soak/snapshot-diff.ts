/**
 * First-vs-last heap snapshot comparison: aggregate self-size and count by
 * constructor name, top growers. Runs the actual parse+aggregate in a
 * separate Node process with a large heap (snapshot-diff-worker.ts) so a
 * multi-hundred-MB `.heapsnapshot` file never pressures this process. If the
 * combined file size is too large for a reasonably-sized worker heap, this
 * says so precisely and leaves DevTools instructions instead of guessing.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ConstructorAggregate, ConstructorGrowth } from '../../server/src/live-validation/heap-soak/snapshot-parse.js';

const execFile = promisify(execFileCb);

/** Above this combined size, skip the in-process comparison (default 1.5 GB combined). */
export const MAX_COMBINED_SNAPSHOT_BYTES = 1_500_000_000;
const WORKER_HEAP_MB = 8192;

export interface SnapshotDiffResult {
  ok: true;
  before: ConstructorAggregate[];
  after: ConstructorAggregate[];
  growth: ConstructorGrowth[];
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
    ], { maxBuffer: 1_000_000_000, timeout: 10 * 60_000 });
    const parsed = JSON.parse(stdout) as { before: ConstructorAggregate[]; after: ConstructorAggregate[]; growth: ConstructorGrowth[] };
    return { ok: true, ...parsed };
  } catch (error) {
    return {
      ok: false,
      reason: `Snapshot comparison worker failed: ${error instanceof Error ? error.message : String(error)}`,
      devToolsInstructions: DEVTOOLS_INSTRUCTIONS,
    };
  }
}

/** Find the earliest- and latest-offset `.heapsnapshot` files in a run's snapshots/ dir, by the `snapshot-<ms>ms.heapsnapshot` naming convention. */
export function findFirstLastSnapshots(snapshotDir: string): { firstPath: string; lastPath: string } | undefined {
  if (!existsSync(snapshotDir)) return undefined;
  const files = readdirSync(snapshotDir)
    .map((name) => ({ name, offset: Number(name.match(/^snapshot-(\d+)ms\.heapsnapshot$/)?.[1]) }))
    .filter((f) => Number.isFinite(f.offset))
    .sort((a, b) => a.offset - b.offset);
  if (files.length < 2) return undefined;
  return {
    firstPath: path.join(snapshotDir, files[0].name),
    lastPath: path.join(snapshotDir, files[files.length - 1].name),
  };
}

/** Full section: locate first/last snapshots in a run dir and render the comparison markdown, or a short "not enough snapshots" note. */
export async function snapshotComparisonSection(runDir: string): Promise<string> {
  const found = findFirstLastSnapshots(path.join(runDir, 'snapshots'));
  if (!found) return '## Snapshot comparison\n\nFewer than 2 snapshots were taken — nothing to compare.\n';
  const result = await compareSnapshots(found.firstPath, found.lastPath);
  return renderSnapshotDiffMarkdown(result);
}

export function renderSnapshotDiffMarkdown(result: SnapshotDiffResult | SnapshotDiffSkipped, topN = 15): string {
  if (!result.ok) {
    return `## Snapshot comparison\n\nSkipped: ${result.reason}\n\n${result.devToolsInstructions}\n`;
  }
  const lines = ['## Snapshot comparison (first vs last) — top growers by self-size delta', ''];
  lines.push('| constructor/type | count before | count after | size before (MB) | size after (MB) | delta (MB) |');
  lines.push('|---|---|---|---|---|---|');
  for (const g of result.growth.slice(0, topN)) {
    lines.push(`| ${g.label} | ${g.countBefore} | ${g.countAfter} | ${(g.sizeBeforeBytes / 1e6).toFixed(2)} | ${(g.sizeAfterBytes / 1e6).toFixed(2)} | ${(g.deltaBytes / 1e6).toFixed(2)} |`);
  }
  return lines.join('\n');
}

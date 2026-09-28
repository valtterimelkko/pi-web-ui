/**
 * Synthetic session-file churn for B1.1 (plan step B1.1).
 *
 * Writes and deletes session JSONL files in a running validation server's
 * watched sessions directory (`SESSION_DIR`, `<dir>/pi-sessions`) with no model
 * tokens. Three cases mirror the retention paths the confirmation soak
 * (full-1790523945117-ea387201) exposed:
 *
 *  - `before-stability`: created and deleted within chokidar's former 300 ms
 *    `awaitWriteFinish` window, so the `add` was never declared stable.
 *  - `inside-debounce`: deleted while `SessionWatcher`'s 500 ms debounce timer
 *    is pending (after chokidar emitted `add`, before it fired).
 *  - `after-debounce`: deleted after the debounce timer fired and emitted.
 *
 * The caller takes a forced-GC heap snapshot before and after this churn.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type ChurnCase = 'before-stability' | 'inside-debounce' | 'after-debounce';

export interface ChurnCasePlan {
  case: ChurnCase;
  files: number;
  /** Delay between writing and deleting each batch. */
  waitMs: number;
  /** Files written (and then deleted) concurrently per batch. */
  batchSize: number;
}

export interface ChurnCaseResult extends ChurnCasePlan {
  elapsedMs: number;
  written: number;
  deleted: number;
  /**
   * Measured per-file lifetimes (delete time minus write completion time).
   * These are the *actually delivered* delays; the plan's `waitMs` is only the
   * target, and chokidar's directory-read/add latency is build-dependent.
   */
  lifetimeMs: { min: number; p50: number; p95: number; max: number };
}

function summarizeLifetimes(values: number[]): { min: number; p50: number; p95: number; max: number } {
  if (values.length === 0) return { min: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

export interface ChurnOptions {
  /** Number of files per case. Default 1000. */
  filesPerCase?: number;
  /**
   * Fixed child directories to churn in, created before the `before`
   * snapshot. Keeping the directory set fixed means any FSWatcher growth is
   * per-file retention, not new directory watches.
   */
  directories?: number;
  /** Restrict the run to these cases (all three when omitted). */
  cases?: ChurnCase[];
  /** Per-case override for the write→delete delay (ms). */
  waits?: Partial<Record<ChurnCase, number>>;
  /** Per-case override for the batch size (files written/deleted together). */
  batchSizes?: Partial<Record<ChurnCase, number>>;
  /** Structured progress sink (defaults to a no-op). */
  onProgress?: (line: string) => void;
}

export interface ChurnResult {
  totalWritten: number;
  totalDeleted: number;
  cases: ChurnCaseResult[];
  childDirs: string[];
  elapsedMs: number;
}

function sessionContent(id: string): string {
  const now = Date.now();
  return (
    JSON.stringify({ type: 'session', id, cwd: '/tmp/watcher-churn', timestamp: now }) + '\n' +
    JSON.stringify({
      type: 'message',
      id: `${id}-m1`,
      timestamp: now,
      message: { role: 'user', content: [{ type: 'text', text: 'churn' }] },
    }) + '\n'
  );
}

/** Create the fixed child directories before the baseline snapshot. */
export async function prepareChurnDirectories(sessionsDir: string, directories: number): Promise<string[]> {
  const dirs: string[] = [];
  for (let i = 0; i < directories; i += 1) {
    const dir = path.join(sessionsDir, `churn-ws-${i}`);
    await mkdir(dir, { recursive: true });
    dirs.push(dir);
  }
  return dirs;
}

function buildPlans(filesPerCase: number): ChurnCasePlan[] {
  // Delays are measured from WRITE COMPLETION and are *intended* cohorts, not
  // event-aligned ones: on the old `awaitWriteFinish` build chokidar declares an
  // add ~300 ms after it observes the file, so the same wall-clock delay lands
  // in a different phase than on the corrected build. `runChurn` records the
  // measured lifetime percentile per case so the comparison is honest about it.
  return [
    // ~300 ms: intended to land before chokidar's old awaitWriteFinish add, so
    // the per-file watcher / `_watched` entry / `Stats` closure are retained on
    // the old build.
    { case: 'before-stability', files: filesPerCase, waitMs: 300, batchSize: 40 },
    // ~700 ms: intended to land after the add but inside SessionWatcher's 500 ms
    // debounce window on the old build.
    { case: 'inside-debounce', files: filesPerCase, waitMs: 700, batchSize: 40 },
    // ~1200 ms: intended control — the debounce fired and emitted before unlink.
    { case: 'after-debounce', files: filesPerCase, waitMs: 1200, batchSize: 40 },
  ];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runChurn(
  sessionsDir: string,
  options: ChurnOptions = {},
): Promise<ChurnResult> {
  const filesPerCase = options.filesPerCase ?? 1000;
  const directoryCount = options.directories ?? 12;
  const progress = options.onProgress ?? (() => {});
  const startedAt = Date.now();
  const childDirs = await prepareChurnDirectories(sessionsDir, directoryCount);
  const selectedCases = options.cases && options.cases.length > 0 ? new Set(options.cases) : undefined;
  const plans = buildPlans(filesPerCase)
    .filter((plan) => !selectedCases || selectedCases.has(plan.case))
    .map((plan) => ({
      ...plan,
      waitMs: options.waits?.[plan.case] ?? plan.waitMs,
      batchSize: options.batchSizes?.[plan.case] ?? plan.batchSize,
    }));
  const results: ChurnCaseResult[] = [];

  for (const plan of plans) {
    const caseStarted = Date.now();
    let written = 0;
    let deleted = 0;
    let fileIndex = 0;
    const lifetimesMs: number[] = [];
    while (fileIndex < plan.files) {
      const batch: Array<{ filePath: string; writtenAt: number }> = [];
      const batchCount = Math.min(plan.batchSize, plan.files - fileIndex);
      for (let i = 0; i < batchCount; i += 1) {
        const dir = childDirs[(fileIndex + i) % childDirs.length];
        const id = randomUUID();
        const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
        await writeFile(filePath, sessionContent(id));
        batch.push({ filePath, writtenAt: Date.now() });
      }
      written += batch.length;
      await sleep(plan.waitMs);
      const deletedAt = Date.now();
      await Promise.all(batch.map(({ filePath }) => rm(filePath, { force: true })));
      for (const { writtenAt } of batch) lifetimesMs.push(deletedAt - writtenAt);
      deleted += batch.length;
      fileIndex += batchCount;
      progress(`  ${plan.case}: ${fileIndex}/${plan.files} written+deleted`);
    }
    results.push({
      ...plan,
      elapsedMs: Date.now() - caseStarted,
      written,
      deleted,
      lifetimeMs: summarizeLifetimes(lifetimesMs),
    });
  }

  return {
    totalWritten: results.reduce((sum, r) => sum + r.written, 0),
    totalDeleted: results.reduce((sum, r) => sum + r.deleted, 0),
    cases: results,
    childDirs,
    elapsedMs: Date.now() - startedAt,
  };
}

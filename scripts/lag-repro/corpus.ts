/**
 * B1.2 lag reproduction — synthetic Pi session corpus.
 *
 * Shaped like production, never copied from it:
 *   - the production session store (2026-09-28) held 718 `.jsonl` files across
 *     243 encoded-cwd directories, with a long right tail (median 609 KB,
 *     p90 1.9 MB, max 73 MB);
 *   - this generator matches the file count, the cwd (directory) count and the
 *     per-bucket proportions exactly, and draws byte sizes from the same
 *     buckets;
 *   - `--size-scale` (default 0.05) scales byte sizes so a disposable run stays
 *     bounded (~40 MB instead of ~786 MB). The instrumented
 *     `pi.session.open_file` span reports parse duration separately, so a
 *     size-sensitive cost is still visible; the dominant per-open cost under
 *     test (extension load) is independent of file size.
 *
 * No production session content is read or written; every byte here is
 * generated from templates.
 */

import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface CorpusBucket {
  count: number;
  minBytes: number;
  maxBytes: number;
}

/** Production-derived bucket proportions (718 files in total). */
export const PRODUCTION_BUCKETS: CorpusBucket[] = [
  { count: 91, minBytes: 5_000, maxBytes: 50_000 },
  { count: 69, minBytes: 50_000, maxBytes: 200_000 },
  { count: 323, minBytes: 200_000, maxBytes: 1_000_000 },
  { count: 219, minBytes: 1_000_000, maxBytes: 5_000_000 },
  { count: 16, minBytes: 5_000_000, maxBytes: 10_000_000 },
];

export const PRODUCTION_CWD_COUNT = 243;
export const PRODUCTION_FILE_COUNT = 718;

export interface CorpusOptions {
  /** Directory that will hold the generated cwd roots (must exist or be creatable). */
  cwdRoot: string;
  /** Directory the session JSONL files are written to (the server's sessions dir). */
  sessionsDir: string;
  /** Byte-size multiplier (default 0.05). */
  sizeScale?: number;
  /** Deterministic seed (default 20260928). */
  seed?: number;
  cwdCount?: number;
  buckets?: CorpusBucket[];
  onProgress?: (done: number, total: number) => void;
}

export interface CorpusSummary {
  cwdCount: number;
  fileCount: number;
  totalBytes: number;
  biggestBytes: number;
  sessionsDir: string;
  cwds: string[];
  /** sessionPath -> cwd, for the driver. */
  sessions: Array<{ path: string; cwd: string; bytes: number }>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Realistic-shaped but synthetic cwd names (none of them is a real project). */
export function syntheticCwds(root: string, count: number, seed = 20260928): string[] {
  const rand = mulberry32(seed);
  const worktreeLanes = [
    'orch-scaling', 'wave-2', 'r49d', 'wave-4', 'interim', 'soak-b0-1',
    'soak-b1-1', 'lag-repro', 'review-r2', 'voice-lab',
  ];
  const projects = [
    'agent-os', 'pi-web-ui', 'pi-enhancement', 'system-map', 'agent-benchmarks',
    'fintech', 'si', '79tower', 'agentos-usage-study', 'skills-global',
    'claude-enhancement', 'cmd-enhancement', 'jev-session-eval', 'orch-ops',
    'knowledge-base', 'research-notes', 'client-work', 'scratchpad',
  ];
  const cwds = new Set<string>();
  while (cwds.size < count) {
    const project = projects[Math.floor(rand() * projects.length)];
    const lane = worktreeLanes[Math.floor(rand() * worktreeLanes.length)];
    const suffix = Math.floor(rand() * 10_000);
    const shape = rand();
    if (shape < 0.45) cwds.add(join(root, `${project}-${suffix}`));
    else if (shape < 0.85) cwds.add(join(root, lane, `${project}-${suffix}`));
    else cwds.add(join(root, `tmp-${project}-${suffix}`));
  }
  return [...cwds];
}

/** The SDK encodes cwd into the sessions subdirectory name by replacing separators. */
export function encodeCwdDir(cwd: string): string {
  return `--${cwd.replace(/[/\\:]/g, '-')}--`;
}

function messageLines(targetBytes: number, headerBytes: number, rand: () => number, nowMs: number): string[] {
  const lines: string[] = [];
  let bytes = headerBytes;
  let t = nowMs;
  while (bytes < targetBytes) {
    t += 1_000 + Math.floor(rand() * 5_000);
    const isUser = lines.length % 3 === 0;
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(
      3 + Math.floor(rand() * 12),
    );
    const entry = isUser
      ? {
          type: 'message',
          id: randomUUID(),
          timestamp: new Date(t).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text: filler }], timestamp: t },
        }
      : {
          type: 'message',
          id: randomUUID(),
          timestamp: new Date(t).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: filler }], timestamp: t },
        };
    const line = `${JSON.stringify(entry)}\n`;
    lines.push(line);
    bytes += line.length;
  }
  return lines;
}

/**
 * Write the corpus. Files are written in `<buckets>` order so a run can be
 * interrupted and resumed without re-deciding sizes (the seed is stable).
 */
export async function generateCorpus(options: CorpusOptions): Promise<CorpusSummary> {
  const sizeScale = options.sizeScale ?? 0.05;
  const buckets = options.buckets ?? PRODUCTION_BUCKETS;
  const cwdCount = options.cwdCount ?? PRODUCTION_CWD_COUNT;
  const rand = mulberry32(options.seed ?? 20260928);
  const cwds = syntheticCwds(options.cwdRoot, cwdCount, options.seed ?? 20260928);
  await mkdir(options.sessionsDir, { recursive: true });
  for (const cwd of cwds) await mkdir(cwd, { recursive: true });

  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const sessions: CorpusSummary['sessions'] = [];
  let done = 0;
  let totalBytes = 0;
  let biggestBytes = 0;

  for (const bucket of buckets) {
    for (let i = 0; i < bucket.count; i += 1) {
      // Round-robin across the cwd set so every generated cwd is used (a random
      // draw leaves some unused and under-states cwd diversity).
      const cwd = cwds[done % cwds.length];
      const rawTarget = bucket.minBytes + rand() * (bucket.maxBytes - bucket.minBytes);
      const targetBytes = Math.max(4_000, Math.round(rawTarget * sizeScale));
      const sessionId = randomUUID();
      const startedMs = Date.now() - Math.floor(rand() * 30 * 24 * 3600 * 1000);
      const header = {
        type: 'session',
        id: sessionId,
        cwd,
        timestamp: new Date(startedMs).toISOString(),
        version: 1,
      };
      const headerLine = `${JSON.stringify(header)}\n`;
      const lines = messageLines(targetBytes, headerLine.length, rand, startedMs);
      const dir = join(options.sessionsDir, encodeCwdDir(cwd));
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${new Date(startedMs).toISOString().replace(/[:.]/g, '-')}_${sessionId}.jsonl`);
      // Streaming write: a 10 MB-capped file stays cheap, and the open/close
      // loop keeps peak memory flat regardless of corpus size.
      const handle = await open(filePath, 'w');
      try {
        await handle.write(headerLine);
        for (const line of lines) await handle.write(line);
      } finally {
        await handle.close();
      }
      const bytes = headerLine.length + lines.reduce((sum, line) => sum + line.length, 0);
      totalBytes += bytes;
      biggestBytes = Math.max(biggestBytes, bytes);
      sessions.push({ path: filePath, cwd, bytes });
      done += 1;
      if (options.onProgress && done % 50 === 0) options.onProgress(done, total);
    }
  }
  options.onProgress?.(done, total);
  return {
    cwdCount: new Set(sessions.map((s) => s.cwd)).size,
    fileCount: sessions.length,
    totalBytes,
    biggestBytes,
    sessionsDir: options.sessionsDir,
    cwds,
    sessions,
  };
}

/** Write a machine-readable copy of the corpus index for the driver. */
export async function writeCorpusIndex(summary: CorpusSummary, indexPath: string): Promise<void> {
  await writeFile(indexPath, JSON.stringify(summary, null, 2));
}

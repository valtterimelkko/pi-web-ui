#!/usr/bin/env npx tsx
/**
 * E2a-1 — production telemetry comparison (read-only).
 *
 * Reads production's A2 health telemetry (~/.pi-web-ui/metrics/health-metrics.jsonl
 * and its rotations) over a stated window and computes, with the plan §2
 * baseline's exact method (spike minutes = distinct UTC minutes with ≥1
 * reading at lag p99 ≥ 300 ms; heap floor/ceiling = min/max SAMPLED
 * heapUsedBytes; peak/mean activeTurns; sample count):
 *
 *   npx tsx scripts/e2a-soak/prod-telemetry.ts \
 *     --from 2026-10-02T16:47:37Z --as-of 2026-10-03T01:05:00Z \
 *     [--metrics-dir /root/.pi-web-ui/metrics] \
 *     [--exclude <ISO-from>/<ISO-to>=<label>]… \
 *     --out <run-dir>/prod-telemetry.json
 *
 * The window end (--as-of) is frozen into the output so re-runs agree.
 * Restarts are detected from uptimeSec going backwards inside the window and
 * reported (the J window should contain none). Nothing here writes to
 * production: the metrics files are opened read-only.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import {
  consecutiveHighPairs,
  excludeWindows,
  filterWindow,
  heapRangeBytes,
  peakAndMeanActiveTurns,
  spikeMinuteBuckets,
  type TelemetryRow,
} from '../../server/src/live-validation/heap-soak/telemetry-replay.js';

const SPIKE_THRESHOLD_MS = 300; // §2/B2: lag p99 ≥ 300 ms is a spike reading

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) {
    console.error(`--${name} is required`);
    process.exit(64);
  }
  return value;
}

function parseIso(name: string, value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    console.error(`--${name} is not an ISO timestamp: ${value}`);
    process.exit(64);
  }
  return ms;
}

interface RawRow extends TelemetryRow {
  at: string;
  uptimeSec: number;
  lagMaxMs?: number;
  residentSessions?: number;
  registryEntries?: number;
  admissionActiveTurns?: number;
}

function readMetricsRows(metricsDir: string): { rows: RawRow[]; files: { file: string; lines: number; parsed: number }[] } {
  const files = readdirSync(metricsDir)
    .filter((f) => f.startsWith('health-metrics') && f.endsWith('.jsonl'))
    .sort();
  const rows: RawRow[] = [];
  const stats: { file: string; lines: number; parsed: number }[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(metricsDir, file), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    let parsed = 0;
    for (const line of lines) {
      try {
        const d = JSON.parse(line) as Record<string, unknown>;
        if (typeof d.atMs !== 'number' || typeof d.lagP99Ms !== 'number' || typeof d.heapUsedBytes !== 'number') continue;
        rows.push({
          at: String(d.at),
          atMs: d.atMs,
          uptimeSec: typeof d.uptimeSec === 'number' ? d.uptimeSec : -1,
          lagP99Ms: d.lagP99Ms,
          lagMaxMs: typeof d.lagMaxMs === 'number' ? d.lagMaxMs : undefined,
          heapUsedBytes: d.heapUsedBytes,
          activeTurns: typeof d.activeTurns === 'number' ? d.activeTurns : 0,
          residentSessions: typeof d.residentSessions === 'number' ? d.residentSessions : undefined,
          registryEntries: typeof d.registryEntries === 'number' ? d.registryEntries : undefined,
          admissionActiveTurns: typeof d.admissionActiveTurns === 'number' ? d.admissionActiveTurns : undefined,
        });
        parsed += 1;
      } catch { /* skip malformed line; counted via parsed vs lines */ }
    }
    stats.push({ file, lines: lines.length, parsed });
  }
  rows.sort((a, b) => a.atMs - b.atMs);
  return { rows, files: stats };
}

/** Restarts inside a window: uptimeSec going backwards between adjacent rows. */
function findRestarts(rows: readonly RawRow[]): { at: string; fromUptimeSec: number; toUptimeSec: number }[] {
  const restarts: { at: string; fromUptimeSec: number; toUptimeSec: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.uptimeSec >= 0 && cur.uptimeSec >= 0 && cur.uptimeSec + 120 < prev.uptimeSec) {
      restarts.push({ at: cur.at, fromUptimeSec: prev.uptimeSec, toUptimeSec: cur.uptimeSec });
    }
  }
  return restarts;
}

function summarise(rows: readonly TelemetryRow[]) {
  const spikes = spikeMinuteBuckets(rows, SPIKE_THRESHOLD_MS);
  const heap = heapRangeBytes(rows);
  const turns = peakAndMeanActiveTurns(rows);
  return {
    sampleCount: rows.length,
    windowStart: rows.length > 0 ? rows[0].atMs : null,
    windowEnd: rows.length > 0 ? rows[rows.length - 1].atMs : null,
    windowHours: rows.length > 1 ? Number(((rows[rows.length - 1].atMs - rows[0].atMs) / 3_600_000).toFixed(3)) : 0,
    spikeMinutes: spikes.count,
    spikeMinutesList: spikes.minutes,
    maxSpikeLagP99Ms: spikes.maxSpikeMs,
    consecutiveHighPairs: consecutiveHighPairs(rows, SPIKE_THRESHOLD_MS),
    heapFloorBytes: heap.minBytes,
    heapCeilingBytes: heap.maxBytes,
    peakActiveTurns: turns.peak,
    meanActiveTurns: turns.mean === null ? null : Number(turns.mean.toFixed(3)),
  };
}

async function main(): Promise<void> {
  const fromMs = parseIso('from', requireArg('from'));
  const asOfRaw = arg('as-of');
  const asOfMs = asOfRaw ? parseIso('as-of', asOfRaw) : Date.now();
  const metricsDir = arg('metrics-dir') ?? path.join(homedir(), '.pi-web-ui', 'metrics');
  const outPath = requireArg('out');

  const excludes = (arg('exclude') ? process.argv.flatMap((a, i) => (a === '--exclude' ? [process.argv[i + 1]] : [])) : [])
    .map((spec) => {
      const [range, label] = spec.split('=', 2);
      const [fromS, toS] = range.split('/', 2);
      return { fromMs: parseIso('exclude', fromS), toMs: parseIso('exclude', toS), label: label ?? 'unlabelled' };
    });

  const { rows: allRows, files } = readMetricsRows(metricsDir);
  const windowRowsAll = filterWindow(allRows as RawRow[], fromMs, asOfMs) as RawRow[];
  const restarts = findRestarts(windowRowsAll);
  const windowRowsKept = excludeWindows(windowRowsAll, excludes) as TelemetryRow[];

  const full = summarise(windowRowsAll);
  const kept = summarise(windowRowsKept);

  // Method validation: recompute the §2 A2 baseline (first 22 h after the
  // 2026-09-27 17:39 restart) from the same rotation the window came from.
  // The plan's number is 17 spike minutes in 22 h — this check shows whether
  // the method above reproduces it from the same file.
  const baselineFrom = parseIso('baseline-from', arg('baseline-from') ?? '2026-09-27T17:39:32Z');
  const baselineTo = baselineFrom + 22 * 3_600_000;
  const baselineRows = filterWindow(allRows as TelemetryRow[], baselineFrom, baselineTo);
  const baseline = summarise(baselineRows);

  const result = {
    schema: 'e2a-1-prod-telemetry/v1',
    generatedAt: new Date().toISOString(),
    window: { fromMs, from: new Date(fromMs).toISOString(), asOfMs, asOf: new Date(asOfMs).toISOString(), frozen: true },
    metricsDir,
    files,
    restartsInsideWindow: restarts,
    excludedWindows: excludes,
    fullWindow: full,
    stressWindowExcluded: kept,
    method: {
      spikeMinute: `distinct UTC minutes with ≥1 reading at lag p99 ≥ ${SPIKE_THRESHOLD_MS} ms (plan §2 wording)`,
      consecutiveHighPairs: 'adjacent readings both at/above the threshold (the R2/B2 gate view of the same data)',
      heapFloor: 'min sampled heapUsedBytes (production telemetry is sampled, not forced-GC)',
      thresholdSourceMs: SPIKE_THRESHOLD_MS,
    },
    baselineCheck: {
      window: { from: new Date(baselineFrom).toISOString(), to: new Date(baselineTo).toISOString() },
      expectedFromPlan: '17 spike minutes in 22 h (plan §2 A2 row)',
      measured: baseline,
    },
    planBaselineForSideBySide: {
      spikeMinutes: '17 in 22 h (0.77/h), max p99 919 ms (plan §2 A2 row, 2026-09-27/28)',
      heap: 'sampled 88–515 MB (plan §2 A2 row)',
      load: 'mean activeTurns ≤ 0.41 (plan §3 R2 note — light load)',
    },
  };

  writeFileSync(outPath, `${JSON.stringify(result, null, 1)}\n`);
  const mb = (b: number | null): string => (b === null ? 'n/a' : `${(b / 1024 / 1024).toFixed(1)} MB`);
  console.log(JSON.stringify({
    window: result.window.asOf,
    samples: { full: full.sampleCount, afterExcludes: kept.sampleCount },
    fullWindow: {
      spikeMinutes: full.spikeMinutes,
      maxSpikeP99: full.maxSpikeLagP99Ms,
      consecutiveHighPairs: full.consecutiveHighPairs,
      heapFloor: mb(full.heapFloorBytes),
      heapCeiling: mb(full.heapCeilingBytes),
      peakActiveTurns: full.peakActiveTurns,
      meanActiveTurns: full.meanActiveTurns,
    },
    stressExcluded: {
      spikeMinutes: kept.spikeMinutes,
      maxSpikeP99: kept.maxSpikeLagP99Ms,
      heapFloor: mb(kept.heapFloorBytes),
      heapCeiling: mb(kept.heapCeilingBytes),
      peakActiveTurns: kept.peakActiveTurns,
    },
    baselineCheck: {
      samples: baseline.sampleCount,
      spikeMinutes: baseline.spikeMinutes,
      heapFloor: mb(baseline.heapFloorBytes),
      heapCeiling: mb(baseline.heapCeilingBytes),
      expected: '17 spike minutes / 22 h',
    },
    restartsInsideWindow: restarts.length,
    out: outPath,
  }, null, 1));
}

main().catch((error) => {
  console.error('[prod-telemetry] Fatal:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

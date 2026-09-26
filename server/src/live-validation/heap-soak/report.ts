import { parseCsvWithHeader } from './csv.js';
import { computeVerdict, leastSquaresSlope, type LeakVerdict, type SlopePoint, type SlopeResult } from './slope.js';
import { phaseAt, type ScheduleConfig } from './phases.js';
import type { LaneEvent, LaneName } from './types.js';

export interface ReportSampleRow {
  ts: string;
  elapsedMs: number;
  phase: string;
  heapUsedMB: number;
  eventLoopLagMsProxy: number;
  freeDiskGB?: number;
}

export function rowsToSamples(rows: Record<string, string>[]): ReportSampleRow[] {
  return rows
    .map((r) => ({
      ts: r.ts,
      elapsedMs: Number(r.elapsedMs),
      phase: r.phase,
      heapUsedMB: Number(r.heapUsedBytes) / (1024 * 1024),
      eventLoopLagMsProxy: Number(r.eventLoopLagMsProxy),
      freeDiskGB: r.freeDiskGB ? Number(r.freeDiskGB) : undefined,
    }))
    .filter((r) => Number.isFinite(r.elapsedMs) && Number.isFinite(r.heapUsedMB));
}

export function parseSampleCsv(csvContent: string): ReportSampleRow[] {
  const { rows } = parseCsvWithHeader(csvContent);
  return rowsToSamples(rows);
}

export interface PerPhaseSlope {
  phase: string;
  slope: SlopeResult;
}

/** Per-phase slope: split samples by their recorded phase label and fit each independently. */
export function perPhaseSlopes(samples: readonly ReportSampleRow[]): PerPhaseSlope[] {
  const byPhase = new Map<string, SlopePoint[]>();
  for (const s of samples) {
    const arr = byPhase.get(s.phase) ?? [];
    arr.push({ tMs: s.elapsedMs, valueMB: s.heapUsedMB });
    byPhase.set(s.phase, arr);
  }
  return [...byPhase.entries()].map(([phase, points]) => ({ phase, slope: leastSquaresSlope(points) }));
}

/**
 * Whether each idle stretch returns to (approximately) the heap level it
 * started the stretch at, using the ratio of the idle stretch's end/start
 * heapUsedMB against `toleranceRatio` (default 1.05 = within 5%).
 */
export interface IdleReturnCheck {
  startElapsedMs: number;
  endElapsedMs: number;
  startMB: number;
  endMB: number;
  returnedToBaseline: boolean;
}

export function idleReturnToBaseline(
  samples: readonly ReportSampleRow[],
  config: ScheduleConfig,
  toleranceRatio = 1.05,
): IdleReturnCheck[] {
  const sorted = [...samples].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const checks: IdleReturnCheck[] = [];
  let stretchStart: ReportSampleRow | undefined;
  let prevPhase: string | undefined;
  for (const sample of sorted) {
    const phase = phaseAt(sample.elapsedMs, config);
    if (phase === 'idle' && prevPhase !== 'idle') stretchStart = sample;
    if (phase === 'idle' && stretchStart) {
      // Keep extending; finalize when we leave idle or run out of samples.
    }
    if (prevPhase === 'idle' && phase !== 'idle' && stretchStart) {
      checks.push({
        startElapsedMs: stretchStart.elapsedMs,
        endElapsedMs: sample.elapsedMs,
        startMB: stretchStart.heapUsedMB,
        endMB: sample.heapUsedMB,
        returnedToBaseline: sample.heapUsedMB <= stretchStart.heapUsedMB * toleranceRatio,
      });
      stretchStart = undefined;
    }
    prevPhase = phase;
  }
  return checks;
}

export interface LaneStats {
  lane: LaneName;
  successes: number;
  failures: number;
  timeouts: number;
  circuitOpens: number;
  childrenCreated: number;
  childrenDeleted: number;
  orphansSwept: number;
  toppedUp: number;
}

export function computeLaneStats(events: readonly LaneEvent[]): LaneStats[] {
  const byLane = new Map<LaneName, LaneStats>();
  const get = (lane: LaneName): LaneStats => {
    let s = byLane.get(lane);
    if (!s) {
      s = { lane, successes: 0, failures: 0, timeouts: 0, circuitOpens: 0, childrenCreated: 0, childrenDeleted: 0, orphansSwept: 0, toppedUp: 0 };
      byLane.set(lane, s);
    }
    return s;
  };
  for (const e of events) {
    const s = get(e.lane as LaneName);
    switch (e.kind) {
      case 'child_created': s.childrenCreated += 1; break;
      case 'child_deleted': s.childrenDeleted += 1; break;
      case 'child_failed': s.failures += 1; break;
      case 'child_timeout': s.timeouts += 1; break;
      case 'child_tool_call_seen': s.successes += 1; break;
      case 'circuit_open': s.circuitOpens += 1; break;
      case 'orphan_swept': s.orphansSwept += 1; break;
      case 'top_up': s.toppedUp += 1; break;
      default: break;
    }
  }
  return [...byLane.values()];
}

export interface HeapSoakReport {
  sampleCount: number;
  peakHeapMB: number;
  overallSlope: SlopeResult;
  trailingSlope: SlopeResult;
  verdict: LeakVerdict;
  perPhase: PerPhaseSlope[];
  idleReturns: IdleReturnCheck[];
  lagStats: { meanMs: number; p95Ms: number; maxMs: number };
  laneStats: LaneStats[];
  orphanCount: number;
  generatedFrom: { csvRows: number; eventRows: number };
  /** The backbone (load-bearing) lane name, e.g. 'A'. Verdict/slope never depend on any other lane. */
  backboneLane: LaneName;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

export function buildReport(
  samples: readonly ReportSampleRow[],
  events: readonly LaneEvent[],
  config: ScheduleConfig,
  backboneLane: LaneName = 'A',
): HeapSoakReport {
  const points: SlopePoint[] = samples.map((s) => ({ tMs: s.elapsedMs, valueMB: s.heapUsedMB }));
  const { verdict, overall, trailing } = computeVerdict(points);
  const lags = samples.map((s) => s.eventLoopLagMsProxy).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const laneStats = computeLaneStats(events);
  return {
    sampleCount: samples.length,
    peakHeapMB: samples.reduce((max, s) => Math.max(max, s.heapUsedMB), 0),
    overallSlope: overall,
    trailingSlope: trailing,
    verdict,
    perPhase: perPhaseSlopes(samples),
    idleReturns: idleReturnToBaseline(samples, config),
    lagStats: {
      meanMs: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0,
      p95Ms: percentile(lags, 0.95),
      maxMs: lags.length ? lags[lags.length - 1] : 0,
    },
    laneStats,
    orphanCount: events.filter((e) => e.kind === 'orphan_swept').length,
    generatedFrom: { csvRows: samples.length, eventRows: events.length },
    backboneLane,
  };
}

export function renderReportMarkdown(report: HeapSoakReport, runId: string): string {
  const lines: string[] = [];
  lines.push(`# Heap soak report — ${runId}`);
  lines.push('');
  lines.push(`**Verdict: ${report.verdict.toUpperCase()}** — trailing slope ${report.trailingSlope.slopeMBPerHour.toFixed(2)} MB/h `
    + `(overall ${report.overallSlope.slopeMBPerHour.toFixed(2)} MB/h), ${report.sampleCount} samples, peak heap ${report.peakHeapMB.toFixed(1)} MB.`);
  lines.push('');
  lines.push('## Per-phase slope (MB/h)');
  for (const p of report.perPhase) {
    lines.push(`- ${p.phase}: ${p.slope.slopeMBPerHour.toFixed(2)} MB/h (n=${p.slope.sampleCount}, r2=${Number.isFinite(p.slope.r2) ? p.slope.r2.toFixed(2) : 'n/a'})`);
  }
  lines.push('');
  lines.push('## Idle stretches returning to baseline');
  for (const c of report.idleReturns) {
    lines.push(`- [${c.startElapsedMs}ms→${c.endElapsedMs}ms] ${c.startMB.toFixed(1)}→${c.endMB.toFixed(1)} MB: ${c.returnedToBaseline ? 'yes' : 'NO'}`);
  }
  lines.push('');
  lines.push('## Event-loop lag (CDP round-trip proxy)');
  lines.push(`mean=${report.lagStats.meanMs.toFixed(1)}ms p95=${report.lagStats.p95Ms.toFixed(1)}ms max=${report.lagStats.maxMs.toFixed(1)}ms`);
  lines.push('');
  lines.push('## Lane health');
  lines.push(`Backbone (load-bearing) lane: **${report.backboneLane}**. The verdict and heap slope above come only from `
    + 'post-GC heap samples and the load the backbone lane actually delivered (topping up B/C shortfalls); '
    + 'B/C are best-effort free-tier lanes and their failures/timeouts/circuit-opens are recorded below but never gate the verdict.');
  for (const l of report.laneStats) {
    const tag = l.lane === report.backboneLane ? ' (BACKBONE)' : ' (best-effort)';
    lines.push(`- Lane ${l.lane}${tag}: created=${l.childrenCreated} deleted=${l.childrenDeleted} successes=${l.successes} failures=${l.failures} timeouts=${l.timeouts} circuitOpens=${l.circuitOpens} orphansSwept=${l.orphansSwept} toppedUp=${l.toppedUp}`);
  }
  lines.push('');
  lines.push(`Orphans swept overall: ${report.orphanCount}`);
  return lines.join('\n');
}

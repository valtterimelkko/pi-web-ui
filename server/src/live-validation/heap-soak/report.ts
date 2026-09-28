import { parseCsvWithHeader } from './csv.js';
import { computeVerdict, leastSquaresSlope, type LeakVerdict, type SlopePoint, type SlopeResult, type VerdictRule } from './slope.js';
import { phaseAt, type ScheduleConfig } from './phases.js';
import { sweptChildFailures } from './orphans.js';
import type { BuildRecord } from './build-freshness.js';
import type { RunTerminalState, ServerDeathRecord } from './run-state.js';
import type { LaneEvent, LaneName } from './types.js';

export interface ReportSampleRow {
  ts: string;
  elapsedMs: number;
  phase: string;
  heapUsedMB: number;
  eventLoopLagMsProxy: number;
  freeDiskGB?: number;
  quotaState?: string;
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
      quotaState: r.quotaState || undefined,
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
export interface PerQuotaStateSlope {
  quotaState: string;
  slope: SlopeResult;
}

/**
 * zai quota guard (owner amendment): reduced-load periods (throttled/paused)
 * are labelled phases in the CSV via `quotaState`. Slope is fit independently
 * per state so the heap-vs-uptime question stays answerable even while load
 * is reduced or backbone-paused.
 */
export function perQuotaStateSlopes(samples: readonly ReportSampleRow[]): PerQuotaStateSlope[] {
  const byState = new Map<string, SlopePoint[]>();
  for (const s of samples) {
    const key = s.quotaState ?? 'unknown';
    const arr = byState.get(key) ?? [];
    arr.push({ tMs: s.elapsedMs, valueMB: s.heapUsedMB });
    byState.set(key, arr);
  }
  return [...byState.entries()].map(([quotaState, points]) => ({ quotaState, slope: leastSquaresSlope(points) }));
}

export interface QuotaStateDuration {
  quotaState: string;
  durationMs: number;
}

/** How long the run spent in each quota state, attributing each inter-sample gap to the EARLIER sample's state. */
export function quotaStateDurations(samples: readonly ReportSampleRow[]): QuotaStateDuration[] {
  const sorted = [...samples].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const totals = new Map<string, number>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const key = sorted[i].quotaState ?? 'unknown';
    const delta = sorted[i + 1].elapsedMs - sorted[i].elapsedMs;
    totals.set(key, (totals.get(key) ?? 0) + Math.max(0, delta));
  }
  return [...totals.entries()].map(([quotaState, durationMs]) => ({ quotaState, durationMs }));
}

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

export interface SampleCoverage {
  expectedCount: number;
  actualCount: number;
  coveragePct: number;
  /** Window (ms) coverage is measured against: the full schedule, or the observed window when a run ends early. */
  windowMs: number;
  /** The largest gap between consecutive samples, expressed in units of the expected interval. */
  maxGapIntervals: number;
}

/**
 * Definition-of-victory check (ORCHESTRATION-SCALING-READINESS-PLAN.md A1):
 * "post-GC samples covering at least 95% of sampling intervals, and no gap
 * longer than three intervals except for declared snapshots." Declared
 * snapshot gaps aren't distinguished here (a snapshot briefly blocks the
 * sampler loop); the count/coverage math is intentionally simple and the
 * exception is left to the reader's judgement against the events log.
 */
export function computeSampleCoverage(samples: readonly ReportSampleRow[], sampleIntervalMs: number, totalMs: number): SampleCoverage {
  const expectedCount = sampleIntervalMs > 0 ? Math.floor(totalMs / sampleIntervalMs) + 1 : 0;
  const sorted = [...samples].sort((a, b) => a.elapsedMs - b.elapsedMs);
  let maxGapIntervals = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gap = sorted[i + 1].elapsedMs - sorted[i].elapsedMs;
    if (sampleIntervalMs > 0) maxGapIntervals = Math.max(maxGapIntervals, gap / sampleIntervalMs);
  }
  return {
    expectedCount,
    actualCount: samples.length,
    coveragePct: expectedCount > 0 ? (samples.length / expectedCount) * 100 : 0,
    windowMs: totalMs,
    maxGapIntervals,
  };
}

export interface HeapSoakReport {
  sampleCount: number;
  peakHeapMB: number;
  overallSlope: SlopeResult;
  trailingSlope: SlopeResult;
  verdict: LeakVerdict;
  perPhase: PerPhaseSlope[];
  perQuotaState: PerQuotaStateSlope[];
  quotaStateDurations: QuotaStateDuration[];
  idleReturns: IdleReturnCheck[];
  lagStats: { meanMs: number; p95Ms: number; maxMs: number };
  laneStats: LaneStats[];
  orphanCount: number;
  /**
   * B0.1 defect 4: session ids with both an `orphan_swept` and a later
   * `child_failed` event — the harness counting its own sweep as a child
   * failure. A correct harness reports zero here.
   */
  sweptChildFailures: number;
  generatedFrom: { csvRows: number; eventRows: number };
  /** The backbone (load-bearing) lane name, e.g. 'A'. Verdict/slope never depend on any other lane. */
  backboneLane: LaneName;
  /** The verdict rule this report was judged against — declared/fixed in code, not tuned after seeing the data. */
  verdictRule: VerdictRule;
  sampleCoverage: SampleCoverage;
  /** How the run ended (B0 defect 1): a normal `complete`, or a terminal `server_died`. */
  terminalState: RunTerminalState;
  /** The recorded death evidence when `terminalState === 'server_died'`. */
  serverDeath?: ServerDeathRecord;
  /** B0 defect 6: extension overlay directories applied to the isolated agent dir. */
  extensionsOverlays?: string[];
  /** B0.1 defect 5: the requested `--hours` window for a full run (absent for micro/no explicit window). */
  windowHours?: number;
  /** B0.1 defect 1: the checkout HEAD and the build-freshness check result for the `dist` under test. */
  build?: BuildRecord;
}

/** Optional terminal-state + observed-window input for {@link buildReport}. */
export interface BuildReportOptions {
  terminalState?: RunTerminalState;
  serverDeath?: ServerDeathRecord;
  /** B0 defect 6: overlay source dirs to record in the report. */
  extensionsOverlays?: readonly string[];
  /** B0.1 defect 5: the requested `--hours` window length for a full run. */
  windowHours?: number;
  /** B0.1 defect 1: the checkout/build-freshness record to render at the top of the report. */
  build?: BuildRecord;
  /**
   * The elapsed window the run actually covered. When a server death ends a
   * run early, coverage must be measured against the observed window rather
   * than the full schedule — otherwise a dead run reports a fake 20% coverage
   * that hides the fact the run stopped.
   */
  coveredWindowMs?: number;
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
  options: BuildReportOptions = {},
): HeapSoakReport {
  const points: SlopePoint[] = samples.map((s) => ({ tMs: s.elapsedMs, valueMB: s.heapUsedMB }));
  const { verdict, overall, trailing, rule } = computeVerdict(points);
  const lags = samples.map((s) => s.eventLoopLagMsProxy).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const laneStats = computeLaneStats(events);
  const coveredWindowMs = options.coveredWindowMs ?? config.totalMs;
  return {
    sampleCount: samples.length,
    peakHeapMB: samples.reduce((max, s) => Math.max(max, s.heapUsedMB), 0),
    overallSlope: overall,
    trailingSlope: trailing,
    verdict,
    perPhase: perPhaseSlopes(samples),
    perQuotaState: perQuotaStateSlopes(samples),
    quotaStateDurations: quotaStateDurations(samples),
    idleReturns: idleReturnToBaseline(samples, config),
    lagStats: {
      meanMs: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0,
      p95Ms: percentile(lags, 0.95),
      maxMs: lags.length ? lags[lags.length - 1] : 0,
    },
    laneStats,
    orphanCount: events.filter((e) => e.kind === 'orphan_swept').length,
    sweptChildFailures: sweptChildFailures(events).length,
    generatedFrom: { csvRows: samples.length, eventRows: events.length },
    backboneLane,
    verdictRule: rule,
    sampleCoverage: computeSampleCoverage(samples, config.sampleIntervalMs, coveredWindowMs),
    terminalState: options.terminalState ?? 'complete',
    ...(options.serverDeath ? { serverDeath: options.serverDeath } : {}),
    ...(options.extensionsOverlays && options.extensionsOverlays.length > 0 ? { extensionsOverlays: [...options.extensionsOverlays] } : {}),
    ...(options.windowHours !== undefined ? { windowHours: options.windowHours } : {}),
    ...(options.build ? { build: options.build } : {}),
  };
}

export function renderReportMarkdown(report: HeapSoakReport, runId: string): string {
  const lines: string[] = [];
  lines.push(`# Heap soak report — ${runId}`);
  lines.push('');
  if (report.terminalState === 'server_died' && report.serverDeath) {
    const d = report.serverDeath;
    lines.push(`## ⛔ SERVER DIED — this run did NOT complete`);
    lines.push('');
    lines.push(`The disposable server under test died ${formatElapsedMs(d.elapsedMs)} into the run, at ${d.detectedAt}. ` +
      `The supervisor detected it and ended the run as \`server_died\`; the load driver was stopped. ` +
      `All numbers below cover only the window up to the death and are NOT a 24 h result.`);
    lines.push('');
    lines.push(`- Reason: ${d.reason}`);
    if (d.activeState) lines.push(`- Unit state at detection: ${d.activeState}`);
    if (d.exitStatus) lines.push(`- Unit exit status: ${d.exitStatus}`);
    if (d.journalLines && d.journalLines.length > 0) {
      lines.push('- Last journal lines:');
      lines.push('');
      lines.push('```');
      for (const line of d.journalLines) lines.push(line);
      lines.push('```');
    }
    lines.push('');
  }
  lines.push(`**Verdict: ${report.verdict.toUpperCase()}** — trailing slope ${report.trailingSlope.slopeMBPerHour.toFixed(2)} MB/h `
    + `(overall ${report.overallSlope.slopeMBPerHour.toFixed(2)} MB/h), ${report.sampleCount} samples, peak heap ${report.peakHeapMB.toFixed(1)} MB.`);
  lines.push('');
  if (report.build) {
    const b = report.build;
    lines.push(`**Build:** commit \`${b.headSha ?? 'unknown'}\` — freshness check: ${b.fresh ? 'FRESH' : '**STALE**'} — ${b.reason}`);
    lines.push('');
  }
  if (report.windowHours !== undefined) {
    lines.push(`**Window:** ${report.windowHours} h (requested via \`--hours\`); checkpoints and snapshot offsets scaled to it.`);
    lines.push('');
  }
  if (report.extensionsOverlays && report.extensionsOverlays.length > 0) {
    lines.push(`Extensions overlay (B0): ${report.extensionsOverlays.map((d) => `\`${d}\``).join(', ')}.`);
    lines.push('');
  }
  lines.push(`Verdict rule (declared before the run, not tuned after seeing the data): leak if the trailing `
    + `${report.verdictRule.trailingWindowHours}h post-GC slope exceeds ${report.verdictRule.slopeThresholdMBPerHour} MB/h `
    + `(requires at least ${report.verdictRule.minSpanHoursForVerdict}h of data, else 'inconclusive').`);
  lines.push('');
  lines.push(`## Sample coverage (definition-of-victory check)`);
  lines.push(`${report.sampleCoverage.actualCount}/${report.sampleCoverage.expectedCount} expected samples `
    + `(${report.sampleCoverage.coveragePct.toFixed(1)}%), largest gap ${report.sampleCoverage.maxGapIntervals.toFixed(1)} sample intervals `
    + `(target: >=95% coverage, no gap >3 intervals except a declared snapshot).`);
  if (report.terminalState === 'server_died') {
    lines.push('');
    lines.push(`Coverage is measured against the observed window (${formatElapsedMs(report.sampleCoverage.windowMs)}), not the unrun schedule — the server died.`);
  }
  lines.push('');
  lines.push('## Per-phase slope (MB/h)');
  for (const p of report.perPhase) {
    lines.push(`- ${p.phase}: ${p.slope.slopeMBPerHour.toFixed(2)} MB/h (n=${p.slope.sampleCount}, r2=${Number.isFinite(p.slope.r2) ? p.slope.r2.toFixed(2) : 'n/a'})`);
  }
  lines.push('');
  lines.push('## zai quota guard — per-state slope and duration');
  lines.push('The heap-vs-uptime question stays answerable when load drops (throttled/paused); slope is fit independently per state.');
  const durationByState = Object.fromEntries(report.quotaStateDurations.map((d) => [d.quotaState, d.durationMs]));
  for (const p of report.perQuotaState) {
    const durationMin = ((durationByState[p.quotaState] ?? 0) / 60_000).toFixed(1);
    lines.push(`- ${p.quotaState}: ${p.slope.slopeMBPerHour.toFixed(2)} MB/h (n=${p.slope.sampleCount}), duration ${durationMin} min`);
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
  lines.push(`Swept children mis-counted as child failures: ${report.sweptChildFailures}`);
  return lines.join('\n');
}

/** Human-readable elapsed duration for the report header (e.g. "5 h 03 min"). */
export function formatElapsedMs(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${String(minutes).padStart(2, '0')} min` : `${minutes} min`;
}

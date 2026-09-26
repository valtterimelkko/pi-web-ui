import { describe, expect, it } from 'vitest';
import {
  buildReport,
  computeLaneStats,
  idleReturnToBaseline,
  parseSampleCsv,
  perPhaseSlopes,
  renderReportMarkdown,
  rowsToSamples,
  type ReportSampleRow,
} from '../../../src/live-validation/heap-soak/report.js';
import { formatCsvHeader, formatCsvRow } from '../../../src/live-validation/heap-soak/csv.js';
import { HEAP_SAMPLE_CSV_HEADER, type LaneEvent } from '../../../src/live-validation/heap-soak/types.js';
import { MICRO_SCHEDULE } from '../../../src/live-validation/heap-soak/phases.js';

function csvOf(rows: Record<string, string | number>[]): string {
  return [formatCsvHeader(HEAP_SAMPLE_CSV_HEADER), ...rows.map((r) => formatCsvRow(HEAP_SAMPLE_CSV_HEADER, r))].join('\n') + '\n';
}

describe('parseSampleCsv / rowsToSamples', () => {
  it('parses heapUsedBytes into MB and drops unparseable rows', () => {
    const csv = csvOf([
      { ts: 't0', elapsedMs: 0, phase: 'wave', heapUsedBytes: 100 * 1024 * 1024, heapTotalBytes: 0, rssBytes: 0, externalBytes: 0, arrayBuffersBytes: 0, eventLoopLagMsProxy: 5 },
    ]);
    const samples = parseSampleCsv(csv);
    expect(samples).toHaveLength(1);
    expect(samples[0].heapUsedMB).toBeCloseTo(100, 6);
  });

  it('rowsToSamples filters rows with non-numeric elapsedMs/heapUsedBytes', () => {
    const rows = [{ ts: 't', elapsedMs: 'nope', phase: 'wave', heapUsedBytes: '100', eventLoopLagMsProxy: '1' }];
    expect(rowsToSamples(rows as unknown as Record<string, string>[])).toEqual([]);
  });
});

describe('perPhaseSlopes', () => {
  it('fits an independent slope per phase label', () => {
    const samples: ReportSampleRow[] = [
      { ts: '', elapsedMs: 0, phase: 'wave', heapUsedMB: 100, eventLoopLagMsProxy: 1 },
      { ts: '', elapsedMs: 3_600_000, phase: 'wave', heapUsedMB: 110, eventLoopLagMsProxy: 1 },
      { ts: '', elapsedMs: 7_200_000, phase: 'idle', heapUsedMB: 105, eventLoopLagMsProxy: 1 },
      { ts: '', elapsedMs: 10_800_000, phase: 'idle', heapUsedMB: 105, eventLoopLagMsProxy: 1 },
    ];
    const byPhase = Object.fromEntries(perPhaseSlopes(samples).map((p) => [p.phase, p.slope]));
    expect(byPhase.wave.slopeMBPerHour).toBeCloseTo(10, 3);
    expect(byPhase.idle.slopeMBPerHour).toBeCloseTo(0, 3);
  });
});

describe('idleReturnToBaseline', () => {
  it('flags an idle stretch that returns to (near) its starting heap level', () => {
    const samples: ReportSampleRow[] = [
      { ts: '', elapsedMs: 0, phase: '', heapUsedMB: 100, eventLoopLagMsProxy: 1 },
      { ts: '', elapsedMs: MICRO_SCHEDULE.waveMs, phase: '', heapUsedMB: 120, eventLoopLagMsProxy: 1 }, // idle start
      { ts: '', elapsedMs: MICRO_SCHEDULE.waveMs + MICRO_SCHEDULE.idleMs, phase: '', heapUsedMB: 121, eventLoopLagMsProxy: 1 }, // next wave start (idle end)
    ];
    const checks = idleReturnToBaseline(samples, MICRO_SCHEDULE);
    expect(checks).toHaveLength(1);
    expect(checks[0].returnedToBaseline).toBe(true);
  });

  it('flags a stretch that does NOT return to baseline', () => {
    const samples: ReportSampleRow[] = [
      { ts: '', elapsedMs: 0, phase: '', heapUsedMB: 100, eventLoopLagMsProxy: 1 },
      { ts: '', elapsedMs: MICRO_SCHEDULE.waveMs, phase: '', heapUsedMB: 120, eventLoopLagMsProxy: 1 },
      { ts: '', elapsedMs: MICRO_SCHEDULE.waveMs + MICRO_SCHEDULE.idleMs, phase: '', heapUsedMB: 200, eventLoopLagMsProxy: 1 },
    ];
    const checks = idleReturnToBaseline(samples, MICRO_SCHEDULE);
    expect(checks[0].returnedToBaseline).toBe(false);
  });
});

describe('computeLaneStats', () => {
  it('tallies events per lane', () => {
    const events: LaneEvent[] = [
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'child_created' },
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'child_tool_call_seen' },
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'child_deleted' },
      { ts: '', elapsedMs: 0, lane: 'B', kind: 'child_failed' },
      { ts: '', elapsedMs: 0, lane: 'B', kind: 'circuit_open' },
      { ts: '', elapsedMs: 0, lane: 'B', kind: 'orphan_swept' },
      { ts: '', elapsedMs: 0, lane: 'A', kind: 'top_up' },
      { ts: '', elapsedMs: 0, lane: 'B', kind: 'child_timeout' },
    ];
    const stats = Object.fromEntries(computeLaneStats(events).map((s) => [s.lane, s]));
    expect(stats.A).toMatchObject({ childrenCreated: 1, successes: 1, childrenDeleted: 1, toppedUp: 1 });
    expect(stats.B).toMatchObject({ failures: 1, circuitOpens: 1, orphansSwept: 1, timeouts: 1 });
  });
});

describe('buildReport / renderReportMarkdown', () => {
  it('produces a verdict line and renders markdown without throwing', () => {
    const samples: ReportSampleRow[] = Array.from({ length: 5 }, (_, i) => ({
      ts: '', elapsedMs: i * 3_600_000, phase: i % 2 === 0 ? 'wave' : 'idle', heapUsedMB: 100 + i * 2, eventLoopLagMsProxy: 3 + i,
    }));
    const events: LaneEvent[] = [{ ts: '', elapsedMs: 0, lane: 'A', kind: 'child_created' }];
    const report = buildReport(samples, events, MICRO_SCHEDULE);
    expect(['leak', 'stable', 'inconclusive']).toContain(report.verdict);
    expect(report.peakHeapMB).toBeCloseTo(108, 6);
    const markdown = renderReportMarkdown(report, 'run-1');
    expect(markdown).toContain('Verdict:');
    expect(markdown).toContain('run-1');
    expect(report.backboneLane).toBe('A');
    expect(markdown).toMatch(/Backbone \(load-bearing\) lane: \*\*A\*\*/);
  });
});

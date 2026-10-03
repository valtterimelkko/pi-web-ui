/**
 * E2a-4 harness analysis tests: A2 telemetry parsing, the B2 lag-gate latch
 * model, pi-orch retry derivation and the arm-A answer synthesis.
 *
 * The latch model mirrors `server/src/internal-api/admission-controller.ts`
 * (B2): latch when `sustainedReadings` consecutive p99 readings are
 * >= thresholdMs; release only on a reading strictly below recoveryMs;
 * readings with no samples are ignored; a sub-threshold (but not recovering)
 * reading neither extends the high streak nor releases a latch.
 */
import { describe, expect, it } from 'vitest';
import { parseA2Line, parseA2Jsonl, summariseA2 } from '../lib/a2.ts';
import { computeLatchWindows, deriveRetry, RETRY_WAIT_FLOOR_MS } from '../lib/latch.ts';
import { analyseArmA } from '../lib/analyze.ts';
import type { CreateRecord } from '../lib/types.ts';

const CFG = { thresholdMs: 300, recoveryMs: 150, sustainedReadings: 2 };

describe('a2 parsing', () => {
  it('parses a production-shaped health-metrics line', () => {
    const line = JSON.stringify({
      atMs: 1759459200000, lagP50Ms: 1, lagP99Ms: 320.5, lagMaxMs: 640,
      activeTurns: 3, heapUsedBytes: 200_000_000, heapLimitBytes: 4_496_293_888,
      mainThreadCpuPercentOfCore: 41.2, toolsSliceMemoryBytes: 434_417_664,
    });
    const s = parseA2Line(line);
    expect(s).not.toBeNull();
    expect(s?.atMs).toBe(1759459200000);
    expect(s?.lagP99Ms).toBeCloseTo(320.5);
    expect(s?.activeTurns).toBe(3);
    expect(s?.heapUsedBytes).toBe(200_000_000);
    expect(s?.mainThreadCpuPercentOfCore).toBeCloseTo(41.2);
  });

  it('derives atMs from an ISO `at` field when atMs is absent', () => {
    const s = parseA2Line(JSON.stringify({ at: '2026-10-03T01:00:00.000Z', lagP99Ms: 10 }));
    expect(s?.atMs).toBe(Date.parse('2026-10-03T01:00:00.000Z'));
  });

  it('returns null for junk lines and keeps parsing neighbours', () => {
    const samples = parseA2Jsonl('garbage\n\n{"atMs": 1, "lagP99Ms": 5}\n{"partial":');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.atMs).toBe(1);
  });

  it('summarises a window', () => {
    const samples = [
      { atMs: 1000, lagP50Ms: 1, lagP99Ms: 100, lagMaxMs: 200, activeTurns: 1, heapUsedBytes: 10, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 5, toolsSliceMemoryBytes: null },
      { atMs: 2000, lagP50Ms: 2, lagP99Ms: 400, lagMaxMs: 800, activeTurns: 4, heapUsedBytes: 30, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 60, toolsSliceMemoryBytes: null },
      { atMs: 3000, lagP50Ms: 1, lagP99Ms: 90, lagMaxMs: 120, activeTurns: 2, heapUsedBytes: 20, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 6, toolsSliceMemoryBytes: null },
    ];
    const sum = summariseA2(samples, 1500, 2500);
    expect(sum.count).toBe(1);
    expect(sum.lagP99MaxMs).toBe(400);
    expect(sum.lagMaxMs).toBe(800);
    expect(sum.maxActiveTurns).toBe(4);
    expect(sum.heapUsedMaxBytes).toBe(30);
    expect(sum.mainThreadCpuMaxPercentOfCore).toBeCloseTo(60);
  });
});

describe('latch windows (B2 semantics)', () => {
  it('does not latch on a single high reading', () => {
    const w = computeLatchWindows(
      [ { atMs: 1000, p99Ms: 320 }, { atMs: 2000, p99Ms: 100 } ], CFG,
    );
    expect(w).toHaveLength(0);
  });

  it('latches on the second consecutive high reading and releases below recovery', () => {
    const w = computeLatchWindows(
      [
        { atMs: 1000, p99Ms: 320 },
        { atMs: 2000, p99Ms: 340 },
        { atMs: 3000, p99Ms: 200 }, // between recovery and threshold: neither
        { atMs: 4000, p99Ms: 100 }, // release
      ],
      CFG,
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.latchedAtMs).toBe(2000);
    expect(w[0]?.releasedAtMs).toBe(4000);
    expect(w[0]?.open).toBe(false);
    expect(w[0]?.peakP99Ms).toBeCloseTo(340);
  });

  it('a sub-threshold reading breaks the consecutive streak without releasing', () => {
    const w = computeLatchWindows(
      [
        { atMs: 1000, p99Ms: 320 },
        { atMs: 2000, p99Ms: 200 }, // breaks the streak (not high, not recovery)
        { atMs: 3000, p99Ms: 320 }, // streak restarts at 1 — not latched yet
        { atMs: 4000, p99Ms: 100 },
      ],
      CFG,
    );
    expect(w).toHaveLength(0);
  });

  it('ignores readings without samples (null p99)', () => {
    const w = computeLatchWindows(
      [ { atMs: 1000, p99Ms: 320 }, { atMs: 2000, p99Ms: null }, { atMs: 3000, p99Ms: 340 } ], CFG,
    );
    // The null reading is invisible: 1000 and 3000 are consecutive *counted* readings.
    expect(w).toHaveLength(1);
    expect(w[0]?.latchedAtMs).toBe(3000);
    expect(w[0]?.open).toBe(true);
  });

  it('keeps a second window separate from the first', () => {
    const w = computeLatchWindows(
      [
        { atMs: 1000, p99Ms: 320 }, { atMs: 2000, p99Ms: 350 }, { atMs: 3000, p99Ms: 100 },
        { atMs: 10_000, p99Ms: 320 }, { atMs: 11_000, p99Ms: 350 }, { atMs: 12_000, p99Ms: 100 },
      ],
      CFG,
    );
    expect(w).toHaveLength(2);
    expect(w[0]?.latchedAtMs).toBe(2000);
    expect(w[1]?.latchedAtMs).toBe(11_000);
  });
});

describe('pi-orch retry derivation', () => {
  it('calls a fast successful create un-retried', () => {
    expect(deriveRetry({ exitCode: 0, ok: true, wallMs: 2500 })).toBe('no');
  });

  it('derives a retry from a successful create that waited at least one Retry-After', () => {
    expect(deriveRetry({ exitCode: 0, ok: true, wallMs: RETRY_WAIT_FLOOR_MS + 1 })).toBe('derived-yes');
    expect(deriveRetry({ exitCode: 0, ok: true, wallMs: RETRY_WAIT_FLOOR_MS - 1 })).toBe('no');
  });

  it('calls exit 10 a budget-exhausted refusal', () => {
    expect(deriveRetry({ exitCode: 10, ok: false, wallMs: 150_000 })).toBe('derived-budget-exhausted');
  });

  it('marks anything else unknown', () => {
    expect(deriveRetry({ exitCode: 1, ok: false, wallMs: 100 })).toBe('unknown');
  });
});

const mkCreate = (over: Partial<CreateRecord> & Pick<CreateRecord, 'step' | 'index' | 'startedAtMs' | 'endedAtMs'>): CreateRecord => ({
  child: `child-${over.index}`, wallMs: over.endedAtMs - over.startedAtMs, exitCode: 0, ok: true, retried: 'no' as const, ...over,
});

describe('arm-A answer synthesis', () => {
  it('reports no latch and no refusals on a quiet run', () => {
    const a2 = [
      { atMs: 1000, lagP50Ms: 1, lagP99Ms: 90, lagMaxMs: 120, activeTurns: 0, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 2, toolsSliceMemoryBytes: null },
    ];
    const out = analyseArmA({
      creates: [mkCreate({ step: 'pass1', index: 0, startedAtMs: 500, endedAtMs: 2500 })],
      a2, capacity: [], window: { fromMs: 0, toMs: 5000 }, cfg: CFG,
    });
    expect(out.gateLatched).toBe(false);
    expect(out.refused).toHaveLength(0);
    expect(out.latchRefusedOwnChildren).toBe(0);
    expect(out.documentedBehaviour).toBe(true);
  });

  it('counts refusals inside the latch window as the gate refusing the parent’s own children', () => {
    const a2 = [
      { atMs: 1000, lagP50Ms: 1, lagP99Ms: 320, lagMaxMs: 400, activeTurns: 2, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 40, toolsSliceMemoryBytes: null },
      { atMs: 2000, lagP50Ms: 1, lagP99Ms: 350, lagMaxMs: 500, activeTurns: 2, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 50, toolsSliceMemoryBytes: null },
      { atMs: 3000, lagP50Ms: 1, lagP99Ms: 100, lagMaxMs: 120, activeTurns: 0, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 3, toolsSliceMemoryBytes: null },
    ];
    const creates = [
      mkCreate({ step: 'pass2', index: 3, startedAtMs: 2100, endedAtMs: 2300, exitCode: 10, ok: false, errorCode: 'ADMISSION_CAPACITY_EXHAUSTED', reason: 'event_loop_lag', status: 503, retryAfterSeconds: 30 }),
      mkCreate({ step: 'pass2', index: 4, startedAtMs: 3200, endedAtMs: 4000, exitCode: 0, ok: true, retried: 'derived-yes' }),
    ];
    const out = analyseArmA({ creates, a2, capacity: [], window: { fromMs: 0, toMs: 6000 }, cfg: CFG });
    expect(out.gateLatched).toBe(true);
    expect(out.windows).toHaveLength(1);
    expect(out.refused).toHaveLength(1);
    expect(out.latchRefusedOwnChildren).toBe(1);
    expect(out.refused[0]?.step).toBe('pass2');
    expect(out.refused[0]?.index).toBe(3);
    expect(out.eventuallySucceeded).toBe(1);
    expect(out.documentedBehaviour).toBe(true);
  });

  it('does not attribute a refusal outside every latch window to the gate', () => {
    const a2 = [
      { atMs: 1000, lagP50Ms: 1, lagP99Ms: 320, lagMaxMs: 400, activeTurns: 2, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 40, toolsSliceMemoryBytes: null },
      { atMs: 2000, lagP50Ms: 1, lagP99Ms: 350, lagMaxMs: 500, activeTurns: 2, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 50, toolsSliceMemoryBytes: null },
      { atMs: 3000, lagP50Ms: 1, lagP99Ms: 100, lagMaxMs: 120, activeTurns: 0, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 3, toolsSliceMemoryBytes: null },
    ];
    const creates = [
      // Refusal long after the window closed: not the lag gate (some other refusal).
      mkCreate({ step: 'pass1', index: 0, startedAtMs: 50_000, endedAtMs: 50_100, exitCode: 25, ok: false, errorCode: 'ROUTE_LIMIT', status: undefined }),
    ];
    const out = analyseArmA({ creates, a2, capacity: [], window: { fromMs: 0, toMs: 60_000 }, cfg: CFG });
    expect(out.gateLatched).toBe(true);
    expect(out.refused).toHaveLength(1);
    expect(out.latchRefusedOwnChildren).toBe(0);
    expect(out.notes.join(' ')).toMatch(/outside/);
  });

  it('flags undocumented refusal shapes (no Retry-After, wrong exit code)', () => {
    const a2 = [
      { atMs: 1000, lagP50Ms: 1, lagP99Ms: 320, lagMaxMs: 400, activeTurns: 2, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 40, toolsSliceMemoryBytes: null },
      { atMs: 2000, lagP50Ms: 1, lagP99Ms: 350, lagMaxMs: 500, activeTurns: 2, heapUsedBytes: 1, heapLimitBytes: 100, mainThreadCpuPercentOfCore: 50, toolsSliceMemoryBytes: null },
    ];
    const creates = [
      mkCreate({ step: 'pass1', index: 0, startedAtMs: 1500, endedAtMs: 1600, exitCode: 1, ok: false, errorCode: 'SOMETHING_ELSE' }),
    ];
    const out = analyseArmA({ creates, a2, capacity: [], window: { fromMs: 0, toMs: 5000 }, cfg: CFG });
    expect(out.refused).toHaveLength(1);
    expect(out.documentedBehaviour).toBe(false);
  });
});

/** Shared types for the E2a-4 fan-out harness. */

/** One A2 health-telemetry reading (server health-metrics.jsonl line). */
export interface A2Sample {
  atMs: number;
  lagP50Ms: number | null;
  lagP99Ms: number | null;
  lagMaxMs: number | null;
  activeTurns: number | null;
  heapUsedBytes: number | null;
  heapLimitBytes: number | null;
  mainThreadCpuPercentOfCore: number | null;
  toolsSliceMemoryBytes: number | null;
}

/** One GET /api/v1/capacity sample. */
export interface CapacitySample {
  atMs: number;
  available: boolean | null;
  reason: string | null;
  activeTurns: number | null;
  maxActiveTurns: number | null;
  lagPressure: boolean | null;
  lagConsecutiveHigh: number | null;
  lagLastP99Ms: number | null;
  lagTelemetryAvailable: boolean | null;
  heapPressure: boolean | null;
  heapProjectedBytes: number | null;
  memCurrentBytes: number | null;
  toolsMemCurrentBytes: number | null;
  retryAfterSeconds: number | null;
}

/** Per-create record for one pi-orch spawn (one POST /sessions through the parent pattern). */
export interface CreateRecord {
  step: 'pass1' | 'pass2' | 'armb';
  index: number;
  child: string;
  startedAtMs: number;
  endedAtMs: number;
  wallMs: number;
  exitCode: number | null;
  ok: boolean;
  sessionId?: string;
  errorCode?: string;
  reason?: string;
  status?: number;
  retryAfterSeconds?: number;
  retried: 'no' | 'derived-yes' | 'derived-budget-exhausted' | 'unknown';
  stderrTail?: string;
}

/** One B2-shaped lag latch window. */
export interface LatchWindow {
  latchedAtMs: number;
  releasedAtMs: number | null;
  open: boolean;
  peakP99Ms: number;
}

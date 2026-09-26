/**
 * Shared types for the 24-hour heap soak-test harness (scripts/heap-soak/).
 *
 * Pure logic lives under server/src/live-validation/heap-soak/ so it is
 * covered by the `server` workspace's vitest suite; scripts/heap-soak/ wires
 * this logic to real I/O (systemd, CDP inspector, the Internal API socket)
 * and is proven by the Gate 0 / Gate 1 live gates instead of unit tests.
 */

export interface HeapSample {
  /** ISO timestamp of the sample. */
  ts: string;
  /** Milliseconds since the run started. */
  elapsedMs: number;
  /** Current schedule phase name (e.g. "wave", "idle"). */
  phase: string;
  /** Post-forced-GC process.memoryUsage().heapUsed, in bytes. */
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** CDP round-trip time in ms, used as an event-loop-lag PROXY (labelled). */
  eventLoopLagMsProxy: number;
  activeTurns?: number;
  stalledRuns?: number;
  residentSessionCount?: number;
  registryEntryCount?: number;
  /** Free disk space on the artefact volume, in GB, at sample time. */
  freeDiskGB?: number;
}

export const HEAP_SAMPLE_CSV_HEADER = [
  'ts',
  'elapsedMs',
  'phase',
  'heapUsedBytes',
  'heapTotalBytes',
  'rssBytes',
  'externalBytes',
  'arrayBuffersBytes',
  'eventLoopLagMsProxy',
  'activeTurns',
  'stalledRuns',
  'residentSessionCount',
  'registryEntryCount',
  'freeDiskGB',
] as const;

export type HeapSampleField = (typeof HEAP_SAMPLE_CSV_HEADER)[number];

export type LaneEventKind =
  | 'child_created'
  | 'child_prompted'
  | 'child_tool_call_seen'
  | 'child_deleted'
  | 'child_failed'
  | 'child_timeout'
  | 'circuit_open'
  | 'circuit_close'
  | 'orphan_swept'
  | 'top_up'
  | 'checkpoint'
  | 'anomaly';

export interface LaneEvent {
  ts: string;
  elapsedMs: number;
  lane: string;
  kind: LaneEventKind;
  detail?: string;
  sessionId?: string;
}

export type LaneName = 'A' | 'B' | 'C';

export interface LaneDefinition {
  name: LaneName;
  label: string;
  weight: number;
  runtime: 'pi';
  /** Ordered model ids to try; the first is primary, the rest are fallbacks. */
  modelIds: string[];
  thinkingLevel?: string;
  enabled: boolean;
  disabledReason?: string;
  /**
   * The backbone lane (owner amendment 2026-09-26): free-tier lanes B/C are
   * congested and slow/erroring in practice, so the load target (completed
   * children per wave) must never depend on them. Only the backbone lane's
   * failure counts as the "all lanes down" anomaly; a non-backbone lane's
   * failures/circuit-opens/timeouts are logged and counted, never paged.
   */
  isBackbone: boolean;
  /**
   * Cap on concurrent in-flight children for this lane, so a slow free model
   * cannot pile up resident sessions without bound. The backbone lane's cap
   * can be higher since it is expected to carry top-up load.
   */
  maxConcurrent: number;
}

/** Config for the wave/top-up scheduling amendment. */
export interface WaveTargetConfig {
  /** Target number of successfully-completed children per wave. */
  targetPerWave: number;
  /** Hard per-turn deadline: a child not done by this age is aborted+deleted and counted as a lane timeout. */
  childTurnDeadlineMs: number;
}

export const DEFAULT_WAVE_TARGET_CONFIG: WaveTargetConfig = {
  targetPerWave: 4,
  childTurnDeadlineMs: 90_000,
};

export interface CircuitBreakerState {
  lane: LaneName;
  consecutiveFailures: number;
  open: boolean;
  openedAtMs?: number;
  cooldownUntilMs?: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface CircuitBreakerConfig {
  /** Consecutive failures before the breaker opens. */
  failureThreshold: number;
  /** How long the breaker stays open before it is eligible to half-open. */
  cooldownMs: number;
}

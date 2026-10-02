import type { HealthReadings } from './health-readings.js';

/**
 * A2 alerts: heap and event-loop health with hysteresis, so a reading that
 * oscillates around a threshold produces one alert and one recovery rather
 * than a message per sample.
 */

export type HealthAlertKind = 'heap_pressure' | 'event_loop_lag' | 'turn_count_mismatch';
export type HealthAlertTransition = 'alert' | 'recovery';

export interface HealthAlertThresholds {
  /** Heap fraction of the real `heap_size_limit` that arms the alert. */
  heapFractionHigh: number;
  /** Heap fraction that clears it (must be below the high water mark). */
  heapFractionLow: number;
  /** Lag p99 (ms) that arms the alert. */
  lagP99HighMs: number;
  /** Lag p99 (ms) that clears it. */
  lagP99LowMs: number;
  /**
   * J3: consecutive readings with admission holding more active turns than the
   * runtime telemetry before the turn-count-mismatch alert arms. Defaults to
   * 3 (~90 s at the 30 s sampler interval): turn-boundary races span at most
   * one reading, and the §11 quarantine fence holds a lease at most 30 s past
   * a cancel/fail, so only a genuine stuck permit sustains three.
   */
  turnCountMismatchAlertReadings?: number;
  /** J3: consecutive agreeing readings that clear it (default 2). */
  turnCountMismatchRecoveryReadings?: number;
}

export const DEFAULT_TURN_MISMATCH_ALERT_READINGS = 3;
export const DEFAULT_TURN_MISMATCH_RECOVERY_READINGS = 2;
/**
 * J3 (correction 02): the grouper value a reverse reading maps to — strictly
 * inside the dead band `(0, 1)` so it neither opens an incident (≥ high 1)
 * nor starts the close quiet clock (≤ low 0).
 */
export const J3_MISMATCH_REVERSE_BAND = 0.5;

export interface HealthAlert {
  kind: HealthAlertKind;
  transition: HealthAlertTransition;
  at: string;
  /** The reading that triggered the transition: heap fraction or lag p99 ms. */
  value: number;
  /** The threshold it crossed: `heapFractionHigh/Low` or `lagP99HighMs/LowMs`. */
  threshold: number;
  message: string;
  /**
   * Incident grouping (L1). Present on the one alert message that opens an
   * incident and on the one recovered message that closes it; `endedAt` and
   * `durationMs` are only set on the recovered message.
   */
  incident?: HealthIncidentSummary;
}

/**
 * Incident-grouping pacing (L1). The hysteresis latches keep every raw
 * transition exactly as before; the grouper folds them into one alert message
 * when an incident opens and one recovered message when it closes.
 */
export interface HealthIncidentConfig {
  /** The metric must stay at or below its recovery threshold this long before an incident may close. */
  quietPeriodMs: number;
  /**
   * After an incident closes, a new alert is suppressed for this long (same
   * kind only), measured from the new excursion's first crossing — not from the
   * reading that completed its debounce.
   */
  cooldownMs: number;
  /**
   * Consecutive readings at or above the high water mark before an incident
   * opens; a single spike never pages. A reading below the high mark breaks the
   * run. The pending window (start, peak, raw-crossing count) survives a
   * dead-band reading until a genuine recovery at or below the recovery
   * threshold, so a briefly interrupted excursion is still summarised whole.
   */
  debounceReadings: number;
  /**
   * J3: per-kind debounce override. The turn-count mismatch defaults to the
   * evaluator's own N (turnCountMismatchAlertReadings), so both layers require
   * the same consecutive run: the operator alert fires exactly at the Nth
   * disagreeing reading, and a lone boundary-race reading after a close can
   * never open a new incident on its own.
   */
  debounceReadingsByKind?: Partial<Record<HealthAlertKind, number>>;
}

export const DEFAULT_HEALTH_INCIDENT_QUIET_PERIOD_MS = 10 * 60_000;
export const DEFAULT_HEALTH_INCIDENT_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_HEALTH_INCIDENT_DEBOUNCE_READINGS = 2;

/** The incident's public summary, carried on the grouped notifications. */
export interface HealthIncidentSummary {
  kind: HealthAlertKind;
  startedAt: string;
  /** Set on the recovered notification: when the quiet period completed. */
  endedAt?: string;
  /** Set on the recovered notification: `endedAt - startedAt`. */
  durationMs?: number;
  /** Highest reading observed during the incident, including its debounce lead-in. */
  peakValue: number;
  /** Raw alert crossings folded into this incident (the first crossing counts). */
  alertCrossings: number;
  /** True when the incident reopened inside the cooldown, so its alert was silent. */
  reopenedDuringCooldown: boolean;
}

/** Rejects a grouping configuration that cannot group, before any reading runs. */
export function validateHealthIncidentConfig(config: HealthIncidentConfig): void {
  if (!Number.isFinite(config.quietPeriodMs) || config.quietPeriodMs < 0) {
    throw new Error(`quietPeriodMs must be a non-negative number of milliseconds (got ${config.quietPeriodMs}).`);
  }
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) {
    throw new Error(`cooldownMs must be a non-negative number of milliseconds (got ${config.cooldownMs}).`);
  }
  if (!Number.isSafeInteger(config.debounceReadings) || config.debounceReadings < 1) {
    throw new Error(`debounceReadings must be an integer of at least 1 (got ${config.debounceReadings}).`);
  }
  for (const [kind, debounce] of Object.entries(config.debounceReadingsByKind ?? {})) {
    if (!Number.isSafeInteger(debounce) || (debounce as number) < 1) {
      throw new Error(`debounceReadingsByKind[${kind}] must be an integer of at least 1 (got ${debounce}).`);
    }
  }
}

/** Human-readable incident duration (`29m 29s`, `1h 3m 4s`, `45s`). */
export function formatIncidentDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * Validates the hysteresis band before any reading is evaluated. A high water
 * mark at or below its low water mark would flap on every sample, so it is a
 * configuration error rather than a silently tolerated one.
 */
export function validateHealthAlertThresholds(thresholds: HealthAlertThresholds): void {
  const { heapFractionHigh, heapFractionLow, lagP99HighMs, lagP99LowMs } = thresholds;
  if (!(heapFractionHigh > 0 && heapFractionHigh <= 1)) {
    throw new Error(`heapFractionHigh must be within (0, 1] (got ${heapFractionHigh}).`);
  }
  if (!(heapFractionLow >= 0 && heapFractionLow < heapFractionHigh)) {
    throw new Error(`heapFractionLow must be >= 0 and below heapFractionHigh (got ${heapFractionLow} >= ${heapFractionHigh}).`);
  }
  if (!(lagP99HighMs > 0)) {
    throw new Error(`lagP99HighMs must be a positive number of milliseconds (got ${lagP99HighMs}).`);
  }
  if (!(lagP99LowMs >= 0 && lagP99LowMs < lagP99HighMs)) {
    throw new Error(`lagP99LowMs must be >= 0 and below lagP99HighMs (got ${lagP99LowMs} >= ${lagP99HighMs}).`);
  }
  for (const [name, value] of [
    ['turnCountMismatchAlertReadings', thresholds.turnCountMismatchAlertReadings],
    ['turnCountMismatchRecoveryReadings', thresholds.turnCountMismatchRecoveryReadings],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`${name} must be a positive integer number of consecutive readings (got ${value}).`);
    }
  }
}

/**
 * One metric's two-state latch. Values inside `[low, high)` never change the
 * state — that dead band is the anti-flap rule.
 */
export class HysteresisLatch {
  private alerting = false;

  constructor(
    private readonly name: string,
    private readonly high: number,
    private readonly low: number,
  ) {}

  get armed(): boolean {
    return this.alerting;
  }

  evaluate(value: number): HealthAlertTransition | undefined {
    if (this.alerting) {
      if (value <= this.low) {
        this.alerting = false;
        return 'recovery';
      }
      return undefined;
    }
    if (value >= this.high) {
      this.alerting = true;
      return 'alert';
    }
    return undefined;
  }

  describe(): { alerting: boolean; high: number; low: number; name: string } {
    return { alerting: this.alerting, high: this.high, low: this.low, name: this.name };
  }
}

/**
 * J3: a run-length latch for the turn-count mismatch over the tri-state delta
 * (correction 02). A single disagreeing reading is a turn-boundary race and
 * must never fire, so the alert arms only after `alertReadings` consecutive
 * leak readings (delta > 0), and recovers only after `recoveryReadings`
 * consecutive equal readings (delta === 0). A reverse reading (delta < 0) is
 * neither: it breaks both runs and never opens or closes anything.
 */
export class ConsecutiveReadingsLatch {
  private armedState = false;
  private leakRun = 0;
  private equalRun = 0;

  constructor(
    private readonly name: string,
    private readonly alertReadings: number,
    private readonly recoveryReadings: number,
  ) {}

  get armed(): boolean {
    return this.armedState;
  }

  evaluate(value: number): HealthAlertTransition | undefined {
    if (value < 0) {
      // Reverse: non-alerting, non-recovering — reset both runs.
      this.leakRun = 0;
      this.equalRun = 0;
      return undefined;
    }
    if (this.armedState) {
      if (value === 0) {
        this.equalRun += 1;
        if (this.equalRun >= this.recoveryReadings) {
          this.armedState = false;
          this.equalRun = 0;
          this.leakRun = 0;
          return 'recovery';
        }
        return undefined;
      }
      this.equalRun = 0;
      return undefined;
    }
    if (value > 0) {
      this.leakRun += 1;
      if (this.leakRun >= this.alertReadings) {
        this.armedState = true;
        this.equalRun = 0;
        return 'alert';
      }
      return undefined;
    }
    this.leakRun = 0;
    return undefined;
  }

  describe(): { alerting: boolean; alertReadings: number; recoveryReadings: number; name: string } {
    return { alerting: this.armedState, alertReadings: this.alertReadings, recoveryReadings: this.recoveryReadings, name: this.name };
  }
}

/**
 * J3: the signed admission-vs-telemetry delta in three states (correction 02):
 * `> 0` — leak (admission holds more active turns than the runtime telemetry;
 * the value is the worst positive excess across the total and any per-runtime
 * mismatch), `=== 0` — equal, `< 0` — reverse (telemetry above admission
 * somewhere and no leak anywhere; e.g. receipts joined to another turn's
 * permit — legitimate, never alerting). `undefined` when admission is unwired
 * (the fields are absent), so an unwired sampler never evaluates this alert.
 */
export function turnCountMismatchDelta(readings: HealthReadings): number | undefined {
  const admission = readings.admissionActiveTurns;
  if (admission === undefined || !Number.isFinite(admission)) return undefined;
  const telemetry = readings.activeTurnsByClass ?? {};
  const runtimeTotal = Object.values(telemetry).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const diffs: number[] = [admission - runtimeTotal];
  for (const [runtime, count] of Object.entries(readings.admissionTurnsByRuntime ?? {})) {
    if (!Number.isFinite(count)) continue;
    diffs.push(count - (telemetry[runtime] ?? 0));
  }
  const worstLeak = Math.max(...diffs);
  if (worstLeak > 0) return worstLeak;
  const worstReverse = Math.min(...diffs);
  return worstReverse < 0 ? worstReverse : 0;
}

export interface HealthIncidentGrouperOptions {
  thresholds: HealthAlertThresholds;
  config?: Partial<HealthIncidentConfig>;
}

interface KindIncidentState {
  open: boolean;
  startedAtMs?: number;
  peak: number;
  crossings: number;
  quietSinceMs?: number;
  lastClosedAtMs?: number;
  reopenedDuringCooldown: boolean;
  // The pending (pre-open) window: one un-recovered excursion above the high
  // water mark, with its own start, peak and raw-crossing count, plus the
  // consecutive-high run that decides when it opens.
  pendingStartMs?: number;
  pendingPeak: number;
  pendingHighRun: number;
  pendingCrossings: number;
}

function newKindState(): KindIncidentState {
  return {
    open: false,
    peak: 0,
    crossings: 0,
    reopenedDuringCooldown: false,
    pendingPeak: 0,
    pendingHighRun: 0,
    pendingCrossings: 0,
  };
}

/**
 * Folds the evaluator's raw transitions into one notification per incident.
 *
 * - an incident opens after `debounceReadings` consecutive high readings (the
 *   opening message is the only *alert* the sink sees);
 * - further raw alert crossings while it is open are counted, not delivered;
 * - it closes only after the metric stays at or below its recovery threshold
 *   for the whole quiet period; the single recovered message summarises start,
 *   end, duration, peak and the folded crossing count;
 * - a cooldown after the close suppresses the next alert message; an incident
 *   that reopens inside it is silent and the recovered message says so;
 * - heap and lag keep independent state, so one open incident cannot silence
 *   the other metric's alert.
 *
 * State is in memory only: after a restart, grouping starts fresh (documented).
 */
export class HealthIncidentGrouper {
  private readonly thresholds: HealthAlertThresholds;
  private readonly config: HealthIncidentConfig;
  private readonly heap = newKindState();
  private readonly lag = newKindState();
  private readonly mismatch = newKindState();

  constructor(options: HealthIncidentGrouperOptions) {
    validateHealthAlertThresholds(options.thresholds);
    this.thresholds = options.thresholds;
    this.config = {
      quietPeriodMs: options.config?.quietPeriodMs ?? DEFAULT_HEALTH_INCIDENT_QUIET_PERIOD_MS,
      cooldownMs: options.config?.cooldownMs ?? DEFAULT_HEALTH_INCIDENT_COOLDOWN_MS,
      debounceReadings: options.config?.debounceReadings ?? DEFAULT_HEALTH_INCIDENT_DEBOUNCE_READINGS,
      debounceReadingsByKind: {
        turn_count_mismatch: this.thresholds.turnCountMismatchAlertReadings ?? DEFAULT_TURN_MISMATCH_ALERT_READINGS,
        ...options.config?.debounceReadingsByKind,
      },
    };
    validateHealthIncidentConfig(this.config);
  }

  /** Effective debounce for one kind (per-kind override, else the shared default). */
  private debounceFor(kind: HealthAlertKind): number {
    return this.config.debounceReadingsByKind?.[kind] ?? this.config.debounceReadings;
  }

  /**
   * Consumes one reading and the raw transitions the evaluator produced for it.
   * Returns the 0–3 notifications (one per kind) that should reach the sink.
   */
  observe(readings: HealthReadings, transitions: readonly HealthAlert[] = []): HealthAlert[] {
    const atMs = Number.isFinite(readings.atMs) ? readings.atMs : Date.now();
    const rawAlert = (kind: HealthAlertKind) => transitions.some((entry) => entry.kind === kind && entry.transition === 'alert');
    const notifications: HealthAlert[] = [];
    const heap = this.observeKind('heap_pressure', this.heap, readings.heapFraction, this.thresholds.heapFractionHigh, this.thresholds.heapFractionLow, readings.heapLimitBytes, atMs, rawAlert('heap_pressure'), this.debounceFor('heap_pressure'));
    if (heap) notifications.push(heap);
    const lag = this.observeKind('event_loop_lag', this.lag, readings.lagP99Ms, this.thresholds.lagP99HighMs, this.thresholds.lagP99LowMs, 0, atMs, rawAlert('event_loop_lag'), this.debounceFor('event_loop_lag'));
    if (lag) notifications.push(lag);
    // J3: the mismatch tri-state delta (undefined when admission is unwired).
    // The grouper sees a mapped value: leak → excess (≥1, the high water mark),
    // equal → 0 (the recovery mark), reverse → a dead-band value strictly
    // between, so a reverse reading neither opens an incident nor starts the
    // close quiet clock (correction 02, finding 2). The grouper's mismatch
    // debounce matches the evaluator's N, so the incident opens exactly at the
    // Nth consecutive leak reading and a single boundary-race reading never
    // opens one after a close.
    const mismatchDelta = turnCountMismatchDelta(readings);
    if (mismatchDelta !== undefined) {
      const grouperValue = mismatchDelta > 0 ? mismatchDelta : mismatchDelta === 0 ? 0 : J3_MISMATCH_REVERSE_BAND;
      const mismatch = this.observeKind('turn_count_mismatch', this.mismatch, grouperValue, 1, 0, 0, atMs, rawAlert('turn_count_mismatch'), this.debounceFor('turn_count_mismatch'), readings);
      if (mismatch) notifications.push(mismatch);
    }
    return notifications;
  }

  private observeKind(
    kind: HealthAlertKind,
    state: KindIncidentState,
    value: number,
    high: number,
    low: number,
    heapLimitBytes: number,
    atMs: number,
    rawAlert: boolean,
    debounceReadings: number,
    readings?: HealthReadings,
  ): HealthAlert | undefined {
    if (state.open) {
      if (value >= high) {
        state.peak = Math.max(state.peak, value);
        state.quietSinceMs = undefined;
        if (rawAlert) state.crossings += 1;
        return undefined;
      }
      if (value <= low) {
        if (state.quietSinceMs === undefined) state.quietSinceMs = atMs;
        if (atMs - state.quietSinceMs < this.config.quietPeriodMs) return undefined;
        return this.closeIncident(kind, state, value, low, heapLimitBytes, atMs);
      }
      // Dead band: the metric has not recovered, so the quiet clock restarts.
      state.quietSinceMs = undefined;
      return undefined;
    }

    if (value >= high) {
      if (state.pendingStartMs === undefined) {
        state.pendingStartMs = atMs;
        state.pendingPeak = value;
        state.pendingHighRun = 0;
        state.pendingCrossings = 0;
      }
      state.pendingHighRun += 1;
      state.pendingPeak = Math.max(state.pendingPeak, value);
      if (rawAlert) state.pendingCrossings += 1;
      if (state.pendingHighRun < debounceReadings) return undefined;
      return this.openIncident(kind, state, value, high, heapLimitBytes, atMs, readings);
    }

    if (value <= low) {
      // A genuine recovery clears the pending window.
      state.pendingStartMs = undefined;
      state.pendingHighRun = 0;
      state.pendingCrossings = 0;
      state.pendingPeak = 0;
    } else {
      // Dead band: the window survives (the latch is still armed), but the
      // consecutive-high run is broken.
      state.pendingHighRun = 0;
    }
    return undefined;
  }

  private openIncident(
    kind: HealthAlertKind,
    state: KindIncidentState,
    value: number,
    high: number,
    heapLimitBytes: number,
    atMs: number,
    readings?: HealthReadings,
  ): HealthAlert | undefined {
    const startedAtMs = state.pendingStartMs ?? atMs;
    // The cooldown is anchored on the first crossing that began this excursion
    // (correction 01, finding 1): a crossing that starts inside the cooldown is
    // suppressed even when its debounce completes on or after the boundary.
    const cooling = state.lastClosedAtMs !== undefined && startedAtMs - state.lastClosedAtMs < this.config.cooldownMs;
    state.open = true;
    state.startedAtMs = startedAtMs;
    state.peak = state.pendingPeak;
    state.crossings = Math.max(1, state.pendingCrossings);
    state.quietSinceMs = undefined;
    state.reopenedDuringCooldown = cooling;
    state.pendingStartMs = undefined;
    state.pendingHighRun = 0;
    state.pendingCrossings = 0;
    state.pendingPeak = 0;
    const incident: HealthIncidentSummary = {
      kind,
      startedAt: new Date(startedAtMs).toISOString(),
      peakValue: state.peak,
      alertCrossings: state.crossings,
      reopenedDuringCooldown: cooling,
    };
    if (cooling) return undefined; // Silent reopen inside the cooldown.
    return {
      kind,
      transition: 'alert',
      at: new Date(atMs).toISOString(),
      value,
      threshold: high,
      message: this.alertMessage(kind, value, high, heapLimitBytes, readings),
      incident,
    };
  }

  private closeIncident(
    kind: HealthAlertKind,
    state: KindIncidentState,
    value: number,
    low: number,
    heapLimitBytes: number,
    atMs: number,
  ): HealthAlert {
    const startedAtMs = state.startedAtMs ?? atMs;
    const endedAt = new Date(atMs).toISOString();
    const incident: HealthIncidentSummary = {
      kind,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt,
      durationMs: Math.max(0, atMs - startedAtMs),
      peakValue: state.peak,
      alertCrossings: state.crossings,
      reopenedDuringCooldown: state.reopenedDuringCooldown,
    };
    const message = this.recoveryMessage(kind, incident, heapLimitBytes);
    state.open = false;
    state.lastClosedAtMs = atMs;
    state.startedAtMs = undefined;
    state.peak = 0;
    state.crossings = 0;
    state.quietSinceMs = undefined;
    state.reopenedDuringCooldown = false;
    return {
      kind,
      transition: 'recovery',
      at: endedAt,
      value,
      threshold: low,
      message,
      incident,
    };
  }

  private alertMessage(kind: HealthAlertKind, value: number, high: number, heapLimitBytes: number, readings?: HealthReadings): string {
    const tail = 'further crossings will be folded into this incident';
    if (kind === 'heap_pressure') {
      return `heap pressure incident: ${(value * 100).toFixed(1)}% of the ${Math.round(heapLimitBytes / 1_048_576)} MB V8 heap limit (alert above ${(high * 100).toFixed(1)}%); ${tail}`;
    }
    if (kind === 'turn_count_mismatch') {
      const classes = Object.entries(readings?.admissionTurnsByClass ?? {}).filter(([, n]) => n > 0).map(([c, n]) => `${c}: ${n}`).join(', ') || 'none';
      const perRuntime = Object.entries(readings?.admissionTurnsByRuntime ?? {})
        .map(([runtime, n]) => `${runtime} admission ${n} vs telemetry ${readings?.activeTurnsByClass?.[runtime] ?? 0}`)
        .join(', ') || 'per-runtime counts unavailable';
      const oldest = readings?.admissionOldestActiveRunStartedAt
        ? `; oldest receipt-derived run started ${readings.admissionOldestActiveRunStartedAt}`
        : '; no receipt-derived active run (a leaked permit holds no receipt)';
      return `turn-count mismatch incident: admission holds ${readings?.admissionActiveTurns ?? '?'} active turn(s) (classes ${classes}) against telemetry excess ${value} sustained (${perRuntime})${oldest}; ${tail}`;
    }
    return `event-loop lag incident: p99 ${Math.round(value)} ms (alert above ${high} ms); ${tail}`;
  }

  private recoveryMessage(kind: HealthAlertKind, incident: HealthIncidentSummary, heapLimitBytes: number): string {
    const peak = kind === 'heap_pressure'
      ? `peak ${(incident.peakValue * 100).toFixed(1)}% of the ${Math.round(heapLimitBytes / 1_048_576)} MB V8 heap limit`
      : kind === 'turn_count_mismatch'
        ? `peak admission-vs-telemetry excess ${incident.peakValue} active turn(s)`
        : `peak p99 ${Math.round(incident.peakValue)} ms`;
    const crossings = incident.alertCrossings === 1
      ? '1 alert crossing folded'
      : `${incident.alertCrossings} alert crossings folded`;
    const reopened = incident.reopenedDuringCooldown
      ? '; reopened during the cooldown without a new alert'
      : '';
    const subject = kind === 'heap_pressure' ? 'heap pressure' : kind === 'turn_count_mismatch' ? 'turn-count mismatch' : 'event-loop lag';
    return `${subject} incident recovered: ${peak}, ${incident.startedAt} → ${incident.endedAt} (${formatIncidentDuration(incident.durationMs ?? 0)}), ${crossings}${reopened}`;
  }
}


export interface HealthAlertEvaluatorOptions {
  thresholds: HealthAlertThresholds;
  now?: () => number;
}

/**
 * Evaluates both latches against one reading and returns the transitions that
 * happened (usually none). Depends only on readings — never on the alert sink —
 * so alert semantics are unit-testable without any delivery.
 */
export class HealthAlertEvaluator {
  private readonly heapLatch: HysteresisLatch;
  private readonly lagLatch: HysteresisLatch;
  private readonly mismatchLatch: ConsecutiveReadingsLatch;
  private readonly turnAlertReadings: number;
  private readonly turnRecoveryReadings: number;
  private readonly now: () => number;

  constructor(options: HealthAlertEvaluatorOptions) {
    this.turnAlertReadings = options.thresholds.turnCountMismatchAlertReadings ?? DEFAULT_TURN_MISMATCH_ALERT_READINGS;
    this.turnRecoveryReadings = options.thresholds.turnCountMismatchRecoveryReadings ?? DEFAULT_TURN_MISMATCH_RECOVERY_READINGS;
    // Re-validate with the effective values so defaults are covered too.
    validateHealthAlertThresholds({
      ...options.thresholds,
      turnCountMismatchAlertReadings: this.turnAlertReadings,
      turnCountMismatchRecoveryReadings: this.turnRecoveryReadings,
    });
    this.now = options.now ?? Date.now;
    this.heapLatch = new HysteresisLatch('heap_pressure', options.thresholds.heapFractionHigh, options.thresholds.heapFractionLow);
    this.lagLatch = new HysteresisLatch('event_loop_lag', options.thresholds.lagP99HighMs, options.thresholds.lagP99LowMs);
    this.mismatchLatch = new ConsecutiveReadingsLatch('turn_count_mismatch', this.turnAlertReadings, this.turnRecoveryReadings);
  }

  evaluate(readings: HealthReadings): HealthAlert[] {
    const at = new Date(readings.atMs || this.now()).toISOString();
    const alerts: HealthAlert[] = [];
    const { heapFractionHigh, heapFractionLow, lagP99HighMs, lagP99LowMs } = {
      heapFractionHigh: this.heapLatch.describe().high,
      heapFractionLow: this.heapLatch.describe().low,
      lagP99HighMs: this.lagLatch.describe().high,
      lagP99LowMs: this.lagLatch.describe().low,
    };

    const heapTransition = this.heapLatch.evaluate(readings.heapFraction);
    if (heapTransition) {
      const threshold = heapTransition === 'alert' ? heapFractionHigh : heapFractionLow;
      const percent = (readings.heapFraction * 100).toFixed(1);
      const limitMb = Math.round(readings.heapLimitBytes / 1_048_576);
      alerts.push({
        kind: 'heap_pressure',
        transition: heapTransition,
        at,
        value: readings.heapFraction,
        threshold,
        message: heapTransition === 'alert'
          ? `heap pressure: ${percent}% of the ${limitMb} MB V8 heap limit (alert above ${(heapFractionHigh * 100).toFixed(1)}%)`
          : `heap pressure cleared: ${percent}% of the ${limitMb} MB V8 heap limit (recovered below ${(heapFractionLow * 100).toFixed(1)}%)`,
      });
    }

    const lagTransition = this.lagLatch.evaluate(readings.lagP99Ms);
    if (lagTransition) {
      const threshold = lagTransition === 'alert' ? lagP99HighMs : lagP99LowMs;
      alerts.push({
        kind: 'event_loop_lag',
        transition: lagTransition,
        at,
        value: readings.lagP99Ms,
        threshold,
        message: lagTransition === 'alert'
          ? `event-loop lag p99 ${Math.round(readings.lagP99Ms)} ms (alert above ${lagP99HighMs} ms)`
          : `event-loop lag cleared: p99 ${Math.round(readings.lagP99Ms)} ms (recovered below ${lagP99LowMs} ms)`,
      });
    }

    // J3: admission holding more active turns than the runtime telemetry, for
    // N consecutive readings, is a stuck permit. Unwired (no admission
    // fields) never evaluates — a missing source is not a zero mismatch.
    const mismatchDelta = turnCountMismatchDelta(readings);
    if (mismatchDelta !== undefined) {
      const mismatchTransition = this.mismatchLatch.evaluate(mismatchDelta);
      if (mismatchTransition) {
        alerts.push({
          kind: 'turn_count_mismatch',
          transition: mismatchTransition,
          at,
          value: Math.max(0, mismatchDelta),
          threshold: mismatchTransition === 'alert' ? this.turnAlertReadings : this.turnRecoveryReadings,
          message: mismatchTransition === 'alert'
            ? this.mismatchAlertMessage(readings, Math.max(0, mismatchDelta))
            : this.mismatchRecoveryMessage(readings),
        });
      }
    }

    return alerts;
  }

  private mismatchAlertMessage(readings: HealthReadings, excess: number): string {
    const classes = Object.entries(readings.admissionTurnsByClass ?? {}).filter(([, n]) => n > 0).map(([c, n]) => `${c}: ${n}`).join(', ') || 'none';
    const perRuntime = Object.entries(readings.admissionTurnsByRuntime ?? {})
      .map(([runtime, n]) => `${runtime} admission ${n} vs telemetry ${readings.activeTurnsByClass?.[runtime] ?? 0}`)
      .join(', ') || 'per-runtime counts unavailable';
    const oldest = readings.admissionOldestActiveRunStartedAt
      ? `; oldest receipt-derived run started ${readings.admissionOldestActiveRunStartedAt}`
      : '; no receipt-derived active run (a leaked permit holds no receipt)';
    return `turn-count mismatch: admission holds ${readings.admissionActiveTurns} active turn(s) (classes ${classes}) against telemetry excess ${excess} for ${this.turnAlertReadings} consecutive readings (${perRuntime})${oldest}`;
  }

  private mismatchRecoveryMessage(readings: HealthReadings): string {
    return `turn-count mismatch cleared: admission ${readings.admissionActiveTurns} active turn(s), telemetry ${Object.values(readings.activeTurnsByClass ?? {}).reduce((sum, value) => sum + value, 0)} (agreement held for ${this.turnRecoveryReadings} consecutive readings)`;
  }

  snapshot(): {
    heap: { alerting: boolean; high: number; low: number };
    lag: { alerting: boolean; highMs: number; lowMs: number };
    turnCountMismatch: { alerting: boolean; alertReadings: number; recoveryReadings: number };
  } {
    const heap = this.heapLatch.describe();
    const lag = this.lagLatch.describe();
    const mismatch = this.mismatchLatch.describe();
    return {
      heap: { alerting: heap.alerting, high: heap.high, low: heap.low },
      lag: { alerting: lag.alerting, highMs: lag.high, lowMs: lag.low },
      turnCountMismatch: { alerting: mismatch.alerting, alertReadings: mismatch.alertReadings, recoveryReadings: mismatch.recoveryReadings },
    };
  }
}

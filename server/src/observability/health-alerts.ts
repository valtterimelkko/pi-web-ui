import type { HealthReadings } from './health-readings.js';

/**
 * A2 alerts: heap and event-loop health with hysteresis, so a reading that
 * oscillates around a threshold produces one alert and one recovery rather
 * than a message per sample.
 */

export type HealthAlertKind = 'heap_pressure' | 'event_loop_lag';
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
}

export interface HealthAlert {
  kind: HealthAlertKind;
  transition: HealthAlertTransition;
  at: string;
  /** The reading that triggered the transition: heap fraction or lag p99 ms. */
  value: number;
  /** The threshold it crossed: `heapFractionHigh/Low` or `lagP99HighMs/LowMs`. */
  threshold: number;
  message: string;
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
  private readonly now: () => number;

  constructor(options: HealthAlertEvaluatorOptions) {
    validateHealthAlertThresholds(options.thresholds);
    this.now = options.now ?? Date.now;
    this.heapLatch = new HysteresisLatch('heap_pressure', options.thresholds.heapFractionHigh, options.thresholds.heapFractionLow);
    this.lagLatch = new HysteresisLatch('event_loop_lag', options.thresholds.lagP99HighMs, options.thresholds.lagP99LowMs);
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

    return alerts;
  }

  snapshot(): {
    heap: { alerting: boolean; high: number; low: number };
    lag: { alerting: boolean; highMs: number; lowMs: number };
  } {
    const heap = this.heapLatch.describe();
    const lag = this.lagLatch.describe();
    return {
      heap: { alerting: heap.alerting, high: heap.high, low: heap.low },
      lag: { alerting: lag.alerting, highMs: lag.high, lowMs: lag.low },
    };
  }
}

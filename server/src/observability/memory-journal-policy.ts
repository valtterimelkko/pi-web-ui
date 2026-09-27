/**
 * A2 journal-volume policy for the `[MultiSessionManager] Memory:` line.
 *
 * The pre-A2 gate logged on every 30 s memory check whenever `heapUsed > 500 MB`
 * or more than five sessions were resident — up to 120 journal lines per hour on
 * a production-like heap, which is why heap history had to be reconstructed from
 * a 3.8 GB journal. This policy keeps the signal and drops the repetition:
 *
 *  1. the first sample always logs (a baseline exists in every boot);
 *  2. a change of `minDeltaMb` or more logs (real movement is never missed);
 *  3. otherwise a `heartbeatMs` heartbeat logs, but only while the server is
 *     worth heart-beating about (`heapUsedMb >= heartbeatHeapMb` or more than
 *     `heartbeatSessions` residents) — an idle server stays silent instead of
 *     trading a noisy gate for a steady drip.
 *
 * Pure and time-injected, so the volume reduction is unit-testable without a
 * server (the disposable server measures the real before/after).
 */
export interface MemoryJournalSample {
  heapUsedMb: number;
  sessionCount: number;
}

export interface MemoryJournalPolicyOptions {
  /** Significant heap change that forces a line (MB). */
  minDeltaMb?: number;
  /** Low-frequency heartbeat interval (ms). */
  heartbeatMs?: number;
  /** Heartbeat only fires at or above this heap usage (MB). */
  heartbeatHeapMb?: number;
  /** Heartbeat only fires above this resident-session count. */
  heartbeatSessions?: number;
  now?: () => number;
}

export class MemoryJournalPolicy {
  private readonly minDeltaMb: number;
  private readonly heartbeatMs: number;
  private readonly heartbeatHeapMb: number;
  private readonly heartbeatSessions: number;
  private readonly now: () => number;
  private lastLoggedAt: number | undefined;
  private lastLoggedHeapMb: number | undefined;
  private lastLoggedSessions: number | undefined;

  constructor(options: MemoryJournalPolicyOptions = {}) {
    this.minDeltaMb = Math.max(0, options.minDeltaMb ?? 100);
    this.heartbeatMs = Math.max(1, options.heartbeatMs ?? 30 * 60 * 1000);
    this.heartbeatHeapMb = options.heartbeatHeapMb ?? 500;
    this.heartbeatSessions = options.heartbeatSessions ?? 5;
    this.now = options.now ?? Date.now;
  }

  shouldLog(sample: MemoryJournalSample): boolean {
    const now = this.now();
    const significantChange = this.lastLoggedHeapMb !== undefined
      && Math.abs(sample.heapUsedMb - this.lastLoggedHeapMb) >= this.minDeltaMb;
    const heartbeatDue = this.lastLoggedAt === undefined
      ? true
      : now - this.lastLoggedAt >= this.heartbeatMs;
    const worthHeartbeating = sample.heapUsedMb >= this.heartbeatHeapMb || sample.sessionCount > this.heartbeatSessions;
    // Crossing into or out of the "many sessions resident" regime is a discrete
    // event worth a line; drifting 1→2 is not.
    const sessionRegime = this.lastLoggedSessions !== undefined
      && (this.lastLoggedSessions > this.heartbeatSessions) !== (sample.sessionCount > this.heartbeatSessions);

    if (this.lastLoggedAt === undefined || significantChange || sessionRegime || (heartbeatDue && worthHeartbeating)) {
      this.lastLoggedAt = now;
      this.lastLoggedHeapMb = sample.heapUsedMb;
      this.lastLoggedSessions = sample.sessionCount;
      return true;
    }
    return false;
  }

  /** Diagnostics/tests: what the last emitted line described. */
  snapshot(): { lastLoggedAt?: number; lastLoggedHeapMb?: number; lastLoggedSessions?: number } {
    return {
      lastLoggedAt: this.lastLoggedAt,
      lastLoggedHeapMb: this.lastLoggedHeapMb,
      lastLoggedSessions: this.lastLoggedSessions,
    };
  }
}

let globalPolicy: MemoryJournalPolicy | undefined;

/** Process-wide policy built from the A2 config knobs. */
export function getMemoryJournalPolicy(options: MemoryJournalPolicyOptions = {}): MemoryJournalPolicy {
  globalPolicy ??= new MemoryJournalPolicy(options);
  return globalPolicy;
}

/** Test seam. */
export function resetMemoryJournalPolicy(): void {
  globalPolicy = undefined;
}

function nonnegative(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a non-negative integer.`);
  return Number(raw);
}

function positive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new Error(`${name} must be a positive integer.`);
  return Number(raw);
}

/**
 * Resolves the journal-volume knobs from the environment. Lives here (rather
 * than in the config module) so the Pi runtime never imports `config.ts` — a
 * module many tests partially mock — and `config.ts` imports this instead.
 */
export function resolveMemoryJournalPolicyOptions(env: NodeJS.ProcessEnv = process.env): {
  minDeltaMb: number;
  heartbeatMs: number;
  heartbeatHeapMb: number;
  heartbeatSessions: number;
} {
  return {
    minDeltaMb: nonnegative(env.OBSERVABILITY_MEMORY_JOURNAL_MIN_DELTA_MB, 100, 'OBSERVABILITY_MEMORY_JOURNAL_MIN_DELTA_MB'),
    heartbeatMs: positive(env.OBSERVABILITY_MEMORY_JOURNAL_HEARTBEAT_MS, 30 * 60 * 1000, 'OBSERVABILITY_MEMORY_JOURNAL_HEARTBEAT_MS'),
    heartbeatHeapMb: nonnegative(env.OBSERVABILITY_MEMORY_JOURNAL_HEAP_MB, 500, 'OBSERVABILITY_MEMORY_JOURNAL_HEAP_MB'),
    heartbeatSessions: nonnegative(env.OBSERVABILITY_MEMORY_JOURNAL_SESSIONS, 5, 'OBSERVABILITY_MEMORY_JOURNAL_SESSIONS'),
  };
}

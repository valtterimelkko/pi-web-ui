import { describe, it, expect } from 'vitest';
import {
  decideWatchdogTick,
  parseStallAfterMs,
  DEFAULT_STALL_AFTER_MS,
} from '../../src/watchdog-policy.js';

/**
 * The watchdog policy, tested directly.
 *
 * Context (2026-09-14): the service was SIGKILLed four times in an afternoon
 * and the journal could not explain why. The ping that is supposed to report a
 * hung service was a `setInterval` on the watched event loop — so a stall
 * silenced the ping and produced an unexplained restart. These tests pin the
 * replacement policy: pings stop during a genuine stall (so systemd can still
 * recover), but the stall is announced as an EDGE so the journal explains the
 * restart exactly once rather than every tick.
 */
describe('watchdog policy', () => {
  const stallAfterMs = 20_000;

  it('pings before the main thread has ever beaten (boot must not be killed)', () => {
    const d = decideWatchdogTick({ nowMs: 1_000_000, lastBeatMs: 0, stallAfterMs });
    expect(d.ping).toBe(true);
    expect(d.stalled).toBe(false);
    expect(d.stalledMs).toBe(0);
  });

  it('keeps pinging while the heartbeat is fresh', () => {
    const d = decideWatchdogTick({ nowMs: 1_000_000, lastBeatMs: 999_000, stallAfterMs });
    expect(d.ping).toBe(true);
    expect(d.healthy).toBe(true);
  });

  it('stops pinging once the heartbeat is stale, so systemd can still recover a hung service', () => {
    const d = decideWatchdogTick({ nowMs: 1_000_000, lastBeatMs: 900_000, stallAfterMs });
    expect(d.ping).toBe(false);
    expect(d.stalled).toBe(true);
    expect(d.stalledMs).toBe(100_000);
  });

  it('reports the stall on the EDGE only, so the journal is not flooded every tick', () => {
    const first = decideWatchdogTick({ nowMs: 1_000_000, lastBeatMs: 900_000, stallAfterMs, previouslyStalled: false });
    const second = decideWatchdogTick({ nowMs: 1_005_000, lastBeatMs: 900_000, stallAfterMs, previouslyStalled: true });
    expect(first.stallStarted).toBe(true);
    expect(second.stallStarted).toBe(false);
    expect(second.stalled).toBe(true);
  });

  it('treats exactly-at-threshold as healthy (no off-by-one early kill)', () => {
    const d = decideWatchdogTick({ nowMs: 1_020_000, lastBeatMs: 1_000_000, stallAfterMs });
    expect(d.ping).toBe(true);
  });

  it('goes stale one millisecond past the threshold', () => {
    const d = decideWatchdogTick({ nowMs: 1_020_001, lastBeatMs: 1_000_000, stallAfterMs });
    expect(d.ping).toBe(false);
  });

  describe('parseStallAfterMs', () => {
    it('defaults when unset, blank or nonsense', () => {
      expect(parseStallAfterMs(undefined)).toBe(DEFAULT_STALL_AFTER_MS);
      expect(parseStallAfterMs('')).toBe(DEFAULT_STALL_AFTER_MS);
      expect(parseStallAfterMs('soon')).toBe(DEFAULT_STALL_AFTER_MS);
      expect(parseStallAfterMs('-5')).toBe(DEFAULT_STALL_AFTER_MS);
    });

    it('honours an operator value, including one above WatchdogSec (explicit policy is not silently clamped)', () => {
      expect(parseStallAfterMs('60000')).toBe(60_000);
      expect(parseStallAfterMs('0')).toBe(0);
    });
  });
});

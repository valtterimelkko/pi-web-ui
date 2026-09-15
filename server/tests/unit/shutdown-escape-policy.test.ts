import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESCAPE_AFTER_MS,
  decideShutdownEscapeTick,
  parseEscapeAfterMs,
} from '../../src/shutdown-escape-policy.js';

/**
 * The shutdown-escape decision, as a pure function (2026-09-15).
 *
 * Why this exists: the service has been SIGKILLed by systemd after
 * `TimeoutStopSec=30` at least seven times, and on two of those occasions the
 * app's own shutdown handler *did* run but wedged on `server.close()`, so the
 * only thing that ended the stop was systemd's escalation. The graceful path
 * must be bounded by something that cannot itself be wedged — a decision the
 * main thread does not get to make after the fact.
 *
 * This module holds only the decision, so the timing can be tested directly
 * rather than inferred from a live stop.
 */
describe('shutdown escape policy', () => {
  const base = { escapeAfterMs: 12_000, nowMs: 100_000 };

  it('stays idle while no stop signal has been recorded', () => {
    const decision = decideShutdownEscapeTick({ ...base, signalReceivedAtMs: 0 });
    expect(decision.action).toBe('idle');
    expect(decision.escapeStarted).toBe(false);
    expect(decision.sinceSignalMs).toBe(0);
  });

  it('waits while the main thread is still inside its grace window', () => {
    const decision = decideShutdownEscapeTick({ ...base, signalReceivedAtMs: 95_000 });
    expect(decision.action).toBe('wait');
    expect(decision.sinceSignalMs).toBe(5_000);
    expect(decision.escapeStarted).toBe(false);
  });

  it('escapes once the grace window has passed', () => {
    const decision = decideShutdownEscapeTick({ ...base, signalReceivedAtMs: 85_000 });
    expect(decision.action).toBe('escape');
    expect(decision.sinceSignalMs).toBe(15_000);
    // Edge, not level: the reason must be recorded once, not every tick.
    expect(decision.escapeStarted).toBe(true);
  });

  it('does not re-announce the escape on later ticks', () => {
    const decision = decideShutdownEscapeTick({
      ...base,
      signalReceivedAtMs: 85_000,
      previouslyEscaped: true,
    });
    expect(decision.action).toBe('escape');
    expect(decision.escapeStarted).toBe(false);
  });

  it('treats the boundary itself as still waiting', () => {
    const decision = decideShutdownEscapeTick({ ...base, signalReceivedAtMs: 88_000 });
    expect(decision.sinceSignalMs).toBe(12_000);
    expect(decision.action).toBe('wait');
  });

  it('keeps the default well inside systemd TimeoutStopSec=30', () => {
    expect(DEFAULT_ESCAPE_AFTER_MS).toBeLessThan(30_000);
    expect(DEFAULT_ESCAPE_AFTER_MS).toBeGreaterThan(0);
  });

  it('reads the escape window from the environment, falling back on nonsense', () => {
    expect(parseEscapeAfterMs(undefined)).toBe(DEFAULT_ESCAPE_AFTER_MS);
    expect(parseEscapeAfterMs('4000')).toBe(4_000);
    expect(parseEscapeAfterMs('nonsense')).toBe(DEFAULT_ESCAPE_AFTER_MS);
    expect(parseEscapeAfterMs('-5')).toBe(DEFAULT_ESCAPE_AFTER_MS);
  });
});

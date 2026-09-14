import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWatchdogWorker } from '../../src/systemd-watchdog-worker.js';

/**
 * The watchdog loop itself (2026-09-14).
 *
 * The policy module decides; this module *acts* on the decision and is the
 * part that runs on the worker thread. It is tested here because it now owns
 * behaviour the main-thread notifier used to: the ping cadence, and — the
 * whole point of the change — what happens to the pings and the journal when
 * the main thread stops beating.
 */
describe('watchdog worker loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const beatsWith = (ms: number): BigInt64Array => {
    const b = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(b, 0, BigInt(ms));
    return b;
  };

  it('pings on its own schedule while the main thread keeps beating', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(undefined);
    const beats = beatsWith(1_000_000);
    const w = runWatchdogWorker(
      { beats, pingIntervalMs: 5_000, stallAfterMs: 20_000 },
      { ping, report: vi.fn(), now: () => 1_000_100 },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ping.mock.calls.length).toBeGreaterThanOrEqual(2);
    w.stop();
  });

  it('stops pinging when the heartbeat goes stale, and says so ONCE', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    // The main thread beat once, long ago; systemd's recovery must be preserved.
    const beats = beatsWith(1_000_000);
    const w = runWatchdogWorker(
      { beats, pingIntervalMs: 5_000, stallAfterMs: 20_000 },
      { ping, report, now: () => 2_000_000 },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ping).not.toHaveBeenCalled();
    const stalls = report.mock.calls.filter(([l]) => String(l).includes('event=event_loop_stall'));
    expect(stalls).toHaveLength(1);
    expect(String(stalls[0][0])).toContain('pinging=false');
    w.stop();
  });

  it('announces recovery when the heartbeat returns', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const beats = beatsWith(1_000_000);
    let nowMs = 2_000_000; // stalled
    const w = runWatchdogWorker(
      { beats, pingIntervalMs: 5_000, stallAfterMs: 20_000 },
      { ping: vi.fn().mockResolvedValue(undefined), report, now: () => nowMs },
    );
    await vi.advanceTimersByTimeAsync(6_000);
    // The main thread comes back.
    Atomics.store(beats, 0, BigInt(2_100_000));
    nowMs = 2_100_100;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(report.mock.calls.some(([l]) => String(l).includes('event=event_loop_recovered'))).toBe(true);
    w.stop();
  });

  it('does not stack pings when one is still in flight', async () => {
    vi.useFakeTimers();
    let resolvePing: (() => void) | undefined;
    const ping = vi.fn(() => new Promise<void>((res) => { resolvePing = res; }));
    const beats = beatsWith(1_000_000);
    const w = runWatchdogWorker(
      { beats, pingIntervalMs: 5_000, stallAfterMs: 20_000 },
      { ping, report: vi.fn(), now: () => 1_000_100 },
    );
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ping).toHaveBeenCalledTimes(1);
    resolvePing?.();
    w.stop();
  });

  it('stops cleanly and reports nothing further', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(undefined);
    const beats = beatsWith(1_000_000);
    const w = runWatchdogWorker(
      { beats, pingIntervalMs: 5_000, stallAfterMs: 20_000 },
      { ping, report: vi.fn(), now: () => 1_000_100 },
    );
    w.stop();
    const before = ping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ping.mock.calls.length).toBe(before);
  });
});

/**
 * Regression: the production restart loop of 2026-09-14.
 *
 * The worker's timer was unref'd, so the thread's event loop had nothing
 * keeping it alive and the worker exited immediately after start-up. The pings
 * stopped, systemd saw a service that never certified itself, and restarted it
 * every `WatchdogSec` + boot time — about 68 seconds — for as long as it took
 * to notice. Thirty unit tests were green throughout, because every one of them
 * injected the ping and none exercised the real thread lifecycle.
 *
 * This asserts the property directly rather than by proxy.
 */
describe('watchdog worker — the timer must keep its thread alive', () => {
  it('holds a REFERENCED timer (an unref\'d one lets the worker exit and the pings stop)', () => {
    const beats = new BigInt64Array(new SharedArrayBuffer(8));
    const w = runWatchdogWorker(
      { beats, pingIntervalMs: 1_000, stallAfterMs: 20_000 },
      { ping: async () => {}, report: () => {}, now: () => 1 },
    );
    expect(w.refed).toBe(true);
    w.stop();
  });
});

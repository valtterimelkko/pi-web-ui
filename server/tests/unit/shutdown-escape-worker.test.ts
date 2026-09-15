import { afterEach, describe, expect, it, vi } from 'vitest';
import { runShutdownEscapeWorker } from '../../src/shutdown-escape-worker.js';

/**
 * The shutdown escape worker (2026-09-15).
 *
 * The main thread records the received stop signal synchronously and then
 * begins teardown. This worker is the independent backstop: if the process is
 * still alive `escapeAfterMs` later, it writes the reason and ends the process
 * itself — so the stop never runs as far as systemd's `TimeoutStopSec=30`
 * SIGKILL, which takes the whole control group (`KillMode=control-group`) and
 * every in-flight orchestration child with it.
 *
 * It lives on a worker thread for the same reason the watchdog pinger does: a
 * backstop scheduled on the loop it is meant to survive is not a backstop.
 */
describe('shutdown escape worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const signalAt = (ms: number): BigInt64Array => {
    const b = new BigInt64Array(new SharedArrayBuffer(8));
    Atomics.store(b, 0, BigInt(ms));
    return b;
  };

  it('does nothing at all while no stop signal has been recorded', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const report = vi.fn();
    const w = runShutdownEscapeWorker(
      { signalReceived: signalAt(0), escapeAfterMs: 12_000, pollIntervalMs: 1_000 },
      { forceExit, report, now: () => 10_000_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(forceExit).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    w.stop();
  });

  it('leaves a healthy teardown alone', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    let nowMs = 1_000_000;
    const w = runShutdownEscapeWorker(
      { signalReceived: signalAt(1_000_000), escapeAfterMs: 12_000, pollIntervalMs: 1_000 },
      { forceExit, report: vi.fn(), now: () => nowMs },
    );
    // The handler ran, teardown is proceeding: the process keeps living, and
    // the worker must not be the thing that ends it.
    nowMs = 1_004_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(forceExit).not.toHaveBeenCalled();
    w.stop();
  });

  it('forces the exit — recording the reason first — when the deadline passes', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const report = vi.fn();
    let nowMs = 1_000_000;
    const w = runShutdownEscapeWorker(
      { signalReceived: signalAt(1_000_000), escapeAfterMs: 12_000, pollIntervalMs: 1_000 },
      { forceExit, report, now: () => nowMs },
    );
    nowMs = 1_013_000; // past the grace window, still alive
    await vi.advanceTimersByTimeAsync(2_000);

    expect(forceExit).toHaveBeenCalledTimes(1);
    const lines = report.mock.calls.map(([l]) => String(l));
    expect(lines.join('\n')).toContain('shutdown_escape');
    expect(lines.join('\n')).toContain('12000');
    // Order matters: the reason must be on stderr BEFORE the process is ended.
    expect(report.mock.invocationCallOrder[0]).toBeLessThan(forceExit.mock.invocationCallOrder[0]);
    w.stop();
  });

  it('records the reason exactly once even if ticks continue', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const report = vi.fn();
    let nowMs = 1_000_000;
    const w = runShutdownEscapeWorker(
      { signalReceived: signalAt(1_000_000), escapeAfterMs: 12_000, pollIntervalMs: 1_000 },
      { forceExit, report, now: () => nowMs },
    );
    nowMs = 1_030_000;
    await vi.advanceTimersByTimeAsync(5_000);
    const escapes = report.mock.calls.filter(([l]) => String(l).includes('shutdown_escape'));
    expect(escapes).toHaveLength(1);
    w.stop();
  });

  it('stops when told to', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    let nowMs = 1_000_000;
    const w = runShutdownEscapeWorker(
      { signalReceived: signalAt(1_000_000), escapeAfterMs: 12_000, pollIntervalMs: 1_000 },
      { forceExit, report: vi.fn(), now: () => nowMs },
    );
    w.stop();
    nowMs = 1_060_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(forceExit).not.toHaveBeenCalled();
  });
});

/**
 * Regression guard, mirroring the watchdog worker's 2026-09-14 production
 * restart loop: a worker whose only timer is unref'd does not keep its thread
 * alive, so the thread exits silently and the backstop stops existing. That
 * would be worse here than for the pinger — a backstop that silently goes away
 * is indistinguishable from one that is working, until it is needed.
 */
describe('shutdown escape worker — the timer must keep its thread alive', () => {
  it('holds a REFERENCED timer', () => {
    const w = runShutdownEscapeWorker(
      {
        signalReceived: new BigInt64Array(new SharedArrayBuffer(8)),
        escapeAfterMs: 12_000,
        pollIntervalMs: 1_000,
      },
      { forceExit: () => {}, report: () => {}, now: () => 1 },
    );
    expect(w.refed).toBe(true);
    w.stop();
  });
});

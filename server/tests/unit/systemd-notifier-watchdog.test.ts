import { describe, it, expect, vi } from 'vitest';
import { startSystemdNotifier } from '../../src/systemd-notifier.js';

/**
 * The notifier's job changed on 2026-09-14: the `WATCHDOG=1` ping moved off
 * the event loop it watches and into a worker thread, gated on a heartbeat the
 * main thread publishes. These tests pin the wiring — that the worker is
 * started with a usable heartbeat buffer and a sane threshold, that the
 * heartbeat is actually written, and that stop() really stops it.
 */
describe('systemd notifier — watchdog wiring', () => {
  const envWithWatchdog = { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '45000000' };

  it('does nothing without NOTIFY_SOCKET', () => {
    const startWorker = vi.fn();
    const stop = startSystemdNotifier({ environment: {}, notify: vi.fn(), startWorker });
    stop();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('announces readiness but starts no watchdog when systemd asked for none', () => {
    const notify = vi.fn();
    const startWorker = vi.fn();
    const stop = startSystemdNotifier({ environment: { NOTIFY_SOCKET: '/run/systemd/notify' }, notify, startWorker });
    stop();
    expect(notify).toHaveBeenCalledWith(['--ready', '--status=Pi Web UI ready']);
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('starts the watchdog worker with a heartbeat buffer and the stall threshold', () => {
    const startWorker = vi.fn(() => ({ terminate: vi.fn() }));
    const stop = startSystemdNotifier({
      environment: envWithWatchdog,
      notify: vi.fn(),
      startWorker,
      stallAfterMs: 12_345,
      pingIntervalMs: 5_000,
    });
    stop();
    expect(startWorker).toHaveBeenCalledTimes(1);
    const arg = startWorker.mock.calls[0][0];
    expect(arg.stallAfterMs).toBe(12_345);
    expect(arg.pingIntervalMs).toBe(5_000);
    expect(arg.beats).toBeInstanceOf(BigInt64Array);
  });

  it('writes a heartbeat the worker can read', () => {
    let captured: BigInt64Array | undefined;
    const stop = startSystemdNotifier({
      environment: envWithWatchdog,
      notify: vi.fn(),
      startWorker: (data) => { captured = data.beats; return { terminate: vi.fn() }; },
      now: () => 1_700_000_000_000,
    });
    stop();
    expect(captured).toBeDefined();
    expect(Number(Atomics.load(captured!, 0))).toBe(1_700_000_000_000);
  });

  it('terminates the worker and stops beating on stop()', () => {
    const terminate = vi.fn();
    const stop = startSystemdNotifier({
      environment: envWithWatchdog,
      notify: vi.fn(),
      startWorker: () => ({ terminate }),
    });
    stop();
    expect(terminate).toHaveBeenCalledTimes(1);
    // Idempotent: teardown can be invoked more than once in practice.
    expect(() => stop()).not.toThrow();
  });

  it('reads the stall threshold from the environment when not injected', () => {
    const startWorker = vi.fn(() => ({ terminate: vi.fn() }));
    const stop = startSystemdNotifier({
      environment: { ...envWithWatchdog, PI_WEB_UI_WATCHDOG_STALL_MS: '9000' } as never,
      notify: vi.fn(),
      startWorker,
    });
    stop();
    expect(startWorker.mock.calls[0][0].stallAfterMs).toBe(9_000);
  });
});

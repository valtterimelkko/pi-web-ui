import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSystemdNotifier } from '../../src/systemd-notifier.js';

describe('startSystemdNotifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing outside a systemd notify service', () => {
    const notify = vi.fn();
    const startWorker = vi.fn();
    const stop = startSystemdNotifier({ environment: {}, notify, startWorker });

    expect(notify).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
    stop();
  });

  it('announces readiness on the main thread and does NOT ping from it', async () => {
    // 2026-09-14: the WATCHDOG=1 ping moved to a worker thread (see
    // systemd-notifier-watchdog.test.ts for the wiring and
    // systemd-watchdog-worker.test.ts for the cadence and stall behaviour).
    // Asserted here so the main loop cannot quietly take the ping back — a
    // ping on the watched loop is the defect this split removed.
    vi.useFakeTimers();
    const notify = vi.fn().mockResolvedValue(undefined);
    const stop = startSystemdNotifier({
      environment: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '45000000' },
      notify,
      startWorker: () => ({ terminate: vi.fn() }),
    });

    expect(notify).toHaveBeenCalledWith(['--ready', '--status=Pi Web UI ready']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(notify.mock.calls.filter(([args]) => args[0] === 'WATCHDOG=1')).toHaveLength(0);

    stop();
  });

  it('announces readiness without arming a watchdog when WatchdogSec is absent', async () => {
    vi.useFakeTimers();
    const notify = vi.fn().mockResolvedValue(undefined);
    const startWorker = vi.fn(() => ({ terminate: vi.fn() }));
    startSystemdNotifier({ environment: { NOTIFY_SOCKET: '/run/systemd/notify' }, notify, startWorker });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(['--ready', '--status=Pi Web UI ready']);
    expect(startWorker).not.toHaveBeenCalled();
  });
});

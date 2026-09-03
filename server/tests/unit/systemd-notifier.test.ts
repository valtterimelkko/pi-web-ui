import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSystemdNotifier } from '../../src/systemd-notifier.js';

describe('startSystemdNotifier', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing outside a systemd notify service', () => {
    const notify = vi.fn();
    const stop = startSystemdNotifier({ environment: {}, notify });

    expect(notify).not.toHaveBeenCalled();
    stop();
  });

  it('announces readiness and sends watchdog heartbeats every ten seconds', async () => {
    vi.useFakeTimers();
    const notify = vi.fn().mockResolvedValue(undefined);
    const stop = startSystemdNotifier({
      environment: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '45000000' },
      notify,
    });

    expect(notify).toHaveBeenCalledWith(['--ready', '--status=Pi Web UI ready']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notify.mock.calls.filter(([args]) => args[0] === '--watchdog')).toHaveLength(2);

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notify.mock.calls.filter(([args]) => args[0] === '--watchdog')).toHaveLength(2);
  });

  it('announces readiness without arming heartbeats when WatchdogSec is absent', async () => {
    vi.useFakeTimers();
    const notify = vi.fn().mockResolvedValue(undefined);
    startSystemdNotifier({ environment: { NOTIFY_SOCKET: '/run/systemd/notify' }, notify });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(['--ready', '--status=Pi Web UI ready']);
  });
});

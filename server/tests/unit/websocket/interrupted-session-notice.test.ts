import { describe, expect, it, vi } from 'vitest';
import { reconcileInterruptedPiSession } from '../../../src/websocket/connection.js';

/**
 * WS-path memory robustness (2026-09-05 plan, F5): after a server crash the
 * session registry keeps the interrupted session's status as `running`, and
 * the browser showed a silently dead turn for up to the 15-minute stale-stream
 * threshold with no operator-visible explanation. On rehydrate/subscribe we
 * now reconcile: one immediate stale_stream_reset-style notice to the viewing
 * client + registry status corrected to idle.
 */
function registryWith(status: string | undefined) {
  return {
    getByPath: status === undefined
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockResolvedValue({ id: 'reg-1', status }),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe('reconcileInterruptedPiSession', () => {
  it('notifies the client and corrects the registry when a persisted running session rehydrates idle', async () => {
    const registry = registryWith('running');
    const notify = vi.fn();

    const handled = await reconcileInterruptedPiSession({
      sessionPath: '/p/s.jsonl',
      liveStatus: 'idle',
      registry: registry as any,
      notify,
    });

    expect(handled).toBe(true);
    expect(registry.updateStatus).toHaveBeenCalledWith('reg-1', 'idle');
    expect(notify).toHaveBeenCalledTimes(1);
    const envelope = notify.mock.calls[0][0] as {
      type: string;
      sessionId: string;
      event: { type: string; message: string };
    };
    expect(envelope.type).toBe('session_event');
    expect(envelope.event.type).toBe('stale_stream_reset');
    expect(envelope.event.message).toMatch(/interrupted/i);
  });

  it('does nothing when the registry does not say running', async () => {
    const registry = registryWith('idle');
    const notify = vi.fn();

    const handled = await reconcileInterruptedPiSession({
      sessionPath: '/p/s.jsonl',
      liveStatus: 'idle',
      registry: registry as any,
      notify,
    });

    expect(handled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(registry.updateStatus).not.toHaveBeenCalled();
  });

  it('does nothing when the live session is actually busy (a real turn resumed)', async () => {
    const registry = registryWith('running');
    const notify = vi.fn();

    const handled = await reconcileInterruptedPiSession({
      sessionPath: '/p/s.jsonl',
      liveStatus: 'streaming',
      registry: registry as any,
      notify,
    });

    expect(handled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('is resilient to a missing registry entry or registry errors', async () => {
    const notify = vi.fn();
    const handled = await reconcileInterruptedPiSession({
      sessionPath: '/p/s.jsonl',
      liveStatus: 'idle',
      registry: registryWith(undefined) as any,
      notify,
    });
    expect(handled).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    const throwing = { getByPath: vi.fn().mockRejectedValue(new Error('registry io')), updateStatus: vi.fn() };
    await expect(reconcileInterruptedPiSession({
      sessionPath: '/p/s.jsonl',
      liveStatus: 'idle',
      registry: throwing as any,
      notify,
    })).resolves.toBe(false);
  });
});

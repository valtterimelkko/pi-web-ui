import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';

/**
 * The persisted session store had grown to ~2.2MB (800+ sessions with very
 * long firstMessage strings), and zustand's persist stringified that whole
 * payload on EVERY set() — ~200-330ms of blocking JSON work per broadcast
 * event, which saturated the main thread and made large session replays take
 * 15s+ or wedge entirely. The persisted slice must stay small and the
 * stringify must happen only at the throttled flush.
 */

describe('session store persistence hygiene', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  it('persists at most 200 sessions with a bounded firstMessage', async () => {
    vi.useRealTimers();
    const many = Array.from({ length: 350 }, (_, i) => ({
      id: `s${i}`,
      path: `/p/s${i}`,
      firstMessage: 'x'.repeat(40_000),
      messageCount: 1,
      cwd: '/tmp',
      lastActivity: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    useSessionStore.setState({ sessions: many });
    // Trigger a persist flush.
    useSessionStore.getState().setLoading(!useSessionStore.getState().isLoading);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const raw = localStorage.getItem('pi-web-ui-session');
    expect(raw).not.toBeNull();
    expect(raw!.length).toBeLessThan(200 * 1024); // < 200KB, was ~2.2MB
    const parsed = JSON.parse(raw!) as { state?: { sessions?: Array<{ firstMessage?: string }> } };
    const sessions = parsed.state?.sessions ?? [];
    expect(sessions.length).toBeLessThanOrEqual(200);
    expect(sessions.every((s) => (s.firstMessage ?? '').length <= 160)).toBe(true);
  });

  it('stringifies at most once per throttle window even under rapid set() storms', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    // Rapid storm of unrelated store updates (e.g. broadcast traffic).
    for (let i = 0; i < 20; i++) {
      useSessionStore.setState({ isLoading: i % 2 === 0 });
    }
    const writesDuringStorm = setItemSpy.mock.calls.filter((c) => c[0] === 'pi-web-ui-session').length;
    expect(writesDuringStorm).toBe(0); // no synchronous stringify/write per set()
    vi.advanceTimersByTime(1100);
    const writesAfterFlush = setItemSpy.mock.calls.filter((c) => c[0] === 'pi-web-ui-session').length;
    expect(writesAfterFlush).toBe(1); // exactly one lazy stringify at flush
    // Continuous traffic must not starve the flush: keep setting AFTER the
    // first flush window opened; a second write still happens a second later.
    for (let i = 0; i < 20; i++) {
      useSessionStore.setState({ isLoading: i % 2 === 0 });
    }
    vi.advanceTimersByTime(1100);
    const writesAfterSecondWindow = setItemSpy.mock.calls.filter((c) => c[0] === 'pi-web-ui-session').length;
    expect(writesAfterSecondWindow).toBe(2);
    setItemSpy.mockRestore();
  });
});

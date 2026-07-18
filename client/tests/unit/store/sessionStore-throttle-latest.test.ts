import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sessionStore throttled persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    localStorage.clear();
  });

  it('persists the latest metadata snapshot from a throttled burst', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.resetModules();
    const { useSessionStore } = await import('../../../src/store/sessionStore');

    useSessionStore.setState({
      sessionMeta: {
        'pi:session-1': { displayName: 'First', legacyKey: '/session-1', updatedAt: 1 },
      },
    });
    useSessionStore.setState({
      sessionMeta: {
        'pi:session-1': { displayName: 'Latest', legacyKey: '/session-1', updatedAt: 2 },
      },
    });

    await vi.advanceTimersByTimeAsync(1_100);

    const persisted = JSON.parse(localStorage.getItem('pi-web-ui-session') ?? '{}');
    expect(persisted.state?.sessionMeta?.['pi:session-1']?.displayName).toBe('Latest');
  });
});

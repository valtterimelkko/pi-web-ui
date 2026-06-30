import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionStore } from '../../../src/store/sessionStore';
import type { Session } from '../../../src/store/sessionStore';

// Fake WS singleton returned by the mocked getWebSocketClient().
const fakeClient = {
  status: 'connected' as string,
  sent: [] as unknown[],
  getStatus() {
    return this.status;
  },
  send(msg: unknown) {
    this.sent.push(msg);
    return true;
  },
};

vi.mock('../../../src/lib/websocket', () => ({
  getWebSocketClient: () => fakeClient,
}));

import { useDeepLinkSession } from '../../../src/hooks/useDeepLinkSession';

function setLocation(pathAndSearch: string): void {
  window.history.replaceState({}, '', pathAndSearch);
}

function session(partial: Partial<Session>): Session {
  return {
    id: 's1',
    path: '/p/s1',
    sdkType: 'pi',
    firstMessage: '',
    messageCount: 0,
    cwd: '',
    name: undefined,
    createdAt: '',
    lastActivity: '',
    ...partial,
  } as Session;
}

describe('useDeepLinkSession', () => {
  beforeEach(() => {
    fakeClient.status = 'connected';
    fakeClient.sent = [];
    useSessionStore.setState({ sessions: [], currentSessionId: null });
    useSessionStore.setState({ isSwitchingSession: false, switchingToSessionId: null });
    setLocation('/');
  });

  it('switches to the session named by ?session=<id> once the list has loaded', () => {
    setLocation('/?session=s-target');
    const { rerender } = renderHook(() => useDeepLinkSession());
    // List not loaded yet → no switch.
    expect(fakeClient.sent).toHaveLength(0);
    useSessionStore.setState({ sessions: [session({ id: 's-target', path: '/p/target' })] });
    rerender();
    expect(fakeClient.sent).toEqual([{ type: 'switch_session', sessionPath: '/p/target' }]);
    expect(useSessionStore.getState().switchingToSessionId).toBe('s-target');
    expect(useSessionStore.getState().isSwitchingSession).toBe(true);
  });

  it('strips the ?session param from the URL after reading it (keeps other params)', () => {
    setLocation('/?session=s-target&foo=bar#sec');
    renderHook(() => useDeepLinkSession());
    expect(window.location.search).toBe('?foo=bar');
    expect(window.location.hash).toBe('#sec');
  });

  it('does nothing when there is no ?session param', () => {
    setLocation('/');
    renderHook(() => useDeepLinkSession());
    useSessionStore.setState({ sessions: [session({ id: 'x', path: '/p' })] });
    expect(fakeClient.sent).toHaveLength(0);
  });

  it('ignores an id that is not present in the loaded session list', () => {
    setLocation('/?session=unknown');
    const { rerender } = renderHook(() => useDeepLinkSession());
    useSessionStore.setState({ sessions: [session({ id: 'other', path: '/p' })] });
    rerender();
    expect(fakeClient.sent).toHaveLength(0);
  });

  it('does not re-switch when the target is already the active session', () => {
    setLocation('/?session=s-target');
    useSessionStore.setState({ currentSessionId: 's-target' });
    const { rerender } = renderHook(() => useDeepLinkSession());
    useSessionStore.setState({ sessions: [session({ id: 's-target', path: '/p' })] });
    rerender();
    expect(fakeClient.sent).toHaveLength(0);
  });

  it('switches only once even if the session list updates again afterwards', () => {
    setLocation('/?session=s-target');
    const { rerender } = renderHook(() => useDeepLinkSession());
    useSessionStore.setState({ sessions: [session({ id: 's-target', path: '/p/target' })] });
    rerender();
    useSessionStore.setState({ sessions: [session({ id: 's-target', path: '/p/target' })] });
    rerender();
    expect(fakeClient.sent).toHaveLength(1);
  });

  it('waits for the WebSocket to be connected before sending', () => {
    setLocation('/?session=s-target');
    fakeClient.status = 'connecting';
    const { rerender } = renderHook(() => useDeepLinkSession());
    useSessionStore.setState({ sessions: [session({ id: 's-target', path: '/p/target' })] });
    rerender();
    // Not connected yet → no send.
    expect(fakeClient.sent).toHaveLength(0);
    // WS connects + a fresh session-list response arrives → send now.
    fakeClient.status = 'connected';
    useSessionStore.setState({ sessions: [session({ id: 's-target', path: '/p/target' })] });
    rerender();
    expect(fakeClient.sent).toHaveLength(1);
  });
});

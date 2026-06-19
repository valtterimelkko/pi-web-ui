import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';
import { useUIStore } from '../../../src/store/uiStore';

describe('extension UI state', () => {
  beforeEach(() => {
    useSessionStore.setState({
      extensionWidgets: {},
      extensionStatuses: {},
      currentSessionId: 'session-1',
      currentSessionSdkType: 'pi',
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,
    } as Partial<ReturnType<typeof useSessionStore.getState>>);
  });

  it('stores extension widget content by key', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'widget_content',
      sessionId: 'session-1',
      key: 'goal-engine-status',
      content: ['Goal Status', 'Status: ▶ Running'],
    });

    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toEqual([
      'Goal Status',
      'Status: ▶ Running',
    ]);
  });

  it('clears extension widget content by key', () => {
    useSessionStore.setState({
      extensionWidgets: {
        'goal-engine-status': ['Goal Status'],
        other: ['Keep me'],
      },
      sessionExtensionWidgets: {
        'session-1': {
          'goal-engine-status': ['Goal Status'],
          other: ['Keep me'],
        },
      },
    } as Partial<ReturnType<typeof useSessionStore.getState>>);

    useSessionStore.getState().handleServerMessage({
      type: 'widget_cleared',
      sessionId: 'session-1',
      key: 'goal-engine-status',
    });

    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toBeUndefined();
    expect(useSessionStore.getState().extensionWidgets.other).toEqual(['Keep me']);
  });

  it('stores and clears extension status text by key', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'extension_status',
      sessionId: 'session-1',
      status: { key: 'goal-engine', text: 'running' },
    });

    expect(useSessionStore.getState().extensionStatuses['goal-engine']).toBe('running');

    useSessionStore.getState().handleServerMessage({
      type: 'extension_status',
      sessionId: 'session-1',
      status: { key: 'goal-engine', text: undefined },
    });

    expect(useSessionStore.getState().extensionStatuses['goal-engine']).toBeUndefined();
  });

  it('keeps extension UI state scoped to the owning session and rehydrates on switch', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'widget_content',
      sessionId: 'session-2',
      key: 'goal-engine-status',
      content: ['Goal Status', 'Status: ▶ Running'],
    });
    useSessionStore.getState().handleServerMessage({
      type: 'extension_status',
      sessionId: 'session-2',
      status: { key: 'goal-engine', text: 'running' },
    });

    expect(useSessionStore.getState().extensionWidgets).toEqual({});
    expect(useSessionStore.getState().extensionStatuses).toEqual({});

    useSessionStore.getState().handleServerMessage({
      type: 'session_switched',
      sessionId: 'session-2',
      sdkType: 'pi',
      model: 'test-model',
      messages: [],
      fileTimestamp: 0,
      isStreaming: false,
    });

    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toEqual([
      'Goal Status',
      'Status: ▶ Running',
    ]);
    expect(useSessionStore.getState().extensionStatuses['goal-engine']).toBe('running');
  });

  // OpenCode/Pi goal-engine events arrive wrapped in a `session_event` envelope
  // (server applies normEventToPiFormat → spread fields). The store must unwrap
  // them so the live goal tag / widget reflect goal state for OpenCode sessions.
  it('handles widget_content wrapped in a session_event envelope', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'session_event',
      sessionId: 'session-1',
      event: {
        type: 'widget_content',
        key: 'goal-engine-status',
        content: ['🎯 Goal Status', 'Status: ▶ Running'],
      },
    });

    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toEqual([
      '🎯 Goal Status',
      'Status: ▶ Running',
    ]);
  });

  it('handles extension_status wrapped in a session_event envelope', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'session_event',
      sessionId: 'session-1',
      event: {
        type: 'extension_status',
        status: { key: 'goal-engine', text: '🎯 ▶ Running — Run 4' },
      },
    });

    expect(useSessionStore.getState().extensionStatuses['goal-engine']).toBe('🎯 ▶ Running — Run 4');
  });

  it('handles widget_cleared wrapped in a session_event envelope', () => {
    useSessionStore.setState({
      extensionWidgets: { 'goal-engine-status': ['🎯 Goal Status'] },
      sessionExtensionWidgets: { 'session-1': { 'goal-engine-status': ['🎯 Goal Status'] } },
    } as Partial<ReturnType<typeof useSessionStore.getState>>);

    useSessionStore.getState().handleServerMessage({
      type: 'session_event',
      sessionId: 'session-1',
      event: { type: 'widget_cleared', key: 'goal-engine-status' },
    });

    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toBeUndefined();
  });

  it('only shows session-scoped notifications for the active session', () => {
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    useSessionStore.getState().handleServerMessage({
      type: 'notification',
      sessionId: 'session-2',
      notification: { message: 'Hidden from another session', type: 'info' },
    });
    expect(addToast).not.toHaveBeenCalled();

    useSessionStore.getState().handleServerMessage({
      type: 'notification',
      sessionId: 'session-1',
      notification: { message: 'Visible in current session', type: 'info' },
    });
    expect(addToast).toHaveBeenCalledWith({
      type: 'info',
      message: 'Visible in current session',
    });

    addToast.mockRestore();
  });
});

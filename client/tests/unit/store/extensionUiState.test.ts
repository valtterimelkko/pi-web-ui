import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';

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
    } as Partial<ReturnType<typeof useSessionStore.getState>>);

    useSessionStore.getState().handleServerMessage({
      type: 'widget_cleared',
      key: 'goal-engine-status',
    });

    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toBeUndefined();
    expect(useSessionStore.getState().extensionWidgets.other).toEqual(['Keep me']);
  });

  it('stores and clears extension status text by key', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'extension_status',
      status: { key: 'goal-engine', text: 'running' },
    });

    expect(useSessionStore.getState().extensionStatuses['goal-engine']).toBe('running');

    useSessionStore.getState().handleServerMessage({
      type: 'extension_status',
      status: { key: 'goal-engine', text: undefined },
    });

    expect(useSessionStore.getState().extensionStatuses['goal-engine']).toBeUndefined();
  });
});

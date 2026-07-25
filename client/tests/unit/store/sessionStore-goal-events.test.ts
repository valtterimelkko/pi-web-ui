import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../../src/store/sessionStore';
import { useGoalStore } from '../../../src/store/goalStore';
import { useUIStore } from '../../../src/store/uiStore';

const GOAL_WIDGET = [
  '🎯 Goal Status',
  'Status: ▶ Running',
  'Objective: Create three files',
  'Agent runs: 1',
  'Continuation interval: 30s (rung 1/4)',
];

describe('sessionStore → goal history wiring', () => {
  beforeEach(() => {
    useGoalStore.setState({ bySession: {} });
    useUIStore.setState({ toasts: [], notificationLog: [] } as Partial<ReturnType<typeof useUIStore.getState>>);
    useSessionStore.setState({
      extensionWidgets: {},
      extensionStatuses: {},
      sessionExtensionWidgets: {},
      sessionExtensionStatuses: {},
      currentSessionId: 'session-1',
      currentSessionSdkType: 'pi',
      messages: [],
      isStreaming: false,
    } as Partial<ReturnType<typeof useSessionStore.getState>>);
  });

  it('feeds goal widget payloads into the goal history store', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'widget_content',
      sessionId: 'session-1',
      key: 'goal-engine-status',
      content: GOAL_WIDGET,
    });

    const view = useGoalStore.getState().getGoalView('session-1');
    expect(view.current?.model.objective).toBe('Create three files');
    // The raw widget is still stored, so non-goal consumers are unaffected.
    expect(useSessionStore.getState().extensionWidgets['goal-engine-status']).toEqual(GOAL_WIDGET);
  });

  it('leaves other extension widgets out of goal history', () => {
    useSessionStore.getState().handleServerMessage({
      type: 'widget_content',
      sessionId: 'session-1',
      key: 'some-other-extension',
      content: ['hello'],
    });

    expect(useGoalStore.getState().getGoalView('session-1').current).toBeNull();
  });

  it('archives the goal when the extension clears its status', () => {
    const store = useSessionStore.getState();
    store.handleServerMessage({
      type: 'widget_content', sessionId: 'session-1', key: 'goal-engine-status', content: GOAL_WIDGET,
    });
    store.handleServerMessage({
      type: 'widget_cleared', sessionId: 'session-1', key: 'goal-engine-status',
    });
    store.handleServerMessage({
      type: 'extension_status', sessionId: 'session-1', status: { key: 'goal-engine' },
    });

    const view = useGoalStore.getState().getGoalView('session-1');
    expect(view.current).toBeNull();
    expect(view.history).toHaveLength(1);
  });

  it('labels the archived goal from the completion notification', () => {
    const store = useSessionStore.getState();
    store.handleServerMessage({
      type: 'widget_content', sessionId: 'session-1', key: 'goal-engine-status', content: GOAL_WIDGET,
    });
    store.handleServerMessage({
      type: 'extension_status', sessionId: 'session-1', status: { key: 'goal-engine' },
    });
    store.handleServerMessage({
      type: 'notification',
      sessionId: 'session-1',
      notification: { message: '🎯 Goal achieved in 2 agent runs: "Create three files…"', type: 'info' },
    });

    const [record] = useGoalStore.getState().getGoalView('session-1').history;
    expect(record.outcome).toBe('achieved');
    expect(record.outcomeRuns).toBe(2);
  });

  it('records goal events for a background session without touching the viewed one', () => {
    const store = useSessionStore.getState();
    store.handleServerMessage({
      type: 'widget_content', sessionId: 'session-2', key: 'goal-engine-status', content: GOAL_WIDGET,
    });

    expect(useGoalStore.getState().getGoalView('session-2').current).not.toBeNull();
    expect(useGoalStore.getState().getGoalView('session-1').current).toBeNull();
  });

  it('keeps every notification in the session tray', () => {
    const store = useSessionStore.getState();
    store.handleServerMessage({
      type: 'notification',
      sessionId: 'session-1',
      notification: { message: '🎯 Goal Report\nStatus: Idle\nAgent runs: 2', type: 'info' },
    });

    const entries = useUIStore.getState().notificationLog;
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain('Goal Report');
    expect(entries[0].sessionId).toBe('session-1');
  });
});

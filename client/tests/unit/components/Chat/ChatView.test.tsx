import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useSessionStore } from '../../../../src/store/sessionStore';
import { useNavigationStore } from '../../../../src/store/navigationStore';
import { useUIStore } from '../../../../src/store/uiStore';
import { ChatView } from '../../../../src/components/Chat/ChatView';

const { sendPrompt, goalControl, createNewSession } = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  goalControl: vi.fn(),
  createNewSession: vi.fn(),
}));

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendPrompt, goalControl, createNewSession }),
}));
vi.mock('../../../../src/hooks/useDictation', () => ({
  useDictation: () => ({ state: 'idle', toggle: vi.fn(), errorMessage: null }),
}));
vi.mock('../../../../src/components/Chat/VirtualizedMessageList', async () => {
  const React = await import('react');
  return { VirtualizedMessageList: React.forwardRef(() => <div data-testid="message-list" />) };
});
vi.mock('../../../../src/components/Chat/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));
vi.mock('../../../../src/components/Tree', () => ({ TreeView: () => null }));
vi.mock('../../../../src/components/Session', () => ({ NewSessionModal: () => null }));
vi.mock('../../../../src/components/StatusBar/SessionInfoModal', () => ({ SessionInfoModal: () => null }));

function setGoalSession(sdkType: 'pi' | 'opencode' | 'claude', status: string) {
  useSessionStore.setState({
    messages: [],
    isStreaming: false,
    isLoading: false,
    currentSessionId: 'session-1',
    currentSessionSdkType: sdkType,
    extensionWidgets: {},
    extensionStatuses: { 'goal-engine': status },
  });
}

describe('ChatView Pi goal controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNavigationStore.setState({ bottomNavCollapsed: true });
    useUIStore.setState({ sessionInfoOpen: false, treeViewOpen: false });
    setGoalSession('pi', '🎯 ▶ Running — Run 2');
  });

  it('routes Pi pause, resume, and confirmed clear buttons through slash commands', () => {
    render(<ChatView />);

    fireEvent.click(screen.getByTestId('goal-pause'));
    expect(sendPrompt).toHaveBeenLastCalledWith('/goal pause-now');
    expect(goalControl).not.toHaveBeenCalled();

    act(() => {
      useSessionStore.setState({ extensionStatuses: { 'goal-engine': '🎯 ⏸ Paused — Run 2' } });
    });
    fireEvent.click(screen.getByTestId('goal-resume'));
    expect(sendPrompt).toHaveBeenLastCalledWith('/goal resume');

    fireEvent.click(screen.getByTestId('goal-clear'));
    fireEvent.click(screen.getByTestId('goal-clear-confirm'));
    expect(sendPrompt).toHaveBeenLastCalledWith('/goal clear');
  });

  it('keeps OpenCode controls on the server goal-control path', () => {
    setGoalSession('opencode', '🎯 ▶ Running — Run 1');
    render(<ChatView />);

    fireEvent.click(screen.getByTestId('goal-pause'));

    expect(goalControl).toHaveBeenCalledWith('session-1', 'pause');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('does not render controls for runtimes without goal-control support', () => {
    setGoalSession('claude', '🎯 ▶ Running — Run 1');
    render(<ChatView />);

    expect(screen.getByTestId('goal-tag')).toBeTruthy();
    expect(screen.queryByTestId('goal-controls')).toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ClaudeStreamHeartbeat } from '../../../../src/components/Chat/ClaudeStreamHeartbeat';
import { useSessionStore } from '../../../../src/store';

const { addToast: mockAddToast } = vi.hoisted(() => ({ addToast: vi.fn() }));

vi.mock('../../../../src/store/uiStore', () => ({
  useUIStore: {
    getState: () => ({ addToast: mockAddToast }),
  },
}));

describe('ClaudeStreamHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSessionStore.setState({
      isStreaming: false,
      currentSessionSdkType: null,
      lastStreamEventAt: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when not streaming', () => {
    useSessionStore.setState({
      isStreaming: false,
      currentSessionSdkType: 'claude',
      lastStreamEventAt: Date.now(),
    });
    const { container } = render(<ClaudeStreamHeartbeat />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for non-claude sessions', () => {
    useSessionStore.setState({
      isStreaming: true,
      currentSessionSdkType: 'pi',
      lastStreamEventAt: Date.now(),
    });
    const { container } = render(<ClaudeStreamHeartbeat />);
    expect(container.innerHTML).toBe('');
  });

  it('shows Thinking... when streaming with recent events', () => {
    useSessionStore.setState({
      isStreaming: true,
      currentSessionSdkType: 'claude',
      lastStreamEventAt: Date.now(),
    });
    render(<ClaudeStreamHeartbeat />);
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('shows Working... after stale threshold', () => {
    const fiveSecondsAgo = Date.now() - 6000;
    useSessionStore.setState({
      isStreaming: true,
      currentSessionSdkType: 'claude',
      lastStreamEventAt: fiveSecondsAgo,
    });
    render(<ClaudeStreamHeartbeat />);

    act(() => { vi.advanceTimersByTime(1000); });

    expect(screen.getByText(/Working\./)).toBeInTheDocument();
  });

  it('returns to Thinking... when new events arrive', () => {
    useSessionStore.setState({
      isStreaming: true,
      currentSessionSdkType: 'claude',
      lastStreamEventAt: Date.now() - 8000,
    });
    render(<ClaudeStreamHeartbeat />);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/Working\./)).toBeInTheDocument();

    act(() => {
      useSessionStore.setState({ lastStreamEventAt: Date.now() });
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('clears when streaming stops', () => {
    useSessionStore.setState({
      isStreaming: true,
      currentSessionSdkType: 'claude',
      lastStreamEventAt: Date.now(),
    });
    const { container } = render(<ClaudeStreamHeartbeat />);
    expect(screen.getByText('Thinking...')).toBeInTheDocument();

    act(() => {
      useSessionStore.setState({ isStreaming: false });
      vi.advanceTimersByTime(1000);
    });
    expect(container.innerHTML).toBe('');
  });

  describe('compact mode', () => {
    it('renders nothing in compact mode when not stale', () => {
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        lastStreamEventAt: Date.now(),
      });
      const { container } = render(<ClaudeStreamHeartbeat compact />);
      expect(container.innerHTML).toBe('');
    });

    it('shows Working... in compact mode when stale', () => {
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        lastStreamEventAt: Date.now() - 6000,
      });
      render(<ClaudeStreamHeartbeat compact />);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText(/Working\./)).toBeInTheDocument();
    });
  });

  describe('tool name display', () => {
    it('shows tool name in Thinking state when currentToolName is set', () => {
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        currentToolName: 'Bash',
        lastStreamEventAt: Date.now(),
      });
      render(<ClaudeStreamHeartbeat />);
      expect(screen.getByText('Running Bash...')).toBeInTheDocument();
    });

    it('shows tool name in Working state when stale with currentToolName', () => {
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        currentToolName: 'Bash',
        lastStreamEventAt: Date.now() - 6000,
      });
      render(<ClaudeStreamHeartbeat />);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByText(/Running Bash\./)).toBeInTheDocument();
    });

    it('shows Thinking... when currentToolName is null', () => {
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        currentToolName: null,
        lastStreamEventAt: Date.now(),
      });
      render(<ClaudeStreamHeartbeat />);
      expect(screen.getByText('Thinking...')).toBeInTheDocument();
    });
  });

  describe('slow prompt warning', () => {
    it('shows warning toast when promptStartedAt is 60s+ ago with no events', () => {
      mockAddToast.mockClear();
      const sixtySecAgo = Date.now() - 61000;
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        promptStartedAt: sixtySecAgo,
        lastStreamEventAt: sixtySecAgo,
      });

      render(<ClaudeStreamHeartbeat />);
      act(() => { vi.advanceTimersByTime(1000); });

      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringContaining('hasn\'t responded'),
        }),
      );
    });

    it('does not warn when prompt is old but stream activity is fresh', () => {
      mockAddToast.mockClear();
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        promptStartedAt: Date.now() - 61000,
        lastStreamEventAt: Date.now(),
      });

      render(<ClaudeStreamHeartbeat />);
      act(() => { vi.advanceTimersByTime(1000); });

      expect(mockAddToast).not.toHaveBeenCalled();
    });

    it('does not warn when prompt is recent', () => {
      mockAddToast.mockClear();
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        promptStartedAt: Date.now(),
        lastStreamEventAt: Date.now(),
      });

      render(<ClaudeStreamHeartbeat />);
      // With fake timers, the setTimeout is scheduled at Time(0)+remaining.
      // Since prompt started at Time(0), remaining = 60000ms. Advance 59s
      // — warning should NOT have fired yet.
      act(() => { vi.advanceTimersByTime(59000); });
      expect(mockAddToast).not.toHaveBeenCalled();
    });

    it('resets warning state when streaming stops', () => {
      mockAddToast.mockClear();
      useSessionStore.setState({
        isStreaming: true,
        currentSessionSdkType: 'claude',
        promptStartedAt: Date.now() - 61000,
        lastStreamEventAt: Date.now() - 61000,
      });

      const { unmount } = render(<ClaudeStreamHeartbeat />);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(mockAddToast).toHaveBeenCalledTimes(1);

      // Stop streaming → should clear warning state
      act(() => {
        useSessionStore.setState({ isStreaming: false, promptStartedAt: null });
        vi.advanceTimersByTime(1000);
      });

      // Start streaming again with old promptStartedAt → should warn again
      mockAddToast.mockClear();
      act(() => {
        useSessionStore.setState({
          isStreaming: true,
          currentSessionSdkType: 'claude',
          promptStartedAt: Date.now() - 61000,
          lastStreamEventAt: Date.now() - 61000,
        });
        vi.advanceTimersByTime(1000);
      });
      expect(mockAddToast).toHaveBeenCalledTimes(1);

      unmount();
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ClaudeStreamHeartbeat } from '../../../../src/components/Chat/ClaudeStreamHeartbeat';
import { useSessionStore } from '../../../../src/store';

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
});

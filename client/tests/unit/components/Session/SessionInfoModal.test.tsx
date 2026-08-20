import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionInfoModal } from '../../../../src/components/StatusBar/SessionInfoModal';
import { useSessionStore } from '../../../../src/store/sessionStore';

/** Command Code session_info stats as the fixed server sends them. */
function commandCodeStats(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'commandcode-abc123',
    nativeSessionId: '4f2b4e87-f783-4244-b4ed-d1f2858eb765',
    sessionFile: '/root/.pi-web-ui/command-code/events/commandcode-abc123.jsonl',
    cwd: '/tmp/work',
    userMessages: 2,
    assistantMessages: 2,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 4,
    tokens: { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, total: 18 },
    model: 'qwen/qwen3.8-max',
    ...overrides,
  };
}

describe('SessionInfoModal — Command Code sessions', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionInfo: null,
      currentSessionId: 'commandcode-abc123',
      currentSessionSdkType: 'commandcode',
      sessionData: {},
    });
  });

  it('renders the Command Code runtime badge instead of the Pi SDK fallback', () => {
    useSessionStore.setState({ sessionInfo: commandCodeStats() });
    render(<SessionInfoModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText('CMD')).toBeInTheDocument();
    expect(screen.queryByText('Pi SDK')).not.toBeInTheDocument();
  });

  it('shows tokens, journal file, native session id, and model', () => {
    useSessionStore.setState({ sessionInfo: commandCodeStats() });
    render(<SessionInfoModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText(/commandcode-abc123\.jsonl/)).toBeInTheDocument();
    expect(screen.getByText(/4f2b4e87-f783-4244-b4ed-d1f2858eb765/)).toBeInTheDocument();
    expect(screen.getByText('qwen/qwen3.8-max')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('does not crash when the server omits tokens or cost (legacy shape)', () => {
    useSessionStore.setState({
      sessionInfo: commandCodeStats({ tokens: undefined, cost: undefined }),
    });
    render(<SessionInfoModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText(/Session ID: commandcode-abc123/)).toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeSessionPicker } from '../../../../src/components/DriveMode/DriveModeSessionPicker';
import { useSessionStore } from '../../../../src/store/sessionStore';

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

describe('DriveModeSessionPicker', () => {
  const mockOnBack = vi.fn();
  const mockOnSelectSession = vi.fn();

  const mockSessions = [
    { id: 's1', path: '/path/1.jsonl', name: 'Session One', model: 'claude-3-opus', sdkType: 'pi' as const, firstMessage: 'Hello one', messageCount: 2, cwd: '/' },
    { id: 's2', path: '/path/2.jsonl', name: 'Session Two', model: 'gpt-4', sdkType: 'opencode' as const, firstMessage: 'Hello two', messageCount: 3, cwd: '/' },
    { id: 's3', path: '/path/3.jsonl', name: 'Archived Session', model: 'gpt-3.5', sdkType: 'claude' as const, firstMessage: 'Hello three', messageCount: 1, cwd: '/' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        sessions: mockSessions,
        archivedSessionPaths: ['/path/3.jsonl'],
        currentSessionId: 's1',
        getSessionDisplayName: () => undefined,
      };
      return selector ? selector(state) : state;
    });
  });

  it('renders session list from store', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    expect(screen.getByText('Session One')).toBeInTheDocument();
    expect(screen.getByText('Session Two')).toBeInTheDocument();
  });

  it('filters out archived sessions', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument();
  });

  it('shows session display name', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    expect(screen.getByText('Session One')).toBeInTheDocument();
    expect(screen.getByText('Session Two')).toBeInTheDocument();
  });

  it('prefers custom web UI display name over session.name', () => {
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        sessions: mockSessions,
        archivedSessionPaths: ['/path/3.jsonl'],
        currentSessionId: 's1',
        getSessionDisplayName: (path: string) => {
          if (path === '/path/2.jsonl') return 'My Custom OpenCode Session';
          return undefined;
        },
      };
      return selector ? selector(state) : state;
    });

    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    // s2 has a custom display name 'My Custom OpenCode Session'
    expect(screen.getByText('My Custom OpenCode Session')).toBeInTheDocument();
    // The original session.name 'Session Two' should NOT appear
    expect(screen.queryByText('Session Two')).not.toBeInTheDocument();
  });

  it('shows model name per session', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    expect(screen.getByText('claude-3-opus')).toBeInTheDocument();
    expect(screen.getByText('gpt-4')).toBeInTheDocument();
  });

  it('shows SDK badge per session', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    expect(screen.getByText('Pi')).toBeInTheDocument();
    expect(screen.getByText('OC')).toBeInTheDocument();
  });

  it('highlights current session', () => {
    const { container } = render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    const buttons = container.querySelectorAll('button');
    const currentButton = Array.from(buttons).find((b) => b.textContent?.includes('Session One'));
    expect(currentButton?.className).toContain('border-l-blue-500');
  });

  it('shows empty state when no sessions', () => {
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        sessions: [],
        archivedSessionPaths: [],
        currentSessionId: null,
      };
      return selector ? selector(state) : state;
    });

    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    expect(screen.getByText(/No active sessions/i)).toBeInTheDocument();
  });

  it('clicking a session calls onSelectSession with correct id and path', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    fireEvent.click(screen.getByText('Session Two'));
    expect(mockOnSelectSession).toHaveBeenCalledWith('s2', '/path/2.jsonl');
  });

  it('clicking "Back" calls onBack', () => {
    render(<DriveModeSessionPicker onBack={mockOnBack} onSelectSession={mockOnSelectSession} />);
    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeEntry } from '../../../../src/components/DriveMode/DriveModeEntry';
import { useSessionStore } from '../../../../src/store/sessionStore';

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

describe('DriveModeEntry', () => {
  const mockOnNewSession = vi.fn();
  const mockOnContinueSession = vi.fn();
  const mockOnExit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        sessions: [],
      };
      return selector ? selector(state) : state;
    });
  });

  it('renders "New Session" button', () => {
    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    expect(screen.getByText('New Session')).toBeInTheDocument();
  });

  it('renders "Continue Session" button', () => {
    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    expect(screen.getByText('Continue Session')).toBeInTheDocument();
  });

  it('renders "Exit Drive Mode" button', () => {
    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    expect(screen.getByText('Exit Drive Mode')).toBeInTheDocument();
  });

  it('clicking "New Session" calls onNewSession', () => {
    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    fireEvent.click(screen.getByText('New Session'));
    expect(mockOnNewSession).toHaveBeenCalled();
  });

  it('clicking "Continue Session" calls onContinueSession', () => {
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        sessions: [{ id: '1', path: '/test' }],
      };
      return selector ? selector(state) : state;
    });

    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    fireEvent.click(screen.getByText('Continue Session'));
    expect(mockOnContinueSession).toHaveBeenCalled();
  });

  it('"Continue Session" is disabled when no sessions exist', () => {
    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    const button = screen.getByText('Continue Session') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('"Continue Session" is enabled when sessions exist', () => {
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        sessions: [{ id: '1', path: '/test' }],
      };
      return selector ? selector(state) : state;
    });

    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    const button = screen.getByText('Continue Session') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('has correct aria-labels', () => {
    render(
      <DriveModeEntry
        onNewSession={mockOnNewSession}
        onContinueSession={mockOnContinueSession}
        onExit={mockOnExit}
      />
    );
    expect(screen.getByLabelText('Start a new session')).toBeInTheDocument();
    expect(screen.getByLabelText('Continue an existing session')).toBeInTheDocument();
  });
});

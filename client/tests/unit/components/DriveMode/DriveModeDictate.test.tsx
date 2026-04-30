import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { useDriveModeDictation } from '../../../../src/hooks/useDriveModeDictation';
import { useReadAloud } from '../../../../src/hooks/useReadAloud';
import { useSessionStore } from '../../../../src/store/sessionStore';
import { useDriveModeStore } from '../../../../src/store/driveModeStore';

vi.mock('../../../../src/hooks/useDriveModeDictation', () => ({
  useDriveModeDictation: vi.fn(),
}));

vi.mock('../../../../src/hooks/useReadAloud', () => ({
  useReadAloud: vi.fn(),
  stopCurrentAudio: vi.fn(),
}));

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

vi.mock('../../../../src/store/driveModeStore', () => ({
  useDriveModeStore: vi.fn(),
}));

vi.mock('lucide-react', () => ({
  Mic: () => <span data-testid="mic-icon">Mic</span>,
  MicOff: () => <span data-testid="mic-off-icon">MicOff</span>,
}));

describe('DriveModeDictate', () => {
  const mockToggle = vi.fn();
  const mockPlay = vi.fn();
  const mockStop = vi.fn();
  const mockToggleSpeed = vi.fn();
  const mockSetPhase = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useDriveModeDictation as ReturnType<typeof vi.fn>).mockReturnValue({
      state: 'idle',
      errorMessage: '',
      toggle: mockToggle,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    });
    (useReadAloud as ReturnType<typeof vi.fn>).mockReturnValue({
      state: 'idle',
      play: mockPlay,
      stop: mockStop,
      speedEnabled: false,
      toggleSpeed: mockToggleSpeed,
    });
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        isStreaming: false,
        messages: [],
      };
      return selector ? selector(state) : state;
    });
    (useDriveModeStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        phase: 'dictate',
        setPhase: mockSetPhase,
      };
      return selector ? selector(state) : state;
    });
    // Mock navigator.vibrate
    Object.defineProperty(navigator, 'vibrate', {
      writable: true,
      value: vi.fn(),
    });
  });

  it('mic button renders large circular button', () => {
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    const micButton = screen.getByLabelText('Start recording');
    expect(micButton).toBeInTheDocument();
    expect(micButton.className).toContain('rounded-full');
  });

  it('shows "Tap to speak" when idle', () => {
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('Tap to speak')).toBeInTheDocument();
  });

  it('shows "Listening..." when recording', () => {
    (useDriveModeDictation as ReturnType<typeof vi.fn>).mockReturnValue({
      state: 'recording',
      errorMessage: '',
      toggle: mockToggle,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    });
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('Listening...')).toBeInTheDocument();
  });

  it('shows "Processing..." when processing', () => {
    (useDriveModeDictation as ReturnType<typeof vi.fn>).mockReturnValue({
      state: 'processing',
      errorMessage: '',
      toggle: mockToggle,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    });
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('Processing...')).toBeInTheDocument();
  });

  it('clicking calls toggle on dictation hook', () => {
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Start recording'));
    expect(mockToggle).toHaveBeenCalled();
  });

  it('shows error message when in error state', () => {
    (useDriveModeDictation as ReturnType<typeof vi.fn>).mockReturnValue({
      state: 'error',
      errorMessage: 'Microphone permission denied.',
      toggle: mockToggle,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
    });
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('Microphone permission denied.')).toBeInTheDocument();
  });

  it('status text updates per phase', () => {
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('Tap to speak')).toBeInTheDocument();
  });

  it('read aloud button not visible in dictate phase', () => {
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.queryByText('🔊 Read Aloud')).not.toBeInTheDocument();
  });

  it('read aloud button not visible in agent-working phase', () => {
    (useDriveModeStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        phase: 'agent-working',
        setPhase: mockSetPhase,
      };
      return selector ? selector(state) : state;
    });
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.queryByText('🔊 Read Aloud')).not.toBeInTheDocument();
  });

  it('read aloud button visible in read-aloud-ready phase', () => {
    (useDriveModeStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        phase: 'read-aloud-ready',
        setPhase: mockSetPhase,
      };
      return selector ? selector(state) : state;
    });
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        isStreaming: false,
        messages: [
          { id: '1', role: 'assistant', content: 'Hello there', timestamp: Date.now() },
        ],
      };
      return selector ? selector(state) : state;
    });
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('🔊 Read Aloud')).toBeInTheDocument();
  });

  it('speed toggle visible when read aloud is visible', () => {
    (useDriveModeStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        phase: 'read-aloud-ready',
        setPhase: mockSetPhase,
      };
      return selector ? selector(state) : state;
    });
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (state: unknown) => unknown) => {
      const state = {
        isStreaming: false,
        messages: [
          { id: '1', role: 'assistant', content: 'Hello there', timestamp: Date.now() },
        ],
      };
      return selector ? selector(state) : state;
    });
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={vi.fn()} />);
    expect(screen.getByText('1x')).toBeInTheDocument();
  });

  it('exit button calls onExit', () => {
    const mockOnExit = vi.fn();
    render(<DriveModeDictate sessionId="s1" modelName="test-model" sessionDisplayName="Test" onExit={mockOnExit} />);
    fireEvent.click(screen.getByText('✕ Exit'));
    expect(mockOnExit).toHaveBeenCalled();
  });
});

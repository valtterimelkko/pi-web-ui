import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionStatusIndicator } from '../../../../src/components/Sidebar/SessionStatusIndicator';

// Type for the session data that will be used by the component
interface SessionData {
  status: 'idle' | 'streaming' | 'busy' | 'error';
  currentStep: number;
  lastEventTimestamp?: number;
  contextPercent?: number;
  messages?: unknown[];
}

// Mock store state that can be modified per test
let mockSessionData: Record<string, SessionData> = {};

// Mock the useSessionStore hook
vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector?: (state: { sessionData: Record<string, SessionData> }) => unknown) => {
    const state = { sessionData: mockSessionData };
    return selector ? selector(state) : state;
  }),
}));

describe('SessionStatusIndicator', () => {
  beforeEach(() => {
    // Reset mock session data before each test
    mockSessionData = {};
    vi.clearAllMocks();
  });

  describe('rendering states', () => {
    it('should render idle status with green dot', () => {
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 0,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should find the status dot with emerald (green) background
      const dot = document.querySelector('.bg-emerald-400');
      expect(dot).toBeTruthy();
      expect(dot).toHaveClass('rounded-full');

      // Should show "Ready" text for idle status
      expect(screen.getByText('Ready')).toBeInTheDocument();
    });

    it('should render streaming status with pulsing amber dot', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 3,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should find the status dot with amber background and pulse animation
      const dot = document.querySelector('.bg-amber-400');
      expect(dot).toBeTruthy();
      expect(dot).toHaveClass('animate-pulse');
      expect(dot).toHaveClass('rounded-full');
    });

    it('should render busy status with pulsing blue dot', () => {
      mockSessionData = {
        'session-1': {
          status: 'busy',
          currentStep: 0,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should find the status dot with blue background and pulse animation
      const dot = document.querySelector('.bg-blue-400');
      expect(dot).toBeTruthy();
      expect(dot).toHaveClass('animate-pulse');
      expect(dot).toHaveClass('rounded-full');

      // Should show "Working..." text for busy status
      expect(screen.getByText('Working...')).toBeInTheDocument();
    });

    it('should render error status with red dot', () => {
      mockSessionData = {
        'session-1': {
          status: 'error',
          currentStep: 0,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should find the status dot with red background (no pulse)
      const dot = document.querySelector('.bg-red-400');
      expect(dot).toBeTruthy();
      expect(dot).toHaveClass('rounded-full');
      expect(dot).not.toHaveClass('animate-pulse');

      // Should show "Error" text for error status
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  describe('step number display', () => {
    it('should show step number when streaming', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 5,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should show step number in the text
      expect(screen.getByText(/Step 5/)).toBeInTheDocument();
    });

    it('should show step number with ellipsis when streaming', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 12,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should show step number with "..." suffix
      expect(screen.getByText('Step 12...')).toBeInTheDocument();
    });

    it('should show step 0 when streaming starts', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 0,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      expect(screen.getByText(/Step 0/)).toBeInTheDocument();
    });

    it('should not show step number when not streaming', () => {
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 5, // Has step count but not streaming
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should show "Ready" instead of step number
      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(screen.queryByText(/Step/)).not.toBeInTheDocument();
    });

    it('should not show step number when busy', () => {
      mockSessionData = {
        'session-1': {
          status: 'busy',
          currentStep: 3,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      // Should show "Working..." instead of step number
      expect(screen.getByText('Working...')).toBeInTheDocument();
      expect(screen.queryByText(/Step/)).not.toBeInTheDocument();
    });
  });

  describe('null return scenarios', () => {
    it('should return null when session data not found', () => {
      mockSessionData = {};

      const { container } = render(<SessionStatusIndicator sessionId="non-existent-session" />);

      // Container should be empty (component returned null)
      expect(container.firstChild).toBeNull();
    });

    it('should return null when session exists but has no data entry', () => {
      mockSessionData = {
        'other-session': {
          status: 'idle',
          currentStep: 0,
        },
      };

      const { container } = render(<SessionStatusIndicator sessionId="session-1" />);

      // Container should be empty
      expect(container.firstChild).toBeNull();
    });

    it('should return null when sessionId is empty string', () => {
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 0,
        },
      };

      const { container } = render(<SessionStatusIndicator sessionId="" />);

      // Container should be empty
      expect(container.firstChild).toBeNull();
    });
  });

  describe('structure and styling', () => {
    it('should have correct container structure', () => {
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 0,
        },
      };

      const { container } = render(<SessionStatusIndicator sessionId="session-1" />);

      // Should have a container div with flex layout
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('flex');
      expect(wrapper).toHaveClass('items-center');
      expect(wrapper).toHaveClass('gap-1.5');
    });

    it('should have correctly sized status dot', () => {
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 0,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      const dot = document.querySelector('.rounded-full');
      expect(dot).toHaveClass('w-1.5');
      expect(dot).toHaveClass('h-1.5');
    });

    it('should have correctly styled status text', () => {
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 0,
        },
      };

      render(<SessionStatusIndicator sessionId="session-1" />);

      const statusText = screen.getByText('Ready');
      expect(statusText).toHaveClass('text-xs');
      expect(statusText).toHaveClass('text-gray-500');
    });
  });

  describe('status transitions', () => {
    it('should handle transition from idle to streaming', () => {
      const { rerender } = render(
        <SessionStatusIndicator sessionId="session-1" />
      );

      // Initially no data
      expect(screen.queryByText('Ready')).not.toBeInTheDocument();

      // Update to streaming
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 1,
        },
      };

      rerender(<SessionStatusIndicator sessionId="session-1" />);

      expect(screen.getByText(/Step 1/)).toBeInTheDocument();
      expect(document.querySelector('.bg-amber-400')).toBeTruthy();
    });

    it('should handle transition from streaming to error', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 3,
        },
      };

      const { rerender } = render(
        <SessionStatusIndicator sessionId="session-1" />
      );

      expect(screen.getByText(/Step 3/)).toBeInTheDocument();

      // Transition to error
      mockSessionData = {
        'session-1': {
          status: 'error',
          currentStep: 3,
        },
      };

      rerender(<SessionStatusIndicator sessionId="session-1" />);

      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(document.querySelector('.bg-red-400')).toBeTruthy();
      expect(document.querySelector('.bg-amber-400')).toBeFalsy();
    });

    it('should handle transition from streaming to idle', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 5,
        },
      };

      const { rerender } = render(
        <SessionStatusIndicator sessionId="session-1" />
      );

      expect(screen.getByText(/Step 5/)).toBeInTheDocument();

      // Transition to idle
      mockSessionData = {
        'session-1': {
          status: 'idle',
          currentStep: 5,
        },
      };

      rerender(<SessionStatusIndicator sessionId="session-1" />);

      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(document.querySelector('.bg-emerald-400')).toBeTruthy();
    });
  });

  describe('multiple sessions', () => {
    it('should show correct status for each session independently', () => {
      mockSessionData = {
        'session-1': {
          status: 'streaming',
          currentStep: 2,
        },
        'session-2': {
          status: 'idle',
          currentStep: 0,
        },
        'session-3': {
          status: 'error',
          currentStep: 0,
        },
      };

      // Render indicator for session-1
      const { unmount: unmount1 } = render(
        <SessionStatusIndicator sessionId="session-1" />
      );
      expect(screen.getByText(/Step 2/)).toBeInTheDocument();
      unmount1();

      // Render indicator for session-2
      const { unmount: unmount2 } = render(
        <SessionStatusIndicator sessionId="session-2" />
      );
      expect(screen.getByText('Ready')).toBeInTheDocument();
      unmount2();

      // Render indicator for session-3
      render(<SessionStatusIndicator sessionId="session-3" />);
      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });
});

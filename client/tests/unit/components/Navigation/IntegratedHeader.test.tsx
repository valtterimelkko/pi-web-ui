import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntegratedHeader } from '../../../../src/components/Navigation/IntegratedHeader';
import { useNavigationStore } from '../../../../src/store/navigationStore';
import { useSessionStore } from '../../../../src/store/sessionStore';

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

describe('IntegratedHeader', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: false });
    (useSessionStore as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: unknown) => unknown) => {
      const state = { currentSessionId: null, sessions: [] };
      return selector(state);
    });
  });

  it('renders all tabs', () => {
    render(<IntegratedHeader onOpenSettings={() => {}} />);
    expect(screen.getByText('Chat')).toBeDefined();
    expect(screen.getByText('Shell')).toBeDefined();
    expect(screen.getByText('Files')).toBeDefined();
    expect(screen.getByText('Git')).toBeDefined();
    expect(screen.getByText('Tasks')).toBeDefined();
  });

  it('shows "Soon" badge on Tasks tab', () => {
    render(<IntegratedHeader onOpenSettings={() => {}} />);
    expect(screen.getByText('Soon')).toBeDefined();
  });

  it('switches tab when clicked', () => {
    render(<IntegratedHeader onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByText('Shell'));
    expect(useNavigationStore.getState().activeTab).toBe('shell');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntegratedHeader } from '../../../../src/components/Navigation/IntegratedHeader';
import { useNavigationStore } from '../../../../src/store/navigationStore';
import { useSessionStore } from '../../../../src/store/sessionStore';
import { useUIStore } from '../../../../src/store/uiStore';

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn(),
}));

describe('IntegratedHeader', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: false });
    useUIStore.setState({ driveModeOpen: false });
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

  it('renders Drive Mode button', () => {
    render(<IntegratedHeader onOpenSettings={() => {}} />);
    expect(screen.getByLabelText('Enter Drive Mode')).toBeDefined();
  });

  it('clicking Drive Mode button calls openDriveMode', () => {
    render(<IntegratedHeader onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByLabelText('Enter Drive Mode'));
    expect(useUIStore.getState().driveModeOpen).toBe(true);
  });
});

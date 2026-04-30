import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomNav } from '../../../../src/components/Navigation/BottomNav';
import { useNavigationStore } from '../../../../src/store/navigationStore';
import { useUIStore } from '../../../../src/store/uiStore';

describe('BottomNav', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: true, bottomNavCollapsed: false });
    useUIStore.setState({ driveModeOpen: false });
  });

  it('renders main tabs when expanded', () => {
    render(<BottomNav />);
    expect(screen.getByText('Chat')).toBeDefined();
    expect(screen.getByText('Shell')).toBeDefined();
    expect(screen.getByText('Files')).toBeDefined();
    expect(screen.getByText('Git')).toBeDefined();
  });

  it('switches to shell tab', () => {
    render(<BottomNav />);
    fireEvent.click(screen.getByText('Shell'));
    expect(useNavigationStore.getState().activeTab).toBe('shell');
  });

  it('renders collapse toggle button', () => {
    render(<BottomNav />);
    expect(screen.getByLabelText('Hide navigation')).toBeDefined();
  });

  it('collapses when toggle button is clicked', () => {
    render(<BottomNav />);
    fireEvent.click(screen.getByLabelText('Hide navigation'));
    expect(useNavigationStore.getState().bottomNavCollapsed).toBe(true);
  });

  it('shows floating expand button when collapsed', () => {
    useNavigationStore.setState({ bottomNavCollapsed: true });
    render(<BottomNav />);
    expect(screen.getByLabelText('Show navigation')).toBeDefined();
  });

  it('expands when floating button is clicked', () => {
    useNavigationStore.setState({ bottomNavCollapsed: true });
    render(<BottomNav />);
    fireEvent.click(screen.getByLabelText('Show navigation'));
    expect(useNavigationStore.getState().bottomNavCollapsed).toBe(false);
  });

  it('shows Drive Mode in "More" dropdown', () => {
    render(<BottomNav />);
    fireEvent.click(screen.getByText('More'));
    expect(screen.getByText('Drive Mode')).toBeDefined();
  });

  it('clicking Drive Mode calls openDriveMode and closes dropdown', () => {
    render(<BottomNav />);
    fireEvent.click(screen.getByText('More'));
    fireEvent.click(screen.getByText('Drive Mode'));
    expect(useUIStore.getState().driveModeOpen).toBe(true);
    // Dropdown should be closed — Drive Mode button no longer visible
    expect(screen.queryByText('Drive Mode')).toBeNull();
  });
});

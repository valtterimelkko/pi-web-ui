import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomNav } from '../../../../src/components/Navigation/BottomNav';
import { useNavigationStore } from '../../../../src/store/navigationStore';

describe('BottomNav', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: true, bottomNavCollapsed: false });
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
});

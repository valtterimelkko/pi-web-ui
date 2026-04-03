import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BottomNav } from '../../../../src/components/Navigation/BottomNav';
import { useNavigationStore } from '../../../../src/store/navigationStore';

describe('BottomNav', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: true });
  });

  it('renders main tabs', () => {
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
});

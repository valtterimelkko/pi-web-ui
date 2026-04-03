import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppShell } from '../../../../src/components/Layout/AppShell';

// Mock Sidebar
vi.mock('../../../../src/components/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

describe('AppShell', () => {
  it('renders children', () => {
    render(
      <AppShell settingsOpen={false} onOpenSettings={() => {}} onCloseSettings={() => {}}>
        <div data-testid="content">Content</div>
      </AppShell>
    );
    expect(screen.getByTestId('content')).toBeDefined();
    expect(screen.getByTestId('sidebar')).toBeDefined();
  });
});

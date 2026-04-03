import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShellTab } from '../../../../src/components/Shell/ShellTab';

vi.mock('../../../../src/hooks/useTerminal', () => ({
  useTerminal: () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    termRef: { current: null },
  }),
}));

vi.mock('../../../../src/store/terminalStore', () => ({
  useTerminalStore: vi.fn(() => ({ connected: false, error: null })),
}));

vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: { currentSessionId: null; sessions: [] }) => unknown) =>
    selector({ currentSessionId: null, sessions: [] })
  ),
}));

describe('ShellTab', () => {
  it('renders disconnected state', () => {
    render(<ShellTab />);
    expect(screen.getByText('Disconnected')).toBeDefined();
  });
});

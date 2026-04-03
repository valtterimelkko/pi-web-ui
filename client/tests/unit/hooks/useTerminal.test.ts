import { describe, it, expect, vi } from 'vitest';

// Mock xterm modules that use browser APIs
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => ({ loadAddon: vi.fn(), open: vi.fn(), onData: vi.fn(), dispose: vi.fn(), cols: 80, rows: 24 })),
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit: vi.fn() })),
}));
import { renderHook } from '@testing-library/react';
import { useTerminal } from '../../../src/hooks/useTerminal';

vi.mock('../../../src/store/terminalStore', () => ({
  useTerminalStore: vi.fn(() => ({
    setConnected: vi.fn(),
    setError: vi.fn(),
  })),
}));

vi.mock('../../../src/hooks/useAuth', () => ({
  useAuth: vi.fn(() => null),
}));

describe('useTerminal', () => {
  it('returns connect and disconnect functions', () => {
    const ref = { current: document.createElement('div') };
    const { result } = renderHook(() => useTerminal(ref));
    expect(typeof result.current.connect).toBe('function');
    expect(typeof result.current.disconnect).toBe('function');
  });
});

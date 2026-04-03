import { describe, it, expect, vi } from 'vitest';
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

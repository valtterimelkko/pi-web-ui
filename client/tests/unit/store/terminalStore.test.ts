import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalStore } from '../../../src/store/terminalStore';

describe('terminalStore', () => {
  beforeEach(() => {
    useTerminalStore.setState({ connected: false, error: null });
  });

  it('starts disconnected', () => {
    expect(useTerminalStore.getState().connected).toBe(false);
    expect(useTerminalStore.getState().error).toBeNull();
  });

  it('sets connected', () => {
    useTerminalStore.getState().setConnected(true);
    expect(useTerminalStore.getState().connected).toBe(true);
  });

  it('sets error', () => {
    useTerminalStore.getState().setError('Connection failed');
    expect(useTerminalStore.getState().error).toBe('Connection failed');
  });
});

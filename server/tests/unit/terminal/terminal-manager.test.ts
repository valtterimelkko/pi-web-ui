import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock node-pty before importing TerminalManager
// The TerminalManager uses require() in a try-catch, so we mock it via unstable_mockModule
const mockPtyProcess = {
  pid: 1234,
  onData: vi.fn((cb: (data: string) => void) => { /* store callback */ }),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  default: { spawn: vi.fn(() => mockPtyProcess) },
  spawn: vi.fn(() => mockPtyProcess),
}));

// Import after mock - but since terminal-manager uses require(), we need to test
// the fallback behavior directly
import { TerminalManager } from '../../../src/terminal/terminal-manager.js';

describe('TerminalManager', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    manager = new TerminalManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('has isAvailable method', () => {
    // isAvailable reflects whether node-pty loaded successfully
    expect(typeof manager.isAvailable()).toBe('boolean');
  });

  it('returns error when not available and create is called', () => {
    if (!manager.isAvailable()) {
      const result = manager.create('client1', '/tmp', 80, 24);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    } else {
      // If pty is available, just verify basic create works
      const result = manager.create('client1', '/tmp', 80, 24);
      expect(result.success).toBe(true);
    }
  });

  it('returns false for write to non-existent terminal', () => {
    const result = manager.write('nonexistent', 'ls\n');
    expect(result).toBe(false);
  });

  it('returns false for resize of non-existent terminal', () => {
    const result = manager.resize('nonexistent', 120, 40);
    expect(result).toBe(false);
  });

  it('returns null emitter for non-existent terminal', () => {
    const emitter = manager.getEmitter('nonexistent');
    expect(emitter).toBeNull();
  });

  it('starts with empty terminal list', () => {
    expect(manager.list()).toHaveLength(0);
  });

  it('destroyAll does not throw when empty', () => {
    expect(() => manager.destroyAll()).not.toThrow();
  });

  it('destroy does not throw for non-existent terminal', () => {
    expect(() => manager.destroy('nonexistent')).not.toThrow();
  });
});

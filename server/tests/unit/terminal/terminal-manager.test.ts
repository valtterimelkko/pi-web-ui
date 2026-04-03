import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalManager } from '../../../src/terminal/terminal-manager.js';

// Mock node-pty
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

describe('TerminalManager', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    manager = new TerminalManager();
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('creates a terminal', () => {
    const result = manager.create('client1', '/tmp', 80, 24);
    expect(result.success).toBe(true);
    expect(result.info?.clientId).toBe('client1');
    expect(result.info?.pid).toBeDefined();
  });

  it('destroys a terminal', () => {
    manager.create('client1', '/tmp', 80, 24);
    manager.destroy('client1');
    expect(manager.list()).toHaveLength(0);
  });

  it('lists terminals', () => {
    manager.create('client1', '/tmp', 80, 24);
    manager.create('client2', '/home', 80, 24);
    expect(manager.list()).toHaveLength(2);
  });

  it('writes to terminal', () => {
    manager.create('client1', '/tmp', 80, 24);
    const result = manager.write('client1', 'ls\n');
    expect(result).toBe(true);
  });

  it('returns false for write to non-existent terminal', () => {
    const result = manager.write('nonexistent', 'ls\n');
    expect(result).toBe(false);
  });

  it('resizes terminal', () => {
    manager.create('client1', '/tmp', 80, 24);
    const result = manager.resize('client1', 120, 40);
    expect(result).toBe(true);
  });

  it('destroys all terminals', () => {
    manager.create('client1', '/tmp', 80, 24);
    manager.create('client2', '/tmp', 80, 24);
    manager.destroyAll();
    expect(manager.list()).toHaveLength(0);
  });
});

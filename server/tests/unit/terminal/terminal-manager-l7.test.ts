import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventEmitter } from 'node:events';

/**
 * Fake node-pty: stores onData/onExit callbacks so the test can drive them and
 * assert listener/timer behaviour without a real shell.
 */
const fakePty = vi.hoisted(() => ({
  dataCbs: [] as Array<(data: string) => void>,
  exitCbs: [] as Array<(e: { exitCode: number; signal?: number }) => void>,
}));

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      pid: 1000 + fakePty.dataCbs.length,
      onData: vi.fn((cb: (data: string) => void) => { fakePty.dataCbs.push(cb); }),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => { fakePty.exitCbs.push(cb); }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })),
  },
  spawn: vi.fn(() => ({
    pid: 1,
    onData: vi.fn((cb: (data: string) => void) => { fakePty.dataCbs.push(cb); }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => { fakePty.exitCbs.push(cb); }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { TerminalManager } from '../../../src/terminal/terminal-manager.js';

type IdleTimers = Map<string, unknown>;
function idleTimersOf(manager: TerminalManager): IdleTimers {
  return (manager as unknown as { idleTimers: IdleTimers }).idleTimers;
}
function emitterOf(manager: TerminalManager, clientId: string): EventEmitter {
  const e = manager.getEmitter(clientId);
  if (!e) throw new Error(`emitter missing for ${clientId}`);
  return e;
}

/**
 * L7: terminal data/exit listeners must not accumulate. destroy() and process
 * exit remove the websocket's emitter listeners; 100 connect/disconnect cycles
 * leave the manager empty with no idle timers; each PTY chunk delivers exactly
 * one output event.
 */
describe('L7: TerminalManager listener + timer cleanup', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    fakePty.dataCbs = [];
    fakePty.exitCbs = [];
    manager = new TerminalManager();
  });

  it('destroy() removes the emitter listeners (no accumulation on reconnect)', async () => {
    await manager.create('c1', '/tmp', 80, 24);
    const emitter = emitterOf(manager, 'c1');
    emitter.on('data', () => {});
    emitter.on('exit', () => {});
    expect(emitter.listenerCount('data')).toBe(1);
    expect(emitter.listenerCount('exit')).toBe(1);

    manager.destroy('c1');

    expect(emitter.listenerCount('data')).toBe(0);
    expect(emitter.listenerCount('exit')).toBe(0);
    expect(manager.getEmitter('c1')).toBeNull();
  });

  it('100 create/destroy cycles leave the manager empty with no idle timers', async () => {
    for (let i = 0; i < 100; i++) {
      await manager.create(`c${i}`, '/tmp', 80, 24);
      manager.destroy(`c${i}`);
    }
    expect(manager.list()).toHaveLength(0);
    expect(idleTimersOf(manager).size).toBe(0);
  });

  it('process exit clears the idle timer and removes listeners', async () => {
    await manager.create('c1', '/tmp', 80, 24);
    const emitter = emitterOf(manager, 'c1');
    emitter.on('data', () => {});
    emitter.on('exit', () => {});
    const idleTimers = idleTimersOf(manager);
    expect(idleTimers.size).toBe(1); // idle timer armed on create

    // Drive the PTY exit callback (the last registered one for this terminal).
    fakePty.exitCbs[fakePty.exitCbs.length - 1]({ exitCode: 0 });

    expect(manager.getEmitter('c1')).toBeNull(); // session removed
    expect(idleTimers.size).toBe(0); // idle timer cleared
    expect(emitter.listenerCount('data')).toBe(0);
    expect(emitter.listenerCount('exit')).toBe(0);
  });

  it('delivers exactly one output event per PTY data chunk (no duplicate delivery)', async () => {
    await manager.create('c1', '/tmp', 80, 24);
    const emitter = emitterOf(manager, 'c1');
    const received: string[] = [];
    emitter.on('data', (d: string) => received.push(d));

    fakePty.dataCbs[fakePty.dataCbs.length - 1]('hello');
    fakePty.dataCbs[fakePty.dataCbs.length - 1]('world');

    expect(received).toEqual(['hello', 'world']);
  });
});

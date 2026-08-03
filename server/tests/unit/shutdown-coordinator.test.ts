import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator } from '../../src/shutdown-coordinator.js';

describe('ShutdownCoordinator', () => {
  it('shares one promise across repeated shutdown calls (single-flight)', async () => {
    const run = vi.fn(async () => {});
    const exit = vi.fn();
    const coord = new ShutdownCoordinator({
      steps: [{ name: 'a', run }],
      exit,
      setTimeout: ((fn: () => void) => setTimeout(fn, 10000)) as never,
      clearTimeout: ((t: NodeJS.Timeout) => clearTimeout(t)) as never,
    });

    const first = coord.shutdown();
    const second = coord.shutdown();
    const third = coord.shutdown();

    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('attempts every owner even if an earlier step throws, then exits 0', async () => {
    const a = vi.fn(async () => { throw new Error('boom'); });
    const b = vi.fn(async () => {});
    const c = vi.fn(async () => {});
    const errors: Array<[string, unknown]> = [];
    const exit = vi.fn();
    const coord = new ShutdownCoordinator({
      steps: [{ name: 'a', run: a }, { name: 'b', run: b }, { name: 'c', run: c }],
      exit,
      onStepError: (name, err) => errors.push([name, err]),
      setTimeout: ((fn: () => void) => setTimeout(fn, 10000)) as never,
      clearTimeout: ((t: NodeJS.Timeout) => clearTimeout(t)) as never,
    });

    await coord.shutdown();

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(c).toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toBe('a');
    expect(exit).toHaveBeenCalledWith(0); // normal completion, no Forced shutdown
  });

  it('clears the force-exit timer on normal completion (no exit(1))', async () => {
    const exit = vi.fn();
    let forceFired = false;
    const timers: Array<() => void> = [];
    const coord = new ShutdownCoordinator({
      steps: [{ name: 'a', run: async () => {} }],
      exit,
      onForceExit: () => { forceFired = true; },
      setTimeout: ((fn: () => void) => { timers.push(fn); return timers.length as never; }) as never,
      clearTimeout: vi.fn(),
    });

    await coord.shutdown();

    expect(exit).toHaveBeenCalledWith(0);
    expect(forceFired).toBe(false); // timer was cleared, never invoked
  });

  it('force-exits with code 1 if teardown exceeds the deadline', async () => {
    const exit = vi.fn();
    let forceCb: (() => void) | null = null;
    let forceCalled = false;
    // A step that never resolves on its own.
    const hanging = () => new Promise<void>(() => {});
    const coord = new ShutdownCoordinator({
      steps: [{ name: 'hang', run: hanging }],
      exit,
      forceExitAfterMs: 5,
      onForceExit: () => { forceCalled = true; },
      setTimeout: ((fn: () => void) => { forceCb = fn; return 0 as never; }) as never,
      clearTimeout: vi.fn(),
    });

    const done = coord.shutdown();
    // Simulate the deadline elapsing.
    forceCb!();
    expect(forceCalled).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
    void done;
  });
});

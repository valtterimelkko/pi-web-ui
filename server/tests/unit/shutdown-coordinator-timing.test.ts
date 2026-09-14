import { describe, it, expect, vi } from 'vitest';
import { ShutdownCoordinator } from '../../src/shutdown-coordinator.js';

/**
 * Shutdown timing (2026-09-14).
 *
 * Four SIGKILLs in one afternoon could not be explained from the journal:
 * teardown either completed or it did not, with nothing saying WHICH owner was
 * slow. These tests pin the measurement, including the case that matters most —
 * a step that fails slowly must still be timed, since otherwise the worst
 * offenders are exactly the ones that go unrecorded.
 */
describe('shutdown coordinator — per-step timing', () => {
  it('reports each step with its duration, in order', async () => {
    const clock = [0, 100, 100, 350, 350, 900]; // start, after-step, ...
    let i = 0;
    const seen: Array<[string, number, boolean]> = [];
    const c = new ShutdownCoordinator({
      steps: [
        { name: 'a', run: () => {} },
        { name: 'b', run: () => {} },
      ],
      now: () => clock[Math.min(i++, clock.length - 1)],
      exit: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      onStepComplete: (name, ms, failed) => seen.push([name, ms, failed]),
    });
    await c.shutdown();
    expect(seen.map(([n]) => n)).toEqual(['a', 'b']);
    expect(seen.every(([, ms]) => ms >= 0)).toBe(true);
  });

  it('times a FAILING step too, and marks it', async () => {
    const onStepComplete = vi.fn();
    const onStepError = vi.fn();
    const c = new ShutdownCoordinator({
      steps: [
        { name: 'boom', run: () => { throw new Error('nope'); } },
        { name: 'after', run: () => {} },
      ],
      exit: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      onStepComplete,
      onStepError,
    });
    await c.shutdown();
    expect(onStepComplete).toHaveBeenCalledTimes(2);
    expect(onStepComplete.mock.calls[0][0]).toBe('boom');
    expect(onStepComplete.mock.calls[0][2]).toBe(true);
    // A failing owner must not skip the remaining owners.
    expect(onStepError).toHaveBeenCalledTimes(1);
    expect(onStepComplete.mock.calls[1][0]).toBe('after');
    expect(onStepComplete.mock.calls[1][2]).toBe(false);
  });

  it('reports the total exactly once', async () => {
    const onComplete = vi.fn();
    const c = new ShutdownCoordinator({
      steps: [{ name: 'only', run: () => {} }],
      exit: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      onComplete,
    });
    await c.shutdown();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(typeof onComplete.mock.calls[0][0]).toBe('number');
  });

  it('still exits 0 on success and does not force-exit', async () => {
    const exit = vi.fn();
    const onForceExit = vi.fn();
    const c = new ShutdownCoordinator({
      steps: [{ name: 'only', run: () => {} }],
      exit,
      setTimeout: () => 1,
      clearTimeout: () => {},
      onForceExit,
    });
    await c.shutdown();
    expect(exit).toHaveBeenCalledWith(0);
    expect(onForceExit).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { handleStopSignal, installStopSignalHandlers, STOP_SIGNALS } from '../../src/shutdown-signal.js';

/**
 * The synchronous half of the shutdown instrument (2026-09-15).
 *
 * The 2026-09-14/15 stop incidents could not say whether SIGTERM ever reached
 * the process, because the only record was inside `shutdown()`, which does its
 * work through an async logger. This module writes the received signal —
 * synchronously, before any await — and arms the hard-exit deadline in the same
 * handler, so that a stop which reaches the process always leaves a trace even
 * when the teardown that follows cannot report anything.
 *
 * Everything is injected so the ordering and the arming can be asserted without
 * signalling the test runner.
 */
describe('stop-signal recording', () => {
  const deps = (over: Partial<Parameters<typeof handleStopSignal>[1]> = {}) => ({
    write: vi.fn(),
    now: () => 1_700_000_000_000,
    signalReceived: new BigInt64Array(new SharedArrayBuffer(8)),
    onShutdown: vi.fn(),
    setTimeout: vi.fn(() => 42),
    exit: vi.fn(),
    ...over,
  });

  it('writes the received signal before anything else can await', () => {
    const d = deps();
    handleStopSignal('SIGTERM', d);
    expect(d.write).toHaveBeenCalledTimes(1);
    const line = String((d.write as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(line).toContain('signal=SIGTERM');
    // Synchronous-first: the write happens before the teardown is kicked off.
    const w = d.write as ReturnType<typeof vi.fn>;
    const os = d.onShutdown as ReturnType<typeof vi.fn>;
    expect(w.mock.invocationCallOrder[0]).toBeLessThan(os.mock.invocationCallOrder[0]);
  });

  it('publishes the signal time for the worker backstop to read', () => {
    const d = deps();
    handleStopSignal('SIGTERM', d);
    expect(Number(Atomics.load(d.signalReceived, 0))).toBe(1_700_000_000_000);
  });

  it('arms a hard-exit deadline synchronously, in the same handler', () => {
    const d = deps();
    handleStopSignal('SIGTERM', d);
    expect(d.setTimeout).toHaveBeenCalledTimes(1);
    const [fn, ms] = (d.setTimeout as ReturnType<typeof vi.fn>).mock.calls[0] as [() => void, number];
    expect(ms).toBe(20_000);
    // Firing the deadline exits non-zero, distinct from a clean teardown.
    fn();
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it('keeps the hard-exit deadline below systemd TimeoutStopSec=30', () => {
    const d = deps();
    handleStopSignal('SIGTERM', d);
    const ms = (d.setTimeout as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
    expect(ms).toBeLessThan(30_000);
  });

  it('honours an explicit deadline override', () => {
    const d = deps({ hardExitAfterMs: 5_000 });
    handleStopSignal('SIGTERM', d);
    expect((d.setTimeout as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(5_000);
  });

  it('records the signal even when teardown is already wedged', () => {
    const d = deps({ onShutdown: vi.fn(() => { throw new Error('teardown wedged'); }) });
    expect(() => handleStopSignal('SIGTERM', d)).not.toThrow();
    // The record is what matters, and it comes first: a throwing teardown must
    // not erase the evidence that the signal arrived. Any follow-up line is
    // diagnostic, never a replacement.
    const lines = (d.write as ReturnType<typeof vi.fn>).mock.calls.map(([l]) => String(l));
    expect(lines[0]).toContain('event=stop_signal');
    expect(lines[0]).toContain('signal=SIGTERM');
    expect(lines.join('\n')).toContain('teardown wedged');
    expect(d.setTimeout).toHaveBeenCalledTimes(1);
  });

  it('is safe when the shared buffer cannot be written', () => {
    const d = deps({ signalReceived: undefined });
    expect(() => handleStopSignal('SIGTERM', d)).not.toThrow();
    expect(d.write).toHaveBeenCalledTimes(1);
  });

  it('names both stop signals it understands', () => {
    expect([...STOP_SIGNALS]).toEqual(['SIGTERM', 'SIGINT']);
  });
});

describe('stop-signal handler installation', () => {
  it('registers a handler for every stop signal exactly once', () => {
    const on = vi.fn();
    const off = vi.fn();
    const handler = installStopSignalHandlers({
      processLike: { on, off } as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      write: vi.fn(),
      signalReceived: new BigInt64Array(new SharedArrayBuffer(8)),
      onShutdown: vi.fn(),
      setTimeout: vi.fn(() => 1),
      exit: vi.fn(),
    });
    expect(on).toHaveBeenCalledTimes(STOP_SIGNALS.length);
    for (const name of STOP_SIGNALS) {
      expect(on).toHaveBeenCalledWith(name, expect.any(Function));
    }
    // The signal name must reach the record.
    const call = on.mock.calls.find(([name]) => name === 'SIGTERM');
    (call![1] as () => void)();
    handler();
    expect(off).toHaveBeenCalledTimes(STOP_SIGNALS.length);
  });
});

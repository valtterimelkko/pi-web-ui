import { describe, it, expect, vi } from 'vitest';
import {
  LoopStallAttributor,
  createLoopStallLogReporter,
  type LoopStallEvent,
  type LoopStallTimerHandle,
} from '../../../src/observability/loop-stall-attribution.js';

/**
 * Deterministic scheduler seam: one pending timer at a time (the attributor
 * reschedules itself from inside the tick).
 */
class FakeScheduler {
  handle: (LoopStallTimerHandle & { fn: () => void; ms: number }) | null = null;
  scheduled = 0;
  cancelled = 0;

  schedule = (fn: () => void, ms: number): LoopStallTimerHandle => {
    this.scheduled += 1;
    const handle = { fn, ms, unref: () => undefined, unrefCount: 0 };
    this.handle = handle;
    return handle;
  };

  cancel = (handle: LoopStallTimerHandle): void => {
    this.cancelled += 1;
    if (this.handle === handle) this.handle = null;
  };

  /** Fire the pending tick (if any), advancing the clock by `advanceMs`. */
  fire(clock: { now: number }, advanceMs = 0): void {
    clock.now += advanceMs;
    const handle = this.handle;
    this.handle = null;
    handle?.fn();
  }
}

function setup(options: {
  intervalMs?: number;
  stallThresholdMs?: number;
  spanThresholdMs?: number;
  maxStalls?: number;
  maxSpans?: number;
  maxLabels?: number;
} = {}) {
  const clock = { now: 1_000 };
  const scheduler = new FakeScheduler();
  const events: LoopStallEvent[] = [];
  const attributor = new LoopStallAttributor({
    intervalMs: options.intervalMs ?? 25,
    stallThresholdMs: options.stallThresholdMs ?? 50,
    spanThresholdMs: options.spanThresholdMs ?? 100,
    maxStalls: options.maxStalls ?? 50,
    maxSpans: options.maxSpans ?? 50,
    maxLabels: options.maxLabels ?? 64,
    now: () => clock.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    onRecord: (event) => events.push(event),
  });
  return { attributor, scheduler, clock, events };
}

describe('LoopStallAttributor — start/stop lifecycle', () => {
  it('schedules one tick at the configured interval and is idempotent', () => {
    const { attributor, scheduler } = setup({ intervalMs: 25 });
    attributor.start();
    attributor.start();
    expect(scheduler.scheduled).toBe(1);
    expect(scheduler.handle?.ms).toBe(25);
    expect(attributor.running).toBe(true);
  });

  it('stop() cancels the pending tick and unrefs nothing that was never scheduled', () => {
    const { attributor, scheduler } = setup();
    attributor.start();
    attributor.stop();
    expect(scheduler.cancelled).toBe(1);
    expect(attributor.running).toBe(false);
  });
});

describe('LoopStallAttributor — stall attribution', () => {
  it('records a stall with its measured delay and the innermost active label', () => {
    const { attributor, scheduler, clock, events } = setup({ intervalMs: 25, stallThresholdMs: 50 });
    attributor.start();
    const exitOuter = attributor.enter('pi.session.create');
    const exitInner = attributor.enter('pi.session.resource_loader');
    // Tick is 700 ms late.
    scheduler.fire(clock, 725);
    exitInner();
    exitOuter();

    const snapshot = attributor.snapshot();
    expect(snapshot.stallCount).toBe(1);
    expect(snapshot.stalls).toHaveLength(1);
    expect(snapshot.stalls[0].delayMs).toBe(700);
    expect(snapshot.stalls[0].label).toBe('pi.session.resource_loader');
    expect(snapshot.stalls[0].stack).toEqual(['pi.session.create', 'pi.session.resource_loader']);
    expect(snapshot.stallsByLabel['pi.session.resource_loader']).toEqual({ count: 1, totalMs: 700, maxMs: 700 });
    expect(events.some((e) => e.kind === 'stall')).toBe(true);
  });

  it('does not record a tick that is within the threshold', () => {
    const { attributor, scheduler, clock } = setup({ intervalMs: 25, stallThresholdMs: 50 });
    attributor.start();
    scheduler.fire(clock, 30);
    expect(attributor.snapshot().stallCount).toBe(0);
    expect(attributor.snapshot().sampledTicks).toBe(1);
  });

  it('attributes an unattributed stall to <none> rather than dropping it', () => {
    const { attributor, scheduler, clock } = setup({ stallThresholdMs: 50 });
    attributor.start();
    scheduler.fire(clock, 400);
    expect(attributor.snapshot().stalls[0].label).toBe('<none>');
    expect(attributor.snapshot().stallsByLabel['<none>'].count).toBe(1);
  });

  it('names the recently-finished span whose measured window contains the missed tick', () => {
    // The overdue timer can only run AFTER the blocking span exits (the whole
    // span was one macrotask), so the label stack alone is a level too coarse.
    // The span window is the direct evidence.
    const { attributor, scheduler, clock } = setup({ intervalMs: 25, stallThresholdMs: 50, spanThresholdMs: 10_000 });
    attributor.start();
    attributor.enter('pi.multi.rehydrate_session');
    attributor.span('pi.session.resource_loader', () => {
      clock.now += 300;
    });
    // expectedAt was 1025; the span window is [1000, 1300].
    scheduler.fire(clock, 0);
    const stall = attributor.snapshot().stalls[0];
    expect(stall.delayMs).toBe(275);
    expect(stall.blockedBy).toEqual([{ name: 'pi.session.resource_loader', durationMs: 300 }]);
  });

  it('leaves blockedBy empty when no measured span window covers the missed tick', () => {
    const { attributor, scheduler, clock } = setup({ intervalMs: 25, stallThresholdMs: 50 });
    attributor.start();
    // The span starts at 1200, so its window [1200, 1500] does not contain the
    // tick that was due at 1025.
    clock.now = 1_200;
    attributor.span('unrelated', () => {
      clock.now += 300;
    });
    scheduler.fire(clock, 0);
    expect(attributor.snapshot().stalls[0].blockedBy).toEqual([]);
  });

  it('reschedules after every tick', () => {
    const { attributor, scheduler, clock } = setup({ intervalMs: 25 });
    attributor.start();
    scheduler.fire(clock, 10);
    expect(scheduler.scheduled).toBe(2);
    scheduler.fire(clock, 10);
    expect(attributor.snapshot().sampledTicks).toBe(2);
  });

  it('bounds the stall ring to the newest maxStalls records', () => {
    const { attributor, scheduler, clock } = setup({ stallThresholdMs: 50, maxStalls: 3 });
    attributor.start();
    const recorded: number[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const advance = 100 + i * 10;
      recorded.push(advance - 25);
      scheduler.fire(clock, advance);
    }
    const snapshot = attributor.snapshot();
    expect(snapshot.stalls).toHaveLength(3);
    expect(snapshot.stallCount).toBe(6);
    expect(snapshot.stalls.map((s) => s.delayMs)).toEqual(recorded.slice(-3));
  });

  it('bounds label cardinality by folding new labels into <other>', () => {
    const { attributor, scheduler, clock } = setup({ stallThresholdMs: 50, maxLabels: 2 });
    attributor.start();
    const first = attributor.enter('a');
    scheduler.fire(clock, 100);
    first();
    const second = attributor.enter('b');
    scheduler.fire(clock, 100);
    second();
    const third = attributor.enter('c');
    scheduler.fire(clock, 100);
    third();

    const snapshot = attributor.snapshot();
    expect(Object.keys(snapshot.stallsByLabel).sort()).toEqual(['<other>', 'a', 'b']);
    expect(snapshot.stalls[2].label).toBe('<other>');
  });
});

describe('LoopStallAttributor — synchronous spans', () => {
  it('records a synchronous span over the threshold with name, duration and kind', () => {
    const { attributor, clock } = setup({ spanThresholdMs: 100 });
    const result = attributor.span('pi.session.resource_loader', () => {
      clock.now += 512;
      return 'loaded';
    });
    const snapshot = attributor.snapshot();
    expect(result).toBe('loaded');
    expect(snapshot.spanCount).toBe(1);
    expect(snapshot.spansOverThreshold).toEqual([{ kind: 'sync', name: 'pi.session.resource_loader', durationMs: 512, atMs: 1_000 }]);
    expect(snapshot.spansByName['pi.session.resource_loader']).toEqual({ count: 1, totalMs: 512, maxMs: 512, overThreshold: 1 });
  });

  it('counts but does not record a span under the threshold', () => {
    const { attributor, clock } = setup({ spanThresholdMs: 100 });
    attributor.span('pi.session.open', () => {
      clock.now += 40;
    });
    const snapshot = attributor.snapshot();
    expect(snapshot.spansOverThreshold).toHaveLength(0);
    expect(snapshot.spansByName['pi.session.open']).toEqual({ count: 1, totalMs: 40, maxMs: 40, overThreshold: 0 });
  });

  it('restores the label stack and still records the span when the body throws', () => {
    const { attributor, clock } = setup({ spanThresholdMs: 100 });
    const outer = attributor.enter('outer');
    expect(() => attributor.span('explodes', () => {
      clock.now += 200;
      throw new Error('boom');
    })).toThrow('boom');
    outer();
    expect(attributor.snapshot().spansOverThreshold[0].name).toBe('explodes');
    expect(attributor.snapshot().spansByName.explodes.maxMs).toBe(200);
    // Stack unwound after the throw and the outer exit.
    expect(attributor.currentStack).toEqual([]);
  });

  it('records the innermost label for a stall raised inside a span and aggregates by label', () => {
    const { attributor, scheduler, clock } = setup({ intervalMs: 25, stallThresholdMs: 50 });
    attributor.start();
    attributor.span('pi.session.rehydrate', () => {
      attributor.span('pi.session.resource_loader', () => {
        scheduler.fire(clock, 300);
      });
    });
    const snapshot = attributor.snapshot();
    expect(snapshot.stalls[0].label).toBe('pi.session.resource_loader');
    expect(snapshot.stalls[0].stack).toEqual(['pi.session.rehydrate', 'pi.session.resource_loader']);
  });

  it('bounds the span ring to the newest maxSpans records', () => {
    const { attributor, clock } = setup({ spanThresholdMs: 10, maxSpans: 2 });
    for (const name of ['a', 'b', 'c']) {
      attributor.span(name, () => {
        clock.now += 50;
      });
    }
    expect(attributor.snapshot().spansOverThreshold.map((s) => s.name)).toEqual(['b', 'c']);
    expect(attributor.snapshot().spanCount).toBe(3);
  });
});

describe('LoopStallAttributor — asynchronous spans', () => {
  it('records an async span over the threshold with kind async', async () => {
    const { attributor, clock } = setup({ spanThresholdMs: 100 });
    const value = await attributor.spanAsync('pi.session.create', async () => {
      clock.now += 250;
      await Promise.resolve();
      return 7;
    });
    expect(value).toBe(7);
    const snapshot = attributor.snapshot();
    expect(snapshot.spansOverThreshold[0]).toMatchObject({ kind: 'async', name: 'pi.session.create', durationMs: 250 });
  });

  it('unwinds the stack when an async span rejects', async () => {
    const { attributor, clock } = setup({ spanThresholdMs: 10 });
    await expect(attributor.spanAsync('rejects', async () => {
      clock.now += 20;
      throw new Error('nope');
    })).rejects.toThrow('nope');
    expect(attributor.currentStack).toEqual([]);
  });
});

describe('createLoopStallLogReporter', () => {
  it('rate-limits repeated records for the same label and forwards the first', () => {
    const warn = vi.fn();
    const now = { t: 0 };
    const report = createLoopStallLogReporter({ warn }, { now: () => now.t, minIntervalMs: 5_000 });
    const stall: LoopStallEvent = { kind: 'stall', label: 'pi.session.open', delayMs: 700, atMs: 0, stack: ['pi.session.open'], blockedBy: [] };
    report(stall);
    report(stall);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('pi.session.open');
    expect(warn.mock.calls[0][0]).toContain('700');
    now.t = 5_000;
    report(stall);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('names the blocking span window in the log line when one covers the tick', () => {
    const warn = vi.fn();
    const report = createLoopStallLogReporter({ warn }, { now: () => 0 });
    report({
      kind: 'stall',
      label: 'pi.multi.rehydrate_session',
      delayMs: 420,
      atMs: 0,
      stack: ['pi.multi.rehydrate_session'],
      blockedBy: [{ name: 'pi.session.resource_loader', durationMs: 430 }],
    });
    expect(warn.mock.calls[0][0]).toContain('pi.session.resource_loader');
  });

  it('never lets a reporter failure escape into the measured path', () => {
    const report = createLoopStallLogReporter({ warn: () => { throw new Error('sink down'); } }, {});
    const span: LoopStallEvent = { kind: 'span', spanKind: 'sync', label: 'x', durationMs: 200, atMs: 0 };
    expect(() => report(span)).not.toThrow();
  });
});

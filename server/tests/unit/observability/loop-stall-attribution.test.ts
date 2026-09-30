import { describe, it, expect, vi } from 'vitest';
import {
  LoopStallAttributor,
  createLoopStallLogReporter,
  type LoopStallEvent,
  type LoopStallTimerHandle,
} from '../../../src/observability/loop-stall-attribution.js';
import { getCorrelationContext, withCorrelation } from '../../../src/logging/correlation.js';

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
    // Correction 02: the enclosing label frame was also on the loop across the
    // miss, so it is named as co-evidence (without ids — it captured none); the
    // completed inner span remains the direct blocker.
    expect(stall.blockedBy).toEqual([
      { name: 'pi.session.resource_loader', durationMs: 300 },
      { name: 'pi.multi.rehydrate_session', durationMs: 300 },
    ]);
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

  it('renders captured run ids into the stall log line in the logger suffix style', () => {
    const warn = vi.fn();
    const report = createLoopStallLogReporter({ warn }, { now: () => 0 });
    report({
      kind: 'stall',
      label: 'pi.session.stream',
      delayMs: 250,
      atMs: 0,
      stack: ['pi.session.stream'],
      blockedBy: [],
      context: { requestId: 'req_C', sessionId: 'sess_C', runtime: 'pi' },
    });
    expect(warn.mock.calls[0][0]).toContain('req=req_C');
    expect(warn.mock.calls[0][0]).toContain('sid=sess_C');
    expect(warn.mock.calls[0][0]).toContain('rt=pi');
  });

  it('renders no id suffix when the stall carries no captured context', () => {
    const warn = vi.fn();
    const report = createLoopStallLogReporter({ warn }, { now: () => 0 });
    report({ kind: 'stall', label: 'x', delayMs: 60, atMs: 0, stack: ['x'], blockedBy: [] });
    expect(warn.mock.calls[0][0]).not.toContain('sid=');
    expect(warn.mock.calls[0][0]).not.toContain('req=');
  });
});

describe('LoopStallAttributor — correlation-context hygiene (G2)', () => {
  /**
   * G2 production finding (2026-09-30): every LoopAttribution stall line since
   * the 09:55 restart carried the first session's req=/run=/sid= tags,
   * including long after that session finished. The sampler is a
   * self-rescheduling timer; if the first start() happens inside a session's
   * withCorrelation scope (it does: the first instrumented call is a session
   * create), the whole timer chain captures that AsyncLocalStorage context and
   * every later stall line is stamped with it at emit time.
   *
   * Frozen criterion: after a run's context ends, a stall must carry none of
   * its ids — and attribution must not be dropped altogether: a stall raised
   * while a run's span is active still carries that run's ids, captured at
   * span-entry time from the (correct) enclosing context.
   */

  it('does not leak a session correlation context captured at start() into later stall emissions', async () => {
    const observedContexts: unknown[] = [];
    const lines: string[] = [];
    const clock = { now: 1_000 };
    const attributor = new LoopStallAttributor({
      intervalMs: 5,
      stallThresholdMs: 50,
      spanThresholdMs: 100,
      now: () => clock.now,
      onRecord: (event) => {
        observedContexts.push(getCorrelationContext());
        createLoopStallLogReporter({ warn: (line) => lines.push(line) }, { now: () => 0 })(event);
      },
    });

    withCorrelation({ requestId: 'req_A', runId: 'run_A', sessionId: 'sess_A', runtime: 'pi' }, () => {
      attributor.start();
    });
    expect(getCorrelationContext()).toBeUndefined(); // the run's context has ended

    clock.now += 500; // the pending tick is now far past the stall threshold
    await new Promise((resolve) => setTimeout(resolve, 40)); // let the real timer chain fire
    attributor.stop();

    expect(observedContexts.length).toBeGreaterThan(0);
    for (const context of observedContexts) {
      expect(context).toBeUndefined();
    }
    for (const line of lines) {
      expect(line).not.toContain('sess_A');
      expect(line).not.toContain('run_A');
      expect(line).not.toContain('req_A');
    }
  });

  it('attaches the active run ids to a stall while the run is on the stack, and none after it ends', () => {
    const clock = { now: 1_000 };
    const scheduler = new FakeScheduler();
    const events: LoopStallEvent[] = [];
    const lines: string[] = [];
    const attributor = new LoopStallAttributor({
      intervalMs: 25,
      stallThresholdMs: 50,
      spanThresholdMs: 100,
      now: () => clock.now,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRecord: (event) => {
        events.push(event);
        createLoopStallLogReporter({ warn: (line) => lines.push(line) }, { now: () => 0 })(event);
      },
    });
    attributor.start(); // started outside any correlation context

    let exitSpan: (() => void) | undefined;
    withCorrelation({ requestId: 'req_B', runId: 'run_B', sessionId: 'sess_B', runtime: 'pi' }, () => {
      exitSpan = attributor.enter('pi.session.stream');
    });

    // Stall while the run's span is active: the ids come from the span's frame.
    scheduler.fire(clock, 100);
    const during = events.find((event) => event.kind === 'stall') as Extract<LoopStallEvent, { kind: 'stall' }>;
    expect(during).toBeDefined();
    expect(during.label).toBe('pi.session.stream');
    expect(during.context).toEqual({ requestId: 'req_B', runId: 'run_B', sessionId: 'sess_B', runtime: 'pi' });
    expect(lines.some((line) => line.includes('sid=sess_B') && line.includes('run=run_B'))).toBe(true);

    // The run ends; a later stall carries none of its ids.
    exitSpan?.();
    events.length = 0;
    lines.length = 0;
    scheduler.fire(clock, 100);
    const after = events.find((event) => event.kind === 'stall') as Extract<LoopStallEvent, { kind: 'stall' }>;
    expect(after).toBeDefined();
    expect(after.context).toBeUndefined();
    expect(lines[0]).not.toContain('sess_B');
    expect(lines[0]).not.toContain('run_B');
    attributor.stop();
  });

  it('captures ids for nested spans from the innermost frame and unwinds them in enter/exit pairs', () => {
    const clock = { now: 1_000 };
    const scheduler = new FakeScheduler();
    const events: LoopStallEvent[] = [];
    const attributor = new LoopStallAttributor({
      intervalMs: 25,
      stallThresholdMs: 50,
      spanThresholdMs: 100,
      now: () => clock.now,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRecord: (event) => events.push(event),
    });
    attributor.start();

    withCorrelation({ sessionId: 'sess_outer', runtime: 'pi' }, () => {
      const exitOuter = attributor.enter('pi.multi.create_session');
      withCorrelation({ sessionId: 'sess_inner', requestId: 'req_inner' }, () => {
        const exitInner = attributor.enter('pi.session.resource_loader');
        exitInner();
      });
      exitOuter();
    });
    expect(attributor.currentStack).toEqual([]);

    scheduler.fire(clock, 100);
    const stall = events.find((event) => event.kind === 'stall') as Extract<LoopStallEvent, { kind: 'stall' }>;
    expect(stall).toBeDefined();
    expect(stall.context).toBeUndefined();
    attributor.stop();
  });
});

describe('LoopStallAttributor — blamed-evidence correlation (correction 02)', () => {
  /**
   * Review finding 1 [major]: a stall took its ids from the innermost frame of
   * the process-wide frame array, which under overlapping spans is whichever
   * operation happened to be entered last — not the operation that blocked.
   * Concurrent turns are the orchestration case. Frozen rule: ids come from the
   * frames actually blamed (the blockedBy/stack evidence); when several run
   * contexts are blamed, each blocker carries its own ids and the stall carries
   * none rather than a wrong one.
   */

  const CTX_A = { requestId: 'req_A', runId: 'run_A', sessionId: 'sess_A', runtime: 'pi' };
  const CTX_B = { requestId: 'req_B', runId: 'run_B', sessionId: 'sess_B', runtime: 'pi' };

  function setup(clock: { now: number }, onRecord: (event: LoopStallEvent) => void) {
    const scheduler = new FakeScheduler();
    const attributor = new LoopStallAttributor({
      intervalMs: 25,
      stallThresholdMs: 50,
      spanThresholdMs: 100,
      now: () => clock.now,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      onRecord,
    });
    attributor.start();
    scheduler.fire(clock, 0); // settle the first expected tick
    return { attributor, scheduler };
  }

  it('takes the ids from the blamed span when an unrelated pending frame is innermost (reviewer probe)', () => {
    const clock = { now: 1_000 };
    const events: LoopStallEvent[] = [];
    const lines: string[] = [];
    const { attributor, scheduler } = setup(clock, (event) => {
      if (event.kind !== 'stall') return;
      events.push(event);
      createLoopStallLogReporter({ warn: (line) => lines.push(line) }, { now: () => 0 })(event);
    });

    // run_B's span blocks past the threshold: its measured window covers the
    // missed tick. No other span exists at the missed instant.
    withCorrelation(CTX_B, () => {
      attributor.span('operation_B', () => { clock.now += 120; });
    });

    // run_A's spanAsync is entered after the missed instant and is still
    // pending when the overdue tick fires: it is the innermost frame, but it
    // did not block.
    withCorrelation(CTX_A, () => {
      void attributor.spanAsync('operation_A', () => new Promise(() => { /* pending */ }));
    });

    scheduler.fire(clock, 0);
    const stall = events.find((event) => event.kind === 'stall') as Extract<LoopStallEvent, { kind: 'stall' }>;
    expect(stall).toBeDefined();
    expect(stall.blockedBy[0]?.name).toBe('operation_B');
    expect(stall.blockedBy[0]?.context).toEqual(CTX_B);
    expect(stall.context).toEqual(CTX_B); // current code: CTX_A (innermost frame) — the wrong session
    expect(lines.some((line) => line.includes('run=run_B') && !line.includes('run_A'))).toBe(true);
    attributor.stop();
  });

  it('reports each blamed blocker with its own ids and no single wrong one when contexts are mixed', () => {
    const clock = { now: 1_000 };
    const events: LoopStallEvent[] = [];
    const lines: string[] = [];
    const { attributor, scheduler } = setup(clock, (event) => {
      if (event.kind !== 'stall') return;
      events.push(event);
      createLoopStallLogReporter({ warn: (line) => lines.push(line) }, { now: () => 0 })(event);
    });

    // operation_A (run_A) is pending and was entered before the missed tick:
    // it counts as open blocking evidence alongside operation_B (run_B).
    withCorrelation(CTX_A, () => {
      void attributor.spanAsync('operation_A', () => new Promise(() => { /* pending */ }));
    });
    withCorrelation(CTX_B, () => {
      attributor.span('operation_B', () => { clock.now += 120; });
    });

    scheduler.fire(clock, 0);
    const stall = events.find((event) => event.kind === 'stall') as Extract<LoopStallEvent, { kind: 'stall' }>;
    expect(stall).toBeDefined();
    const byName = new Map(stall.blockedBy.map((span) => [span.name, span]));
    expect(byName.get('operation_A')?.context).toEqual(CTX_A);
    expect(byName.get('operation_B')?.context).toEqual(CTX_B);
    expect(stall.context).toBeUndefined(); // mixed contexts: none rather than a wrong one
    const line = lines.join('\n');
    expect(line).toContain('sid=sess_A');
    expect(line).toContain('sid=sess_B');
    attributor.stop();
  });

  it('renders per-blocker ids in the log line when several contexts are blamed', () => {
    const warn = vi.fn();
    const report = createLoopStallLogReporter({ warn }, { now: () => 0 });
    report({
      kind: 'stall',
      label: '<none>',
      delayMs: 400,
      atMs: 0,
      stack: [],
      blockedBy: [
        { name: 'operation_B', durationMs: 120, context: { requestId: 'req_B', sessionId: 'sess_B', runtime: 'pi' } },
        { name: 'operation_A', durationMs: 70, context: { requestId: 'req_A', sessionId: 'sess_A', runtime: 'pi' } },
      ],
    });
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('operation_B (120 ms [req=req_B sid=sess_B rt=pi])');
    expect(line).toContain('operation_A (70 ms [req=req_A sid=sess_A rt=pi])');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalStallMonitor, loadGoalStallConfig } from '../../../../src/internal-api/goal/goal-stall.js';
import type { SessionGoalProjection } from '../../../../src/internal-api/goal/types.js';

/** W2-b (contract 1.62.0): a running goal on an idle session emits goal_state {stalled:true}. */

const MIN = 60_000;
const running: SessionGoalProjection = { supported: true, status: 'running', objective: 'o', goalId: 'goal_1' };

describe('loadGoalStallConfig', () => {
  it('defaults to 10 minutes, honours GOAL_STALL_MINUTES, never below 2', () => {
    expect(loadGoalStallConfig({}).thresholdMs).toBe(10 * MIN);
    expect(loadGoalStallConfig({ GOAL_STALL_MINUTES: '15' }).thresholdMs).toBe(15 * MIN);
    expect(loadGoalStallConfig({ GOAL_STALL_MINUTES: '1' }).thresholdMs).toBe(2 * MIN);
    expect(loadGoalStallConfig({ GOAL_STALL_MINUTES: '0' }).thresholdMs).toBe(2 * MIN);
    expect(loadGoalStallConfig({ GOAL_STALL_MINUTES: 'nope' }).thresholdMs).toBe(10 * MIN);
  });
});

describe('goal stall monitor', () => {
  let clock: number;
  let busy: boolean;
  let projection: SessionGoalProjection | null;
  let published: Array<{ key: string; type: string; data: Record<string, unknown> }>;
  const make = () => createGoalStallMonitor({
    config: { thresholdMs: 10 * MIN, sweepIntervalMs: 30_000 },
    now: () => clock,
    resolve: async () => ({ busy, projection }),
    publish: (key, event) => published.push({ key, type: event.type, data: event.data as Record<string, unknown> }),
  });

  beforeEach(() => { clock = 1_000_000; busy = false; projection = running; published = []; });
  afterEach(() => vi.useRealTimers());

  it('emits goal_state {stalled:true, stalledForMs} after the threshold — not before', async () => {
    const monitor = make();
    monitor.observe('s1', 'goal_state', running);
    clock += 9 * MIN + 59_000;
    await monitor.sweepOnce();
    expect(published).toHaveLength(0);

    clock += 1_000;
    await monitor.sweepOnce();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ key: 's1', type: 'goal_state' });
    expect(published[0].data).toMatchObject({ status: 'running', stalled: true, stalledForMs: 10 * MIN, goalId: 'goal_1' });
  });

  it('fires once per stall episode', async () => {
    const monitor = make();
    monitor.observe('s1', 'goal_state', running);
    clock += 11 * MIN;
    await monitor.sweepOnce();
    clock += 30 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(1);
  });

  it('re-arms when the session is busy again, then stalls again as a new episode', async () => {
    const monitor = make();
    monitor.observe('s1', 'goal_state', running);
    clock += 11 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(1);

    busy = true;
    await monitor.sweepOnce(); // busy sampled: episode over
    busy = false;
    clock += 5 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(1); // idle clock restarted at the busy sample

    clock += 6 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(2);
  });

  it('runtime activity events between sweeps reset the idle clock; our own stalled event does not', async () => {
    const monitor = make();
    monitor.observe('s1', 'goal_state', running);
    clock += 8 * MIN;
    monitor.observe('s1', 'message_update', {});
    clock += 8 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(0);

    clock += 3 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(1);
    monitor.observe('s1', 'goal_state', { ...running, stalled: true });
    clock += 1 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(1);
  });

  it('never emits for a goal that is not running (paused, terminal) and forgets it', async () => {
    const monitor = make();
    monitor.observe('s1', 'goal_state', running);
    projection = { supported: true, status: 'paused', objective: 'o' };
    clock += 30 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(0);

    monitor.observe('s2', 'goal_state', running);
    monitor.observe('s2', 'goal_end', { supported: true, status: 'achieved' });
    projection = running;
    clock += 30 * MIN;
    await monitor.sweepOnce();
    expect(published).toHaveLength(0);
  });

  it('start() sweeps on a timer (fake timers) and stop() ends it', async () => {
    vi.useFakeTimers();
    let t = 0;
    const m = createGoalStallMonitor({
      config: { thresholdMs: 2 * MIN, sweepIntervalMs: 30_000 },
      now: () => t,
      resolve: async () => ({ busy: false, projection: running }),
      publish: (key, event) => published.push({ key, type: event.type, data: event.data as Record<string, unknown> }),
    });
    m.observe('s1', 'goal_state', running);
    m.start();
    for (let i = 0; i < 3; i++) { t += 30_000; await vi.advanceTimersByTimeAsync(30_000); }
    expect(published).toHaveLength(0);
    for (let i = 0; i < 2; i++) { t += 30_000; await vi.advanceTimersByTimeAsync(30_000); }
    expect(published).toHaveLength(1);
    m.stop();
    t += 10 * MIN;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(published).toHaveLength(1);
  });

  it('a resolve failure for one session never breaks the sweep', async () => {
    const monitor = createGoalStallMonitor({
      config: { thresholdMs: 2 * MIN, sweepIntervalMs: 30_000 },
      now: () => clock,
      resolve: async (key) => { if (key === 'bad') throw new Error('boom'); return { busy: false, projection: running }; },
      publish: (key, event) => published.push({ key, type: event.type, data: event.data as Record<string, unknown> }),
    });
    monitor.observe('bad', 'goal_state', running);
    monitor.observe('good', 'goal_state', running);
    clock += 3 * MIN;
    await monitor.sweepOnce();
    expect(published.map((p) => p.key)).toEqual(['good']);
  });

  it('correction 01: a session that no longer resolves (deleted) is dropped and never re-resolved', async () => {
    let calls = 0;
    const monitor = createGoalStallMonitor({
      config: { thresholdMs: 2 * MIN, sweepIntervalMs: 30_000 },
      now: () => clock,
      resolve: async () => { calls += 1; return null; },
      publish: (key, event) => published.push({ key, type: event.type, data: event.data as Record<string, unknown> }),
    });
    monitor.observe('gone', 'goal_state', running);
    clock += 3 * MIN;
    await monitor.sweepOnce();
    expect(calls).toBe(1);
    await monitor.sweepOnce();
    expect(calls).toBe(1); // dropped: not resolved again
    expect(published).toHaveLength(0);
  });

  it('correction 01: forget(key) drops a tracked goal directly (session deletion hook)', async () => {
    let calls = 0;
    const monitor = createGoalStallMonitor({
      config: { thresholdMs: 2 * MIN, sweepIntervalMs: 30_000 },
      now: () => clock,
      resolve: async () => { calls += 1; return { busy: false, projection: running }; },
      publish: (key, event) => published.push({ key, type: event.type, data: event.data as Record<string, unknown> }),
    });
    monitor.observe('s1', 'goal_state', running);
    monitor.forget('s1');
    clock += 5 * MIN;
    await monitor.sweepOnce();
    expect(calls).toBe(0);
    expect(published).toHaveLength(0);
  });
});

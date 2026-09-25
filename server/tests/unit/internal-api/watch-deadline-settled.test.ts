/**
 * Contract 1.47.0 — C3 server-side `deadline` watch condition and C4
 * `fireIfSettled` registration option.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { describeWatchCondition } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { WatchManager, WatchValidationError, type WatchManagerDeps } from '../../../src/internal-api/watch/watch-manager.js';

function ev(type: string, data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, timestamp: Date.now(), data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WatchManager — C3 deadline condition', () => {
  let dir: string;
  let broker: InternalApiEventBroker;
  let manager: WatchManager;
  const managers: WatchManager[] = [];

  function makeManager(extra: Partial<WatchManagerDeps> = {}): WatchManager {
    const m = new WatchManager({
      broker,
      storeDir: dir,
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      ...extra,
    });
    managers.push(m);
    return m;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-deadline-'));
    broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    manager = makeManager();
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) m.close();
    await sleep(30);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('persists a dueAt and fires exactly once N seconds after registration as a normal firing', async () => {
    const before = Date.now();
    const watch = await manager.register({
      sessionId: 'd1', sessionPath: 'd1', runtime: 'pi',
      request: { conditions: [{ id: 'backstop', type: 'deadline', afterSeconds: 1 }] },
    });
    const cond = watch.conditions[0];
    expect(cond.type).toBe('deadline');
    expect(cond.dueAt).toBeGreaterThanOrEqual(before + 1000);
    expect(cond.dueAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(watch.firingCount).toBe(0);

    // Events never satisfy a deadline condition.
    broker.publish('d1', ev('agent_end'));
    expect(manager.get('d1')!.firingCount).toBe(0);

    await sleep(1300);
    const after = manager.get('d1')!;
    expect(after.firingCount).toBe(1);
    expect(after.firings[0]).toMatchObject({ conditionId: 'backstop', eventType: 'deadline' });
    expect(after.firings[0].firedAt).toBeGreaterThanOrEqual(cond.dueAt!);
    expect(after.conditions[0].fired).toBe(true);
    // Pure observer: completes once its only condition fired.
    expect(after.status).toBe('done');

    // The ledger on disk carries the persisted due time and the firing.
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'd1.json'), 'utf8'));
    expect(raw.conditions[0].dueAt).toBe(cond.dueAt);
    expect(raw.firings).toHaveLength(1);
  });

  it('does not keep the subject busy: snapshot stays idle and records no synthetic event', async () => {
    await manager.register({
      sessionId: 'd2', sessionPath: 'd2', runtime: 'claude',
      request: { conditions: [{ type: 'deadline', afterSeconds: 1 }] },
    });
    await sleep(1200);
    const w = manager.get('d2')!;
    expect(w.firingCount).toBe(1);
    expect(w.snapshot.status).toBe('idle');
    expect(w.snapshot.eventCount).toBe(0);
  });

  it('rejects invalid deadline specs at registration', async () => {
    const bad = [
      { type: 'deadline' },
      { type: 'deadline', afterSeconds: 0 },
      { type: 'deadline', afterSeconds: 86401 },
      { type: 'deadline', afterSeconds: 1.5 },
      { type: 'deadline', afterSeconds: '10' },
      { type: 'deadline', afterSeconds: 10, once: false },
    ];
    for (const spec of bad) {
      await expect(manager.register({
        sessionId: 'dv', sessionPath: 'dv', runtime: 'pi',
        request: { conditions: [spec as never] },
      })).rejects.toBeInstanceOf(WatchValidationError);
    }
    // Boundaries are accepted.
    const ok = await manager.register({
      sessionId: 'dv', sessionPath: 'dv', runtime: 'pi',
      request: { conditions: [{ type: 'deadline', afterSeconds: 86400 }] },
    });
    expect(ok.conditions[0].spec.afterSeconds).toBe(86400);
  });

  it('dispatches the onFire wake with eventType deadline', async () => {
    const dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, runId: 'r-wake' }));
    const m = makeManager({ dispatchWake });
    await m.register({
      sessionId: 'd3', sessionPath: 'd3', runtime: 'pi',
      request: {
        conditions: [{ type: 'deadline', afterSeconds: 1 }],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'deadline {{eventType}} {{conditionId}}' },
      },
    });
    await sleep(1300);
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    const input = (dispatchWake.mock.calls[0] as unknown as [{ message: string; targetSessionId: string }])[0];
    expect(input.targetSessionId).toBe('parent');
    expect(input.message).toBe('deadline deadline c0');
    expect(m.get('d3')!.wakeAttempts[0]).toMatchObject({ status: 'dispatched', runId: 'r-wake' });
  });

  it('cancels the pending deadline when the watch is deleted or replaced', async () => {
    await manager.register({
      sessionId: 'd4', sessionPath: 'd4', runtime: 'pi',
      request: { conditions: [{ type: 'deadline', afterSeconds: 1 }] },
    });
    await manager.delete('d4');
    await manager.register({
      sessionId: 'd5', sessionPath: 'd5', runtime: 'pi',
      request: { conditions: [{ type: 'deadline', afterSeconds: 1 }] },
    });
    await manager.register({
      sessionId: 'd5', sessionPath: 'd5', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    await sleep(1300);
    expect(manager.get('d4')).toBeUndefined();
    expect(manager.get('d5')!.firingCount).toBe(0);
  });

  it('survives a restart: fires on boot when overdue, marked reconciled', async () => {
    await manager.register({
      sessionId: 'd6', sessionPath: 'd6', runtime: 'pi',
      request: { conditions: [{ type: 'deadline', afterSeconds: 3600 }] },
    });
    manager.close();
    await sleep(30);
    // Simulate the server having been down past the due time.
    const file = path.join(dir, 'd6.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const dueAt = Date.now() - 5000;
    raw.conditions[0].dueAt = dueAt;
    await fs.writeFile(file, JSON.stringify(raw));

    const m2 = makeManager();
    await m2.init();
    await sleep(50);
    const w = m2.get('d6')!;
    expect(w.firingCount).toBe(1);
    expect(w.firings[0]).toMatchObject({ eventType: 'deadline', reconciled: true });
    expect(w.status).toBe('done');
  });

  it('survives a restart: a not-yet-due deadline fires at its persisted due time', async () => {
    await manager.register({
      sessionId: 'd7', sessionPath: 'd7', runtime: 'pi',
      request: { conditions: [{ type: 'deadline', afterSeconds: 3600 }] },
    });
    manager.close();
    await sleep(30);
    const file = path.join(dir, 'd7.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.conditions[0].dueAt = Date.now() + 400;
    await fs.writeFile(file, JSON.stringify(raw));

    const m2 = makeManager();
    await m2.init();
    expect(m2.get('d7')!.firingCount).toBe(0);
    await sleep(700);
    const w = m2.get('d7')!;
    expect(w.firingCount).toBe(1);
    expect(w.firings[0].reconciled).toBeUndefined();
  });

  it('describes a deadline condition for surfacing cards', () => {
    expect(describeWatchCondition({ type: 'deadline', afterSeconds: 120 } as never)).toBe('deadline 120s');
  });
});

describe('WatchManager — C4 fireIfSettled', () => {
  let dir: string;
  let broker: InternalApiEventBroker;
  const managers: WatchManager[] = [];

  function makeManager(extra: Partial<WatchManagerDeps> = {}): WatchManager {
    const m = new WatchManager({
      broker,
      storeDir: dir,
      pinSession: vi.fn(() => true),
      unpinSession: vi.fn(() => true),
      ...extra,
    });
    managers.push(m);
    return m;
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-settled-'));
    broker = new InternalApiEventBroker({ replayBufferSize: 10 });
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) m.close();
    await sleep(30);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('records one immediate reconciled firing per completion-type condition when the subject is settled', async () => {
    const getSubjectSettlement = vi.fn(async () => ({ settled: true, lastRunId: 'run-1', lastRunStatus: 'completed' as const }));
    const m = makeManager({ getSubjectSettlement });
    const watch = await m.register({
      sessionId: 's1', sessionPath: '/p/s1.jsonl', runtime: 'pi',
      request: {
        fireIfSettled: true,
        conditions: [
          { id: 'end', type: 'event_type', eventType: 'agent_end' },
          { id: 'goal', type: 'event_type', eventType: 'goal_end' },
          { id: 'tool', type: 'tool', toolName: 'Bash' },
        ],
      },
    });
    expect(getSubjectSettlement).toHaveBeenCalledWith({ sessionId: 's1', sessionPath: '/p/s1.jsonl', runtime: 'pi' });
    expect(watch.firingCount).toBe(2);
    expect(watch.firings.map((f) => f.conditionId).sort()).toEqual(['end', 'goal']);
    for (const f of watch.firings) expect(f.reconciled).toBe(true);
    expect(watch.firings.find((f) => f.conditionId === 'end')!.eventType).toBe('agent_end');
    expect(watch.firings.find((f) => f.conditionId === 'goal')!.eventType).toBe('goal_end');
    expect(watch.pendingConditionIds).toEqual(['tool']);
    expect(watch.fireIfSettled).toMatchObject({
      requested: true, settled: true, lastRunId: 'run-1', firedConditionIds: ['end', 'goal'],
    });
    // Once-semantics still hold for the live stream afterwards.
    broker.publish('s1', ev('agent_end'));
    expect(m.get('s1')!.firings.filter((f) => f.conditionId === 'end')).toHaveLength(1);
  });

  it('records nothing when the subject is not settled, and reports why', async () => {
    const m = makeManager({ getSubjectSettlement: async () => ({ settled: false, reason: 'busy' }) });
    const watch = await m.register({
      sessionId: 's2', sessionPath: 's2', runtime: 'claude',
      request: { fireIfSettled: true, conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(watch.firingCount).toBe(0);
    expect(watch.fireIfSettled).toMatchObject({ requested: true, settled: false, reason: 'busy', firedConditionIds: [] });
  });

  it('default (omitted/false) never consults settlement and keeps the legacy response shape', async () => {
    const getSubjectSettlement = vi.fn(async () => ({ settled: true, lastRunId: 'run-1', lastRunStatus: 'completed' as const }));
    const m = makeManager({ getSubjectSettlement });
    const a = await m.register({
      sessionId: 's3', sessionPath: 's3', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    const b = await m.register({
      sessionId: 's4', sessionPath: 's4', runtime: 'pi',
      request: { fireIfSettled: false, conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(getSubjectSettlement).not.toHaveBeenCalled();
    expect(a.firingCount).toBe(0);
    expect(b.firingCount).toBe(0);
    expect('fireIfSettled' in a).toBe(false);
  });

  it('skips completion conditions that carry a dataMatch it cannot verify', async () => {
    const m = makeManager({ getSubjectSettlement: async () => ({ settled: true, lastRunId: 'r', lastRunStatus: 'completed' as const }) });
    const watch = await m.register({
      sessionId: 's5', sessionPath: 's5', runtime: 'pi',
      request: {
        fireIfSettled: true,
        conditions: [{ id: 'achieved', type: 'event_type', eventType: 'goal_end', dataMatch: { status: 'achieved' } }],
      },
    });
    expect(watch.firingCount).toBe(0);
    expect(watch.fireIfSettled).toMatchObject({ settled: true, firedConditionIds: [], skippedConditionIds: ['achieved'] });
  });

  it('routes the reconciled firing through onFire', async () => {
    const dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, runId: 'wake-run' }));
    const m = makeManager({
      dispatchWake,
      getSubjectSettlement: async () => ({ settled: true, lastRunId: 'r', lastRunStatus: 'failed' as const }),
    });
    await m.register({
      sessionId: 's6', sessionPath: 's6', runtime: 'pi',
      request: {
        fireIfSettled: true,
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'child done' },
      },
    });
    await sleep(50);
    expect(dispatchWake).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-boolean fireIfSettled', async () => {
    const m = makeManager();
    await expect(m.register({
      sessionId: 's7', sessionPath: 's7', runtime: 'pi',
      request: { fireIfSettled: 'yes' as never, conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    })).rejects.toBeInstanceOf(WatchValidationError);
  });

  it('treats an unavailable settlement source as not settled', async () => {
    const m = makeManager();
    const watch = await m.register({
      sessionId: 's8', sessionPath: 's8', runtime: 'pi',
      request: { fireIfSettled: true, conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(watch.firingCount).toBe(0);
    expect(watch.fireIfSettled).toMatchObject({ requested: true, settled: false, reason: 'settlement_unavailable' });
  });
});

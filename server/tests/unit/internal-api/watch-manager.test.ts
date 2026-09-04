import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { WatchManager } from '../../../src/internal-api/watch/watch-manager.js';
import { WatchStore } from '../../../src/internal-api/watch/watch-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { setLogTap, type LogRecord } from '../../../src/logging/logger.js';

function ev(type: string, data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, timestamp: Date.now(), data };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('WatchManager — standing observation + durable ledger', () => {
  let dir: string;
  let broker: InternalApiEventBroker;
  let pin: ReturnType<typeof vi.fn>;
  let unpin: ReturnType<typeof vi.fn>;
  let manager: WatchManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-mgr-'));
    broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    pin = vi.fn(() => true);
    unpin = vi.fn(() => true);
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin });
  });

  afterEach(async () => {
    manager.close();
    await flush(); // let any in-flight ledger write settle before removing the dir
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('records firings for events that arrive with no client connected', async () => {
    const watch = await manager.register({
      sessionId: 's1', sessionPath: 's1', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }, { type: 'tool', toolName: 'Bash' }] },
    });
    expect(watch.pinned).toBe(true);
    expect(pin).toHaveBeenCalledWith('s1', 'watch:watch-s1');

    // Nobody is subscribed via /events — the standing watch is the only observer.
    broker.publish('s1', ev('tool_execution_start', { toolName: 'Bash' }));
    broker.publish('s1', ev('agent_end'));

    const after = manager.get('s1')!;
    expect(after.allFired).toBe(true);
    expect(after.firingCount).toBe(2);
    expect(after.snapshot.toolCallCount).toBe(1);
    expect(after.snapshot.sawAgentEnd).toBe(true);
  });

  it('applies once-semantics (default) — a condition fires only once', async () => {
    await manager.register({
      sessionId: 's2', sessionPath: 's2', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    broker.publish('s2', ev('agent_end'));
    broker.publish('s2', ev('agent_end'));
    const w = manager.get('s2')!;
    expect(w.firingCount).toBe(1);
    expect(w.conditions[0].fireCount).toBe(1);
  });

  it('auto-completes a pure-observer watch after all once conditions fire and releases its claim', async () => {
    await manager.register({
      sessionId: 'done-observer', sessionPath: 'done-observer', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });

    broker.publish('done-observer', ev('agent_end'));
    await flush();

    const done = manager.get('done-observer')!;
    expect(done.status).toBe('done');
    expect(done.allFired).toBe(true);
    expect(done.firingCount).toBe(1);
    expect(done.pinned).toBe(false);
    expect(unpin).toHaveBeenCalledWith('done-observer', 'watch:watch-done-observer');
  });

  it('records every match when once=false', async () => {
    await manager.register({
      sessionId: 's3', sessionPath: 's3', runtime: 'pi',
      request: { conditions: [{ type: 'tool', toolName: 'Bash', once: false }] },
    });
    broker.publish('s3', ev('tool_execution_start', { toolName: 'Bash' }));
    broker.publish('s3', ev('tool_execution_start', { toolName: 'Bash' }));
    expect(manager.get('s3')!.firingCount).toBe(2);
  });

  it('subscribes under both id and path so Pi (path-keyed) events are seen', async () => {
    await manager.register({
      sessionId: 'id1', sessionPath: 'path1', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    // Pi publishes under the session *path*.
    broker.publish('path1', ev('agent_end'));
    expect(manager.get('id1')!.allFired).toBe(true);
  });

  it('persists the ledger so it survives a fresh manager (server restart)', async () => {
    await manager.register({
      sessionId: 's4', sessionPath: 's4', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    broker.publish('s4', ev('agent_end'));
    await flush(); // allow the immediate firing write to hit disk

    // Fresh broker + manager = a real restart. Past firings must still be read.
    const manager2 = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin });
    await manager2.init();
    const reloaded = manager2.get('s4')!;
    expect(reloaded.status).toBe('done');
    expect(reloaded.allFired).toBe(true);
    expect(reloaded.firingCount).toBe(1);
  });

  it('rolls back a newly registered watch when its initial durable write fails', async () => {
    const originalSave = WatchStore.prototype.save;
    const save = vi.spyOn(WatchStore.prototype, 'save')
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockImplementation(originalSave);
    try {
      await expect(manager.register({
        sessionId: 'register-fail', sessionPath: 'register-fail', runtime: 'pi',
        request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
      })).rejects.toThrow('disk unavailable');
      expect(manager.get('register-fail')).toBeUndefined();
    } finally {
      save.mockRestore();
    }
  });

  it('records and retries a failed firing persistence without losing the live firing', async () => {
    const metrics = new OperationalMetrics();
    manager.close();
    manager = new WatchManager({
      broker,
      storeDir: dir,
      pinSession: pin,
      metrics,
      persistenceRetryMs: 5,
    });
    await manager.register({
      sessionId: 'persist-1', sessionPath: 'persist-1', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    const originalSave = WatchStore.prototype.save;
    const save = vi.spyOn(WatchStore.prototype, 'save')
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockImplementation(originalSave);
    const records: LogRecord[] = [];
    setLogTap((record) => records.push(record));
    try {
      broker.publish('persist-1', ev('agent_end'));
      await flush();
      expect(manager.get('persist-1')?.allFired).toBe(true);
      expect(save.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(metrics.snapshot().pipeline.watchPersistenceFailures).toBe(1);
      expect(records.some((record) =>
        record.component === 'WatchManager'
        && record.level === 'warn'
        && record.sessionId === 'persist-1',
      )).toBe(true);
    } finally {
      setLogTap(null);
      save.mockRestore();
    }
  });

  it('releases the old claim when replacing a pinned watch with pin=false', async () => {
    const first = await manager.register({
      sessionId: 'replace', sessionPath: 'replace', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    const replacement = await manager.register({
      sessionId: 'replace', sessionPath: 'replace', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }], pin: false },
    });

    expect(first.replaced).toBe(false);
    expect(replacement.replaced).toBe(true);
    expect(unpin).toHaveBeenCalledWith('replace', 'watch:watch-replace');
    expect(manager.get('replace')?.pinned).toBe(false);
  });

  it('auto-completes a successful one-shot wake and releases subject and target claims', async () => {
    const dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, deliveryKind: 'steer' as const }));
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    await manager.register({
      sessionId: 'done-wake', sessionPath: 'done-wake', runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'done', mode: 'steer' },
      },
    });

    broker.publish('done-wake', ev('agent_end'));
    await flush();

    const done = manager.get('done-wake')!;
    expect(done.status).toBe('done');
    expect(done.wakeAttempts).toMatchObject([{ status: 'dispatched', deliveryKind: 'steer' }]);
    expect(done.pinned).toBe(false);
    expect(unpin).toHaveBeenCalledWith('done-wake', 'watch:watch-done-wake');
    expect(unpin).toHaveBeenCalledWith('parent', 'watch-target:watch-done-wake');
  });

  it('does not complete an all-one-shot watch until its in-flight wake settles', async () => {
    let resolveWake!: (result: { status: 'dispatched'; deliveryKind: 'steer' }) => void;
    const pendingWake = new Promise<{ status: 'dispatched'; deliveryKind: 'steer' }>((resolve) => { resolveWake = resolve; });
    const dispatchWake = vi.fn(() => pendingWake);
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    await manager.register({
      sessionId: 'pending-terminal', sessionPath: 'pending-terminal', runtime: 'pi',
      request: {
        conditions: [
          { id: 'a', type: 'event_type', eventType: 'agent_end' },
          { id: 'b', type: 'event_type', eventType: 'agent_end' },
        ],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'done', mode: 'steer', maxWakeups: 1, cooldownSeconds: 0 },
      },
    });

    broker.publish('pending-terminal', ev('agent_end'));
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.get('pending-terminal')?.status).toBe('active');
    expect(manager.get('pending-terminal')?.wakeAttempts).toMatchObject([
      { status: 'pending' },
      { status: 'suppressed', reason: 'max_wakeups_reached' },
    ]);

    resolveWake({ status: 'dispatched', deliveryKind: 'steer' });
    await flush();
    expect(manager.get('pending-terminal')?.status).toBe('done');
  });

  it.each([
    { maxWakeups: 1, cooldownSeconds: 0, reason: 'max_wakeups_reached' },
    { maxWakeups: 2, cooldownSeconds: 60, reason: 'cooldown' },
  ])('completes an all-one-shot watch when its final wake is suppressed by $reason', async ({ maxWakeups, cooldownSeconds, reason }) => {
    const dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, deliveryKind: 'turn' as const, runId: 'first-run' }));
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    await manager.register({
      sessionId: `suppressed-done-${reason}`, sessionPath: `suppressed-done-${reason}`, runtime: 'pi',
      request: {
        conditions: [
          { type: 'event_type', eventType: 'message_end' },
          { type: 'event_type', eventType: 'agent_end' },
        ],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'done', maxWakeups, cooldownSeconds },
      },
    });

    broker.publish(`suppressed-done-${reason}`, ev('message_end'));
    await flush();
    broker.publish(`suppressed-done-${reason}`, ev('agent_end'));
    await flush();

    const watch = manager.get(`suppressed-done-${reason}`)!;
    expect(watch.wakeAttempts.at(-1)).toMatchObject({ status: 'suppressed', reason });
    expect(watch.status).toBe('done');
    expect(unpin).toHaveBeenCalledWith(`suppressed-done-${reason}`, `watch:watch-suppressed-done-${reason}`);
    expect(unpin).toHaveBeenCalledWith('parent', `watch-target:watch-suppressed-done-${reason}`);
  });

  it('retries one-shot transient wake failure once without spending maxWakeups', async () => {
    const dispatchWake = vi.fn()
      .mockResolvedValueOnce({ status: 'failed', errorCode: 'SESSION_BUSY' })
      .mockResolvedValueOnce({ status: 'dispatched', deliveryKind: 'turn', runId: 'retry-run' });
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    await manager.register({
      sessionId: 'retry-once', sessionPath: 'retry-once', runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: {
          type: 'prompt', targetSessionId: 'parent', message: 'done',
          maxWakeups: 1, cooldownSeconds: 0,
        },
      },
    });

    broker.publish('retry-once', ev('agent_end'));
    await flush();

    expect(dispatchWake).toHaveBeenCalledTimes(2);
    expect(manager.get('retry-once')?.wakeAttempts).toMatchObject([
      { status: 'failed', errorCode: 'SESSION_BUSY' },
      { status: 'dispatched', runId: 'retry-run', deliveryKind: 'turn' },
    ]);
    expect(manager.get('retry-once')?.status).toBe('done');
    expect(unpin).toHaveBeenCalledWith('retry-once', 'watch:watch-retry-once');
    expect(unpin).toHaveBeenCalledWith('parent', 'watch-target:watch-retry-once');
  });

  it('suppresses a second pending steer to the same target without spending its budget', async () => {
    let resolveFirst!: (result: { status: 'dispatched'; deliveryKind: 'steer' }) => void;
    const firstPending = new Promise<{ status: 'dispatched'; deliveryKind: 'steer' }>((resolve) => { resolveFirst = resolve; });
    const dispatchWake = vi.fn(() => firstPending);
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    for (const sessionId of ['steer-a', 'steer-b']) {
      await manager.register({
        sessionId, sessionPath: sessionId, runtime: 'pi',
        request: {
          conditions: [{ type: 'event_type', eventType: 'agent_end' }],
          onFire: { type: 'prompt', targetSessionId: 'same-parent', message: sessionId, mode: 'steer' },
        },
      });
    }

    broker.publish('steer-a', ev('agent_end'));
    broker.publish('steer-b', ev('agent_end'));
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatchWake).toHaveBeenCalledTimes(1);
    expect(manager.get('steer-b')?.wakeAttempts).toMatchObject([
      { status: 'suppressed', reason: 'steer_pending' },
    ]);
    resolveFirst({ status: 'dispatched', deliveryKind: 'steer' });
    await flush();
  });

  it('deletes a watch and stops recording', async () => {
    await manager.register({
      sessionId: 's5', sessionPath: 's5', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(await manager.delete('s5')).toBe(true);
    expect(unpin).toHaveBeenCalledWith('s5', 'watch:watch-s5');
    broker.publish('s5', ev('agent_end')); // no subscriber now
    expect(manager.get('s5')).toBeUndefined();
    expect(await manager.delete('s5')).toBe(false);
  });

  it('rejects an empty condition list and an invalid regex', async () => {
    await expect(manager.register({
      sessionId: 's6', sessionPath: 's6', runtime: 'pi', request: { conditions: [] },
    })).rejects.toThrow();
    await expect(manager.register({
      sessionId: 's6', sessionPath: 's6', runtime: 'pi',
      request: { conditions: [{ type: 'text', pattern: '(' }] },
    })).rejects.toThrow();
  });
});

describe('watch surfacing (contract 1.34.0)', () => {
  let dir: string;
  let broker: InternalApiEventBroker;
  let pin: ReturnType<typeof vi.fn>;
  let manager: WatchManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-surf-'));
    broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    pin = vi.fn(() => true);
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin });
  });

  afterEach(async () => {
    manager.close();
    await flush();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('emits watch_registered to the surface callback with the parent linkage', async () => {
    const surface = vi.fn();
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, surface });
    await manager.register({
      sessionId: 'surf-reg',
      sessionPath: 'surf-reg',
      runtime: 'pi',
      sourceSessionId: 'parent-1',
      sourceBrokerKey: '/sessions/parent.jsonl',
      request: { conditions: [{ id: 'c0', type: 'event_type', eventType: 'agent_end' }], label: 'msb13-fxa-agent_end' },
    });

    expect(surface).toHaveBeenCalledTimes(1);
    const [record, event] = surface.mock.calls[0];
    expect(record).toMatchObject({ watchId: 'watch-surf-reg', sourceSessionId: 'parent-1', sourceBrokerKey: '/sessions/parent.jsonl' });
    expect(event.type).toBe('watch_registered');
    expect(event.data).toMatchObject({
      sessionId: 'parent-1',
      watch: { watchId: 'watch-surf-reg', targetSessionId: 'surf-reg', label: 'msb13-fxa-agent_end', status: 'active' },
    });
    expect(event.data.watch.conditions).toEqual([{ id: 'c0', type: 'event_type', description: 'event agent_end' }]);
  });

  it('does not emit watch_registered when no source linkage exists', async () => {
    const surface = vi.fn();
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, surface });
    await manager.register({
      sessionId: 'surf-reg-nolink', sessionPath: 'surf-reg-nolink', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(surface).not.toHaveBeenCalled();
  });

  it('emits watch_fired once per successful wake with the delivery kind', async () => {
    const surface = vi.fn();
    const dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, deliveryKind: 'steer' as const }));
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, surface, dispatchWake });
    await manager.register({
      sessionId: 'surf-fire',
      sessionPath: 'surf-fire',
      runtime: 'pi',
      sourceSessionId: 'parent-1',
      sourceBrokerKey: '/sessions/parent.jsonl',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'wake up', mode: 'steer' },
      },
    });
    surface.mockClear();

    broker.publish('surf-fire', ev('agent_end'));
    await flush();

    const fired = surface.mock.calls.filter(([, event]) => (event as { type: string }).type === 'watch_fired');
    expect(fired).toHaveLength(1);
    const [record, event] = fired[0];
    expect(record.sourceSessionId).toBe('parent-1');
    expect(event.data).toMatchObject({
      sessionId: 'parent-1',
      watchId: 'watch-surf-fire',
      targetSessionId: 'surf-fire',
      conditionId: 'c0',
      deliveryKind: 'steer',
    });
  });

  it('does not emit watch_fired when the wake fails', async () => {
    const surface = vi.fn();
    const dispatchWake = vi.fn(async () => ({ status: 'failed' as const, errorCode: 'SESSION_BUSY' as const }));
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, surface, dispatchWake });
    await manager.register({
      sessionId: 'surf-fail',
      sessionPath: 'surf-fail',
      runtime: 'pi',
      sourceSessionId: 'parent-1',
      sourceBrokerKey: '/sessions/parent.jsonl',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent', message: 'wake up', mode: 'follow_up' },
      },
    });
    surface.mockClear();

    broker.publish('surf-fail', ev('agent_end'));
    await flush();

    expect(surface.mock.calls.filter(([, event]) => (event as { type: string }).type === 'watch_fired')).toHaveLength(0);
  });

  it('persists sourceSessionId/sourceBrokerKey on the ledger record', async () => {
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin });
    await manager.register({
      sessionId: 'surf-persist',
      sessionPath: 'surf-persist',
      runtime: 'pi',
      sourceSessionId: 'parent-1',
      sourceBrokerKey: '/sessions/parent.jsonl',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(manager.get('surf-persist')).toMatchObject({
      sourceSessionId: 'parent-1',
      sourceBrokerKey: '/sessions/parent.jsonl',
    });
  });
});

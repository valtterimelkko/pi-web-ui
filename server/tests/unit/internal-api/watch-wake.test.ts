import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { WatchManager } from '../../../src/internal-api/watch/watch-manager.js';

function ev(type: string, data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, timestamp: Date.now(), data };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

interface DispatchCall {
  watchId: string;
  targetSessionId: string;
  message: string;
  mode: 'prompt' | 'follow_up';
  idempotencyKey: string;
}

describe('WatchManager — onFire wake dispatch (watch the child, wake the parent)', () => {
  let dir: string;
  let broker: InternalApiEventBroker;
  let pin: ReturnType<typeof vi.fn>;
  let unpin: ReturnType<typeof vi.fn>;
  let dispatchWake: ReturnType<typeof vi.fn>;
  let manager: WatchManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-watch-wake-'));
    broker = new InternalApiEventBroker({ replayBufferSize: 10 });
    pin = vi.fn(() => true);
    unpin = vi.fn(() => true);
    dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, runId: 'run-wake-1' }));
    manager = new WatchManager({
      broker,
      storeDir: dir,
      pinSession: pin,
      unpinSession: unpin,
      dispatchWake,
    });
  });

  afterEach(async () => {
    manager.close();
    await flush();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  function dispatchCalls(): DispatchCall[] {
    return dispatchWake.mock.calls.map((c) => c[0] as DispatchCall);
  }

  it('dispatches a wake to the target session on the first firing and records the attempt', async () => {
    const watch = await manager.register({
      sessionId: 'child-1',
      sessionPath: 'child-1',
      runtime: 'pi',
      request: {
        conditions: [{ id: 'done', type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'Child {{sessionId}} condition {{conditionId}} ({{eventType}}) fired — inspect and continue.' },
      },
    });
    expect(watch.onFire?.targetSessionId).toBe('parent-1');

    broker.publish('child-1', ev('agent_end'));
    await flush();

    expect(dispatchWake).toHaveBeenCalledTimes(1);
    const call = dispatchCalls()[0];
    expect(call.targetSessionId).toBe('parent-1');
    expect(call.watchId).toBe('watch-child-1');
    expect(call.mode).toBe('follow_up'); // default mode
    expect(call.message).toContain('condition done');
    expect(call.message).toContain('agent_end');
    expect(call.idempotencyKey).toContain('watch-child-1');

    const after = manager.get('child-1')!;
    expect(after.wakeAttempts).toHaveLength(1);
    expect(after.wakeAttempts[0].status).toBe('dispatched');
    expect(after.wakeAttempts[0].runId).toBe('run-wake-1');
    expect(after.wakeAttempts[0].targetSessionId).toBe('parent-1');
    expect(after.wakeAttempts[0].conditionId).toBe('done');
  });

  it('caps wake dispatch attempts at maxWakeups (default 1) and records suppressed attempts', async () => {
    await manager.register({
      sessionId: 'child-2',
      sessionPath: 'child-2',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'tool', toolName: 'Bash', once: false }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake', cooldownSeconds: 0 },
      },
    });
    broker.publish('child-2', ev('tool_execution_start', { toolName: 'Bash' }));
    broker.publish('child-2', ev('tool_execution_start', { toolName: 'Bash' }));
    await flush();

    expect(dispatchWake).toHaveBeenCalledTimes(1); // default maxWakeups=1
    const attempts = manager.get('child-2')!.wakeAttempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe('dispatched');
    expect(attempts[1].status).toBe('suppressed');
    expect(attempts[1].reason).toBe('max_wakeups_reached');
  });

  it('suppresses wakes inside the cooldown window and dispatches again once it elapses (cooldown 0)', async () => {
    await manager.register({
      sessionId: 'child-3',
      sessionPath: 'child-3',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'tool', toolName: 'Bash', once: false }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake', maxWakeups: 3, cooldownSeconds: 60 },
      },
    });
    broker.publish('child-3', ev('tool_execution_start', { toolName: 'Bash' }));
    broker.publish('child-3', ev('tool_execution_start', { toolName: 'Bash' }));
    await flush();

    expect(dispatchWake).toHaveBeenCalledTimes(1);
    const attempts = manager.get('child-3')!.wakeAttempts;
    expect(attempts[1].status).toBe('suppressed');
    expect(attempts[1].reason).toBe('cooldown');
  });

  it('interpolates firing evidence only when includeEvidence is true', async () => {
    await manager.register({
      sessionId: 'child-4',
      sessionPath: 'child-4',
      runtime: 'pi',
      request: {
        conditions: [{ id: 'sentinel', type: 'text', contains: 'GOAL-OK' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'Evidence: {{evidence}}' },
      },
    });
    broker.publish('child-4', ev('message_update', { role: 'assistant', text: 'GOAL-OK achieved' }));
    await flush();
    expect(dispatchCalls()[0].message).not.toContain('GOAL-OK');

    await manager.register({
      sessionId: 'child-5',
      sessionPath: 'child-5',
      runtime: 'pi',
      request: {
        conditions: [{ id: 'sentinel', type: 'text', contains: 'GOAL-OK' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'Evidence: {{evidence}}', includeEvidence: true },
      },
    });
    broker.publish('child-5', ev('message_update', { role: 'assistant', text: 'GOAL-OK achieved' }));
    await flush();
    expect(dispatchCalls()[1].message).toContain('GOAL-OK');
  });

  it('records a failed dispatch with its error code', async () => {
    dispatchWake = vi.fn(async () => ({ status: 'failed' as const, errorCode: 'SESSION_BUSY' }));
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    await manager.register({
      sessionId: 'child-6',
      sessionPath: 'child-6',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake' },
      },
    });
    broker.publish('child-6', ev('agent_end'));
    await flush();
    const attempt = manager.get('child-6')!.wakeAttempts[0];
    expect(attempt.status).toBe('failed');
    expect(attempt.errorCode).toBe('SESSION_BUSY');
  });

  it('records a failed attempt when no dispatcher is wired', async () => {
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin });
    await manager.register({
      sessionId: 'child-7',
      sessionPath: 'child-7',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake' },
      },
    });
    broker.publish('child-7', ev('agent_end'));
    await flush();
    const attempt = manager.get('child-7')!.wakeAttempts[0];
    expect(attempt.status).toBe('failed');
    expect(attempt.errorCode).toBe('WAKE_DISPATCH_UNAVAILABLE');
  });

  it('pins the wake target with a source-owned claim by default and releases it on delete', async () => {
    await manager.register({
      sessionId: 'child-8',
      sessionPath: 'child-8',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake' },
      },
    });
    expect(pin).toHaveBeenCalledWith('parent-1', 'watch-target:watch-child-8');

    await manager.delete('child-8');
    expect(unpin).toHaveBeenCalledWith('parent-1', 'watch-target:watch-child-8');
    expect(unpin).toHaveBeenCalledWith('child-8', 'watch:watch-child-8');
  });

  it('skips target pinning when pinTarget is false', async () => {
    await manager.register({
      sessionId: 'child-9',
      sessionPath: 'child-9',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake', pinTarget: false },
      },
    });
    expect(pin).not.toHaveBeenCalledWith('parent-1', expect.anything());
  });

  it('rejects a self-targeting wake at registration', async () => {
    await expect(manager.register({
      sessionId: 'child-10',
      sessionPath: 'child-10',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'child-10', message: 'wake' },
      },
    })).rejects.toThrow(/cannot target its own session/i);
  });

  it('validates the onFire action shape', async () => {
    const base = { conditions: [{ type: 'event_type', eventType: 'agent_end' }] };
    const bad = [
      { type: 'webhook', targetSessionId: 'p', message: 'm' },              // unknown action type
      { type: 'prompt', message: 'm' },                                     // missing target
      { type: 'prompt', targetSessionId: 'p' },                             // missing message
      { type: 'prompt', targetSessionId: 'p', message: '' },                // empty message
      { type: 'prompt', targetSessionId: 'p', message: 'm', mode: 'steer' },// unsupported mode
      { type: 'prompt', targetSessionId: 'p', message: 'm', maxWakeups: 0 },// below 1
      { type: 'prompt', targetSessionId: 'p', message: 'm', maxWakeups: 11 },// above 10
      { type: 'prompt', targetSessionId: 'p', message: 'm', cooldownSeconds: -1 },
      { type: 'prompt', targetSessionId: 'p', message: 'm', cooldownSeconds: 3601 },
    ];
    let i = 0;
    for (const onFire of bad) {
      await expect(manager.register({
        sessionId: `child-bad-${i}`, sessionPath: `child-bad-${i}`, runtime: 'pi',
        request: { ...base, onFire },
      })).rejects.toThrow();
      i += 1;
    }
  });

  it('persists onFire config and wake attempts across a restart', async () => {
    await manager.register({
      sessionId: 'child-11',
      sessionPath: 'child-11',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake {{conditionId}}' },
      },
    });
    broker.publish('child-11', ev('agent_end'));
    await flush();

    const manager2 = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin });
    await manager2.init();
    const reloaded = manager2.get('child-11')!;
    expect(reloaded.status).toBe('detached');
    expect(reloaded.onFire?.targetSessionId).toBe('parent-1');
    expect(reloaded.wakeAttempts).toHaveLength(1);
    expect(reloaded.wakeAttempts[0].status).toBe('dispatched');
    expect(reloaded.wakeAttempts[0].runId).toBe('run-wake-1');
  });

  it('never dispatches or records wake attempts without onFire', async () => {
    await manager.register({
      sessionId: 'child-12',
      sessionPath: 'child-12',
      runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    broker.publish('child-12', ev('agent_end'));
    await flush();
    expect(dispatchWake).not.toHaveBeenCalled();
    expect(manager.get('child-12')!.wakeAttempts).toHaveLength(0);
  });

  it('loads a LEGACY pre-1.22 ledger (no onFire/wakeAttempts/targetPinned fields) safely', async () => {
    // Exact shape found in production ~/.pi-web-ui/watches/ (2026-08-21):
    // records written by 1.21.0 have none of the 1.22.0 fields.
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'legacy-1.json'),
      JSON.stringify({
        watchId: 'watch-legacy-1',
        sessionId: 'legacy-1',
        sessionPath: 'legacy-1',
        runtime: 'pi',
        status: 'active',
        pinned: true,
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        conditions: [{ id: 'agent-end', type: 'event_type', spec: { type: 'event_type', eventType: 'agent_end', id: 'agent-end' }, fired: true, fireCount: 1 }],
        firings: [{ conditionId: 'agent-end', firedAt: 1785348762093, eventType: 'agent_end', evidence: 'event agent_end' }],
        snapshot: { status: 'idle', eventCount: 5, toolCallCount: 0, sawAgentEnd: true },
      }),
    );
    // Fresh manager over the same store = the production restart.
    manager.close();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin, dispatchWake });
    await manager.init();
    const reloaded = manager.get('legacy-1')!;
    expect(reloaded.status).toBe('detached');           // active -> detached on reload (documented)
    expect(reloaded.onFire).toBeUndefined();            // legacy record is a pure observer
    expect(reloaded.wakeAttempts).toEqual([]);           // defensive default, not undefined
    expect(reloaded.firingCount).toBe(1);                // ledger preserved
    // A live event on a detached watch must not dispatch a wake either.
    broker.publish('legacy-1', ev('agent_end'));
    await flush();
    expect(dispatchWake).not.toHaveBeenCalled();
  });

  it('releases the target claim when a watch is replaced without onFire', async () => {
    await manager.register({
      sessionId: 'child-13',
      sessionPath: 'child-13',
      runtime: 'pi',
      request: {
        conditions: [{ type: 'event_type', eventType: 'agent_end' }],
        onFire: { type: 'prompt', targetSessionId: 'parent-1', message: 'wake' },
      },
    });
    await manager.register({
      sessionId: 'child-13',
      sessionPath: 'child-13',
      runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }] },
    });
    expect(unpin).toHaveBeenCalledWith('parent-1', 'watch-target:watch-child-13');
    expect(manager.get('child-13')?.onFire).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { WatchManager } from '../../../src/internal-api/watch/watch-manager.js';

/**
 * C2 (contract 1.57.0) — never-started runs, part 2: the parent's watch fires.
 *
 * A run the start watchdog terminalises as NEVER_STARTED never emits a runtime
 * agent_end, so a parent's standing watch on that child would wait forever —
 * the same shape B4 fixed for restart-interrupted runs at boot. This is the
 * in-flight counterpart: when the watchdog decides NEVER_STARTED, the route
 * layer feeds the decision to the watch manager and completion-type
 * conditions fire through the ordinary event path (once-semantics, wake
 * dispatch, ledger persistence), flagged `runNeverStarted`.
 */

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('WatchManager — never-started run notification (in-flight reconciliation)', () => {
  let dir: string;
  let pin: ReturnType<typeof vi.fn>;
  let unpin: ReturnType<typeof vi.fn>;
  let manager: WatchManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-never-started-watch-'));
    pin = vi.fn(() => true);
    unpin = vi.fn(() => true);
  });

  afterEach(async () => {
    manager?.close();
    await flush();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function arm(sessionId: string, request: Parameters<WatchManager['register']>[0]['request']): Promise<void> {
    const before = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, unpinSession: unpin });
    await before.register({ sessionId, sessionPath: `/sessions/${sessionId}.jsonl`, runtime: 'pi', request });
    await flush();
    before.close();
    await flush();
  }

  it('fires a waiting agent_end watch when the watchdog reports a never-started run', async () => {
    await arm('child-ns', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, unpinSession: unpin });
    await manager.init();
    await flush();

    await manager.notifyRunNeverStarted({
      sessionId: 'child-ns',
      runId: 'run-ns-1',
      runtime: 'pi',
      acceptedAt: new Date(Date.now() - 10_000).toISOString(),
      startWindowMs: 5_000,
      errorCode: 'NEVER_STARTED',
    });
    await flush();

    const w = manager.get('child-ns');
    expect(w?.firingCount).toBe(1);
    expect(w?.firings[0].eventType).toBe('agent_end');
    expect(w?.firings[0].evidence).toContain('never started');
  });

  it('flags the synthetic firing with runNeverStarted so parents can dataMatch it', async () => {
    await arm('child-match', { conditions: [{ type: 'event_type', eventType: 'agent_end', dataMatch: { runNeverStarted: true } }] });
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin });
    await manager.init();
    await flush();

    // An ordinary agent_end must NOT satisfy the dataMatch guard...
    broker.publish('child-match', { type: 'agent_end', timestamp: Date.now(), data: {} } as NormalizedEvent);
    await flush();
    expect(manager.get('child-match')?.firingCount).toBe(0);

    // ...but the never-started notification does.
    await manager.notifyRunNeverStarted({
      sessionId: 'child-match',
      runId: 'run-ns-2',
      runtime: 'pi',
      acceptedAt: new Date(Date.now() - 10_000).toISOString(),
      startWindowMs: 5_000,
      errorCode: 'NEVER_STARTED',
    });
    await flush();
    expect(manager.get('child-match')?.firingCount).toBe(1);
  });

  it('also fires a pending goal_end condition, and coalesces both into a single wake', async () => {
    const dispatchWake = vi.fn(async (_input: { message: string }) => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    await arm('child-goal', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }, { type: 'event_type', eventType: 'goal_end' }],
      onFire: { type: 'prompt', targetSessionId: 'parent-g', message: 'wake', maxWakeups: 3, cooldownSeconds: 0 },
    });
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, dispatchWake });
    await manager.init();
    await flush();

    await manager.notifyRunNeverStarted({
      sessionId: 'child-goal',
      runId: 'run-ns-3',
      runtime: 'pi',
      acceptedAt: new Date(Date.now() - 10_000).toISOString(),
      startWindowMs: 5_000,
      errorCode: 'NEVER_STARTED',
    });
    await flush();

    const w = manager.get('child-goal');
    expect(w?.firingCount).toBe(2);
    expect(dispatchWake).toHaveBeenCalledTimes(1);
  });

  it('ignores sessions with no active watch', async () => {
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin });
    await manager.init();
    await flush();

    await expect(manager.notifyRunNeverStarted({
      sessionId: 'no-watch',
      runId: 'run-ns-4',
      runtime: 'pi',
      acceptedAt: new Date(Date.now() - 10_000).toISOString(),
      startWindowMs: 5_000,
      errorCode: 'NEVER_STARTED',
    })).resolves.toBeUndefined();
  });
});

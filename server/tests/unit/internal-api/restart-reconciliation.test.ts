import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { RunReceiptStore, type PersistedRunReceipt } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { InternalApiEventBroker } from '../../../src/internal-api/event-broker.js';
import { WatchManager, type RestartInterruptedBusySession, type RestartInterruptedRun } from '../../../src/internal-api/watch/watch-manager.js';

/**
 * B4 post-boot reconciliation.
 *
 * Every run cut off by a restart ends `interrupted` with `errorCode:
 * SERVER_RESTART` in its receipt (pre-existing), now classified as
 * `drain_timeout` when a drain announced the cut-off, and — the B4 gap — the
 * parent's standing watch on that child FIRES for it at boot, so the parent
 * learns without polling.
 */

const FIXTURE_NOW = Date.parse('2026-09-29T12:00:00.000Z');

function receipt(overrides: Partial<PersistedRunReceipt> = {}): PersistedRunReceipt {
  return {
    runId: 'run-1',
    sessionId: 'child-1',
    runtime: 'pi',
    executionInstanceId: 'pi-local-default',
    model: 'zai/glm-5.3-flash',
    status: 'started',
    acceptedAt: '2026-09-29T11:59:00.000Z',
    startedAt: '2026-09-29T11:59:01.000Z',
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 30));
const ev = (type: string, data: Record<string, unknown> = {}): NormalizedEvent => ({ type, timestamp: Date.now(), data });

describe('run-receipt restart recovery classification (B4)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-b4-recovery-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });

  async function seed(records: PersistedRunReceipt[]): Promise<void> {
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await store.init();
    for (const r of records) await store.create(r);
    await store.flush();
  }

  it('classifies drain-announced cut-offs as drain_timeout and the rest as server_restart', async () => {
    await seed([
      receipt({ runId: 'cut-by-drain', sessionId: 'child-a' }),
      receipt({ runId: 'unplanned', sessionId: 'child-b', status: 'accepted', startedAt: undefined }),
      receipt({ runId: 'done', sessionId: 'child-c', status: 'completed', terminalAt: '2026-09-29T11:59:30.000Z' }),
    ]);
    const restarted = new RunReceiptStore(dir, {
      now: () => FIXTURE_NOW,
      classifyRecovery: (record) => (record.runId === 'cut-by-drain' ? 'drain_timeout' : 'server_restart'),
    });
    await restarted.init();

    expect(restarted.get('cut-by-drain')).toMatchObject({ status: 'interrupted', errorCode: 'SERVER_RESTART', interruptionReason: 'drain_timeout' });
    expect(restarted.get('unplanned')).toMatchObject({ status: 'interrupted', errorCode: 'SERVER_RESTART', interruptionReason: 'server_restart' });
    expect(restarted.get('done')?.status).toBe('completed');

    const recovered = restarted.getRecoveredRuns().sort((a, b) => a.runId.localeCompare(b.runId));
    expect(recovered).toEqual([
      { runId: 'cut-by-drain', sessionId: 'child-a', runtime: 'pi', terminalAt: new Date(FIXTURE_NOW).toISOString(), errorCode: 'SERVER_RESTART', interruptionReason: 'drain_timeout' },
      { runId: 'unplanned', sessionId: 'child-b', runtime: 'pi', terminalAt: new Date(FIXTURE_NOW).toISOString(), errorCode: 'SERVER_RESTART', interruptionReason: 'server_restart' },
    ]);

    // The classification is durable: a second boot reads it back as valid.
    const third = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await third.init();
    expect(third.get('cut-by-drain')?.interruptionReason).toBe('drain_timeout');
    expect(third.getRecoveredRuns()).toEqual([]);
  });

  it('exposes nonterminal runs and boot-recovered runs through the manager', async () => {
    await seed([receipt({ runId: 'was-running', sessionId: 'child-x' })]);
    const manager = new RunReceiptManager({ store: new RunReceiptStore(dir, { now: () => FIXTURE_NOW }), now: () => FIXTURE_NOW });
    await manager.init();
    try {
      expect(manager.getRestartRecoveredRuns().map((r) => r.runId)).toEqual(['was-running']);
      expect(manager.listNonterminal()).toEqual([]);
      const begun = await manager.beginRun({ sessionId: 'child-y', runtime: 'pi', executionInstanceId: 'pi-local-default', message: 'hi', mode: 'prompt' } as never);
      expect(begun.kind).toBe('created');
      expect(manager.listNonterminal()).toEqual([
        { runId: begun.receipt.runId, sessionId: 'child-y', runtime: 'pi', status: 'accepted' },
      ]);
    } finally {
      await manager.shutdown();
    }
  });
});

describe('WatchManager fires parents\' watches for restart-interrupted runs (B4)', () => {
  let dir: string;
  let manager: WatchManager | undefined;
  const pin = vi.fn(() => true);

  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-b4-watch-')); });
  afterEach(async () => {
    manager?.close();
    manager = undefined;
    await flush();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function arm(sessionId: string, request: Parameters<WatchManager['register']>[0]['request'], extra: Partial<ConstructorParameters<typeof WatchManager>[0]> = {}): Promise<void> {
    const before = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, ...extra });
    await before.register({ sessionId, sessionPath: `/sessions/${sessionId}.jsonl`, runtime: 'pi', request });
    await flush();
    before.close();
    await flush();
  }

  const interrupted = (sessionId: string, runId: string, interruptionReason = 'drain_timeout'): RestartInterruptedRun => ({
    runId, sessionId, runtime: 'pi', terminalAt: new Date(Date.now() + 5_000).toISOString(), errorCode: 'SERVER_RESTART', interruptionReason,
  });

  it('fires an agent_end watch on a cut-off child at boot, with interruption evidence', async () => {
    await arm('child-1', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: async () => [interrupted('child-1', 'run-9')],
    });
    await manager.init();
    await flush();
    const w = manager.get('child-1');
    expect(w?.firingCount).toBe(1);
    expect(w?.status).toBe('done');
    expect(w?.firings[0].eventType).toBe('agent_end');
    expect(w?.firings[0].evidence).toContain('interrupted by restart');
    expect(w?.firings[0].evidence).toContain('run-9');
    expect(w?.firings[0].evidence).toContain('drain_timeout');
  });

  it('wakes the parent through onFire without any polling', async () => {
    const dispatchWake = vi.fn(async () => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    await arm('child-2', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }],
      onFire: { type: 'prompt', targetSessionId: 'parent-2', message: 'child {{sessionId}} ended: {{evidence}}', includeEvidence: true, cooldownSeconds: 0 },
    }, { dispatchWake });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, dispatchWake,
      getRestartInterruptedRuns: () => [interrupted('child-2', 'run-2', 'server_restart')],
    });
    await manager.init();
    await flush();
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    const call = dispatchWake.mock.calls[0] as unknown as [{ targetSessionId: string; message: string }];
    expect(call[0].targetSessionId).toBe('parent-2');
    expect(call[0].message).toContain('interrupted by restart');
  });

  // Correction 01, finding 4: the wake text itself must say "interrupted",
  // whatever the parent's message template and includeEvidence (default false).
  it.each([
    ['a generic message', 'your child is done'],
    ['an {{eventType}} template', 'child {{sessionId}} finished ({{eventType}}): {{evidence}}'],
  ])('states the interruption in the wake text for %s with includeEvidence off', async (_label, message) => {
    const dispatchWake = vi.fn(async (_input: { message: string }) => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    await arm('child-w', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }],
      onFire: { type: 'prompt', targetSessionId: 'parent-w', message, cooldownSeconds: 0 },
    }, { dispatchWake });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, dispatchWake,
      getRestartInterruptedRuns: () => [interrupted('child-w', 'run-w', 'drain_timeout')],
    });
    await manager.init();
    await flush();
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    const text = dispatchWake.mock.calls[0][0].message;
    expect(text).toContain('(interrupted by restart: run run-w, drain_timeout)');
    expect(text).not.toContain('[evidence excluded] (interrupted');
  });

  it('does not add the interruption suffix to an ordinary completion wake (control)', async () => {
    const dispatchWake = vi.fn(async (_input: { message: string }) => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, dispatchWake });
    await manager.register({
      sessionId: 'child-n', sessionPath: '/sessions/child-n.jsonl', runtime: 'pi',
      request: { conditions: [{ type: 'event_type', eventType: 'agent_end' }], onFire: { type: 'prompt', targetSessionId: 'parent-n', message: 'your child is done', cooldownSeconds: 0 } },
    });
    broker.publish('child-n', ev('agent_end'));
    await flush();
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    expect(dispatchWake.mock.calls[0][0].message).toBe('your child is done');
  });

  // Correction 01, finding 5: one interruption wakes a parent once.
  it('coalesces the agent_end and goal_end reconciliation firings into a single wake', async () => {
    const dispatchWake = vi.fn(async (_input: { message: string }) => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    await arm('child-g', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }, { type: 'event_type', eventType: 'goal_end' }],
      onFire: { type: 'prompt', targetSessionId: 'parent-g', message: 'wake', maxWakeups: 3, cooldownSeconds: 0 },
    }, { dispatchWake });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, dispatchWake,
      getRestartInterruptedRuns: () => [interrupted('child-g', 'run-g')],
    });
    await manager.init();
    await flush();
    const w = manager.get('child-g');
    expect(w?.firingCount).toBe(2);
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    expect(w?.wakeAttempts.map((a) => [a.status, a.reason])).toEqual([['dispatched', undefined], ['suppressed', 'coalesced_restart_reconciliation']]);
  });

  it('lets a parent watch only interruptions via dataMatch, and ordinary agent_end does not match it', async () => {
    await arm('child-3', { conditions: [{ type: 'event_type', eventType: 'agent_end', dataMatch: { interruptedByRestart: true } }] });
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({ broker, storeDir: dir, pinSession: pin, getRestartInterruptedRuns: () => [] });
    await manager.init();
    broker.publish('child-3', ev('agent_end'));
    await flush();
    expect(manager.get('child-3')?.firingCount).toBe(0);
    manager.close();

    manager = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, getRestartInterruptedRuns: () => [interrupted('child-3', 'run-3')] });
    await manager.init();
    await flush();
    expect(manager.get('child-3')?.firingCount).toBe(1);
  });

  it('also fires a pending goal_end condition, flagged as an interruption rather than a goal verdict', async () => {
    await arm('goal-child', { conditions: [{ type: 'event_type', eventType: 'goal_end' }] });
    manager = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, getRestartInterruptedRuns: () => [interrupted('goal-child', 'run-g')] });
    await manager.init();
    await flush();
    const w = manager.get('goal-child');
    expect(w?.firingCount).toBe(1);
    expect(w?.firings[0].eventType).toBe('goal_end');
    expect(w?.firings[0].evidence).toContain('interrupted by restart');
  });

  it('coalesces several interrupted runs of one session into one reconciliation', async () => {
    await arm('child-4', { conditions: [{ type: 'event_type', eventType: 'agent_end', once: false }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: () => [interrupted('child-4', 'run-a'), interrupted('child-4', 'run-b')],
    });
    await manager.init();
    await flush();
    expect(manager.get('child-4')?.firingCount).toBe(1);
  });

  it('does not double-fire with downtime reconciliation for the same session', async () => {
    const armedAt = Date.now();
    await arm('child-5', { conditions: [{ type: 'event_type', eventType: 'agent_end', once: false }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      // The child advanced (streamed) before the kill, so downtime reconciliation alone would fire too.
      getSessionLastActivity: async () => armedAt + 1_000,
      getRestartInterruptedRuns: () => [interrupted('child-5', 'run-5')],
    });
    await manager.init();
    await flush();
    expect(manager.get('child-5')?.firingCount).toBe(1);
  });

  it('ignores sessions with no watch and watches that do not wait on completion', async () => {
    await arm('child-6', { conditions: [{ type: 'text', pattern: 'DONE' }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: () => [interrupted('child-6', 'run-6'), interrupted('no-watch', 'run-7')],
    });
    await manager.init();
    await flush();
    expect(manager.get('child-6')?.firingCount).toBe(0);
    expect(manager.get('no-watch')).toBeUndefined();
  });

  it('survives a failing interrupted-run source without blocking boot', async () => {
    await arm('child-8', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: async () => { throw new Error('boom'); },
    });
    await expect(manager.init()).resolves.toBeUndefined();
    await flush();
    expect(manager.get('child-8')?.status).toBe('active');
  });
});

describe('WatchManager fires parents\' watches for receipt-less busy sessions cut off by a restart (B4.1)', () => {
  let dir: string;
  let manager: WatchManager | undefined;
  const pin = vi.fn(() => true);

  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-b41-watch-')); });
  afterEach(async () => {
    manager?.close();
    manager = undefined;
    await flush();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function arm(sessionId: string, request: Parameters<WatchManager['register']>[0]['request'], extra: Partial<ConstructorParameters<typeof WatchManager>[0]> = {}): Promise<void> {
    const before = new WatchManager({ broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, ...extra });
    await before.register({ sessionId, sessionPath: `/sessions/${sessionId}.jsonl`, runtime: 'pi', request });
    await flush();
    before.close();
    await flush();
  }

  // What the server composes at boot from the drain record's cut-off sessions
  // that have no recovered run receipt.
  const busy = (sessionId: string, runId = `busy-${sessionId}`, interruptionReason = 'drain_timeout'): RestartInterruptedBusySession => ({
    sessionId, runtime: 'pi', runId, errorCode: 'SERVER_RESTART', interruptionReason,
  });

  const receiptRun = (sessionId: string, runId: string, interruptionReason = 'drain_timeout'): RestartInterruptedRun => ({
    runId, sessionId, runtime: 'pi', terminalAt: new Date(Date.now() + 5_000).toISOString(), errorCode: 'SERVER_RESTART', interruptionReason,
  });

  it('fires an agent_end watch for a receipt-less busy session with the synthetic interruption reference', async () => {
    await arm('goal-1', { conditions: [{ type: 'event_type', eventType: 'agent_end', dataMatch: { interruptedByRestart: true } }] });
    const broker = new InternalApiEventBroker();
    manager = new WatchManager({
      broker, storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: () => [],
      getRestartInterruptedBusySessions: () => [busy('goal-1')],
    });
    await manager.init();
    await flush();
    const w = manager.get('goal-1');
    expect(w?.firingCount).toBe(1);
    expect(w?.firings[0].eventType).toBe('agent_end');
    expect(w?.firings[0].evidence).toContain('interrupted by restart');
    expect(w?.firings[0].evidence).toContain('busy-goal-1');
    expect(w?.firings[0].evidence).toContain('drain_timeout');
  });

  it('names the synthetic reference in the wake text so the parent never mistakes it for a normal finish', async () => {
    const dispatchWake = vi.fn(async (_input: { message: string }) => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    await arm('goal-2', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }],
      onFire: { type: 'prompt', targetSessionId: 'parent-2', message: 'child {{sessionId}} finished: {{evidence}}', cooldownSeconds: 0 },
    }, { dispatchWake });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, dispatchWake,
      getRestartInterruptedRuns: () => [],
      getRestartInterruptedBusySessions: () => [busy('goal-2')],
    });
    await manager.init();
    await flush();
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    expect(dispatchWake.mock.calls[0][0].message).toContain('(interrupted by restart: run busy-goal-2, drain_timeout)');
  });

  it('also fires a pending goal_end, coalesced into one wake (B4.1)', async () => {
    const dispatchWake = vi.fn(async (_input: { message: string }) => ({ status: 'dispatched' as const, deliveryKind: 'prompt' as const }));
    await arm('goal-3', {
      conditions: [{ type: 'event_type', eventType: 'agent_end' }, { type: 'event_type', eventType: 'goal_end' }],
      onFire: { type: 'prompt', targetSessionId: 'parent-3', message: 'wake', maxWakeups: 3, cooldownSeconds: 0 },
    }, { dispatchWake });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin, dispatchWake,
      getRestartInterruptedRuns: () => [],
      getRestartInterruptedBusySessions: () => [busy('goal-3')],
    });
    await manager.init();
    await flush();
    const w = manager.get('goal-3');
    expect(w?.firingCount).toBe(2);
    expect(dispatchWake).toHaveBeenCalledTimes(1);
    expect(w?.wakeAttempts.map((a) => [a.status, a.reason])).toEqual([['dispatched', undefined], ['suppressed', 'coalesced_restart_reconciliation']]);
  });

  it('a session with recovered receipts wins over its busy entry: one firing, receipt data, no busy flag', async () => {
    await arm('child-both', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: () => [receiptRun('child-both', 'run-both')],
      getRestartInterruptedBusySessions: () => [busy('child-both')],
    });
    await manager.init();
    await flush();
    const w = manager.get('child-both');
    expect(w?.firingCount).toBe(1);
    expect(w?.firings[0].evidence).toContain('run-both');
    expect(w?.firings[0].evidence).not.toContain('busy-');
  });

  it('ignores busy sessions with no watch (control)', async () => {
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: () => [],
      getRestartInterruptedBusySessions: () => [busy('no-watch')],
    });
    await expect(manager.init()).resolves.toBeUndefined();
    await flush();
    expect(manager.get('no-watch')).toBeUndefined();
  });

  it('survives a failing busy-session source without blocking the receipt reconciliation', async () => {
    await arm('child-r', { conditions: [{ type: 'event_type', eventType: 'agent_end' }] });
    manager = new WatchManager({
      broker: new InternalApiEventBroker(), storeDir: dir, pinSession: pin,
      getRestartInterruptedRuns: () => [receiptRun('child-r', 'run-r')],
      getRestartInterruptedBusySessions: () => { throw new Error('busy source down'); },
    });
    await expect(manager.init()).resolves.toBeUndefined();
    await flush();
    expect(manager.get('child-r')?.firingCount).toBe(1);
  });
});

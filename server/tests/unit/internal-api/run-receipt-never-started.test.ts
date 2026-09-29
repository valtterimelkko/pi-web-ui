import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { buildStallNotification } from '../../../src/internal-api/run-receipts/stall-notification.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * C2 (contract 1.57.0) — never-started runs, part 1: the start watchdog.
 *
 * Plan §6 C2: "an accepted run with no runtime activity within a configurable
 * start window is marked with a distinct terminal state and the parent is
 * notified." Today such a run waits for the full 15-minute idle window and is
 * then reported as TURN_STALLED — the parent learns late, and the code name
 * asserts a turn that never existed.
 *
 * The distinct terminal state is a `failed` receipt with errorCode
 * `NEVER_STARTED`, decided inside a configurable start window
 * (`runStartWindowMs`), classified `no_activity` (the run never produced a
 * single unit of work), and reported through the `onRunNeverStarted` hook so
 * the parent's watch can be fired.
 */

const baseInput: BeginRunInput = {
  sessionId: 'session-start',
  runtime: 'pi',
  executionInstanceId: 'pi-local-default',
  model: 'zai/glm-5.3-flash',
  message: 'run the task',
  mode: 'prompt',
  verbosity: 'answers',
  detach: false,
};

describe('RunReceiptManager — never-started start window', () => {
  let dir: string;
  let now: number;
  let nextId: number;
  let metrics: OperationalMetrics;
  const managers: RunReceiptManager[] = [];

  const makeManager = (overrides: Partial<ConstructorParameters<typeof RunReceiptManager>[0]> = {}) => {
    const m = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      idempotencyTtlMs: 1_000,
      metrics,
      turnIdleTimeoutMs: 900_000,
      turnMaxMs: 21_600_000,
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  const reconcile = (m: RunReceiptManager) =>
    (m as unknown as { reconcileStalledRuns: () => Promise<void> }).reconcileStalledRuns();

  const startedEvent = (): NormalizedEvent => ({ type: 'agent_start', timestamp: now, data: {} });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-never-started-'));
    now = Date.parse('2026-09-29T12:00:00.000Z');
    nextId = 0;
    metrics = new OperationalMetrics({ now: () => now });
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('terminalises a run with no activity inside the start window as NEVER_STARTED and fires onRunNeverStarted', async () => {
    const onRunNeverStarted = vi.fn();
    const m = makeManager({ runStartWindowMs: 5_000, onRunNeverStarted });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 6_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCode).toBe('NEVER_STARTED');
    expect(receipt.liveness?.watchdog?.reason).toBe('no_activity');
    expect(receipt.liveness?.watchdog?.startWindowMs).toBe(5_000);
    expect(onRunNeverStarted).toHaveBeenCalledTimes(1);
    expect(onRunNeverStarted.mock.calls[0][0].runId).toBe(run.receipt.runId);
    expect(onRunNeverStarted.mock.calls[0][0].sessionId).toBe('session-start');
  });

  it('does not terminalise a run that produced activity inside the start window', async () => {
    const onRunNeverStarted = vi.fn();
    const m = makeManager({ runStartWindowMs: 5_000, onRunNeverStarted });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);
    await m.observeEvent(run.receipt.runId, startedEvent());

    now += 6_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('started');
    expect(receipt.errorCode).toBeUndefined();
    expect(onRunNeverStarted).not.toHaveBeenCalled();
  });

  it('uses the configured default start window when no override is given (120s)', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 60_000;
    await reconcile(m);
    expect(m.get(run.receipt.runId)!.status).toBe('started');

    now += 60_000; // 120s total: at the default start window
    await reconcile(m);
    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCode).toBe('NEVER_STARTED');
  });

  it('runStartWindowMs 0 disables start detection (legacy behaviour at the idle window)', async () => {
    const onRunNeverStarted = vi.fn();
    const m = makeManager({ runStartWindowMs: 0, onRunNeverStarted });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 900_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCode).toBe('TURN_STALLED');
    expect(onRunNeverStarted).not.toHaveBeenCalled();
  });

  it('exempts a still-queued follow_up receipt: queue-pending is legitimate, not a never-started runtime', async () => {
    const onRunNeverStarted = vi.fn();
    const m = makeManager({ runStartWindowMs: 5_000, onRunNeverStarted });
    await m.init();
    const run = await m.beginRun({ ...baseInput, mode: 'follow_up', dispatchMode: 'follow_up' });
    await m.markQueued(run.receipt.runId);

    now += 6_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('queued');
    expect(receipt.errorCode).toBeUndefined();
    expect(onRunNeverStarted).not.toHaveBeenCalled();
  });

  it('start-window classification wins over the idle classification when both windows elapsed with no activity', async () => {
    const m = makeManager({ runStartWindowMs: 5_000 });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 900_000; // far past both the start window and the idle window
    await reconcile(m);

    expect(m.get(run.receipt.runId)!.errorCode).toBe('NEVER_STARTED');
  });

  it('operator notification wording says the run never started (not quarantined, not lost-wake-at-idle)', () => {
    const notice = buildStallNotification({
      runId: 'run-ns',
      sessionId: 'session-start',
      status: 'failed',
      errorCode: 'NEVER_STARTED',
      liveness: { watchdog: { reason: 'no_activity', startWindowMs: 5_000, idleTimeoutMs: 900_000 } },
    });
    expect(notice.title).toContain('NEVER_STARTED');
    expect(notice.body).toMatch(/never started|never began|start window/i);
    expect(notice.body).not.toMatch(/quarantin/i);
  });
});

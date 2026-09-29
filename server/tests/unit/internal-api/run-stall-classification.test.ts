import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * Why a stalled run stalled (2026-09-15).
 *
 * Run `5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f` was a wake dispatched to session
 * `01a0a410` at 08:36:09, marked started 20 ms later, and then produced
 * **nothing at all** — zero assistant messages, zero tool calls, and not one
 * eligible activity event. At 08:51:10 (exactly the 15-minute idle window) the
 * watchdog terminalised it as `TURN_STALLED` with `watchdog.reason = 'idle'`,
 * and the operator was told a run had been quarantined.
 *
 * The wake text never reached the session. Labelling that "idle" asserts a turn
 * was executing and went quiet; the run never executed. These tests pin the
 * distinction between the two, because it is the difference between "a turn
 * stalled" and "your wake was silently lost".
 */

const baseInput: BeginRunInput = {
  sessionId: 'session-stall',
  runtime: 'pi',
  executionInstanceId: 'pi-local-default',
  model: 'provider/model',
  message: 'run the task',
  mode: 'prompt',
  verbosity: 'answers',
  detach: false,
};

describe('RunReceiptManager — stall classification', () => {
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
      // Production values (config.ts): a 15-minute idle window under a 6-hour
      // absolute ceiling. Keeping them real matters — an absolute ceiling below
      // the idle window would make every case look 'absolute'.
      turnIdleTimeoutMs: 900_000,
      turnMaxMs: 21_600_000,
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  const reconcile = (m: RunReceiptManager) =>
    (m as unknown as { reconcileStalledRuns: () => Promise<void> }).reconcileStalledRuns();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-stall-'));
    now = Date.parse('2026-09-15T08:36:09.000Z');
    nextId = 0;
    metrics = new OperationalMetrics({ now: () => now });
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('classifies a run that never produced a single activity event as no_activity, not idle', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    // The whole 15-minute window passes with nothing — the 5a62bf6c shape.
    now += 900_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('failed');
    // C2 (contract 1.57.0): with start detection on (the default), the run is
    // known as NEVER_STARTED at the start window, long before 15 minutes. The
    // reason still refuses to claim a turn was running.
    expect(receipt.errorCode).toBe('NEVER_STARTED');
    expect(receipt.liveness?.watchdog?.reason).toBe('no_activity');
    expect(receipt.liveness?.watchdog?.startWindowMs).toBe(120_000);
    // Delivery failure is not work failure: nothing was ever observed.
    expect(receipt.outputEvidence).toMatchObject({ assistantMessages: 0, toolCalls: 0, disposition: 'unknown' });
    expect(receipt.liveness?.lastEligibleActivity).toBeUndefined();
  });

  it('still reports TURN_STALLED no_activity at the idle window when start detection is disabled', async () => {
    const m = makeManager({ runStartWindowMs: 0 });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 900_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCode).toBe('TURN_STALLED');
    expect(receipt.liveness?.watchdog?.reason).toBe('no_activity');
    expect(receipt.liveness?.watchdog?.startWindowMs).toBeUndefined();
    expect(receipt.outputEvidence).toMatchObject({ assistantMessages: 0, toolCalls: 0, disposition: 'unknown' });
  });

  it('still reports idle when a turn really was producing activity and then went quiet', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 500;
    await m.observeEvent(run.receipt.runId, {
      type: 'message_update',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: { assistantMessageEvent: { type: 'text_delta', delta: 'working' } },
    } as NormalizedEvent);

    // Go idle relative to the LAST activity, not to acceptance.
    now += 900_100;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.liveness?.watchdog?.reason).toBe('idle');
    expect(receipt.outputEvidence).toMatchObject({ assistantTextChars: 7 });
  });

  it('still reports absolute when the ceiling is reached, whatever the activity', async () => {
    const m = makeManager({ turnIdleTimeoutMs: 900_000, turnMaxMs: 5_000 });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 6_000;
    await reconcile(m);

    expect(m.get(run.receipt.runId)?.liveness?.watchdog?.reason).toBe('absolute');
  });

  it('leaves a queue-pending follow_up alone at the idle window (C2: queue-pending is not a stalled runtime)', async () => {
    // The queue_while_busy shape: a pi follow_up accepted onto a busy session is
    // parked until the session drains it, so it can produce no activity at all.
    // Before C2 the idle watchdog terminalised it TURN_STALLED at 15 minutes —
    // the receipt lied while the queue was still legitimate. The 2026-09-15
    // lost-wake shape (busy state with no live turn) is now refused at accept
    // (C2 follow_up live-turn requirement), so a queue that stays pending is
    // honestly pending, and delivery truth governs the receipt from there.
    const m = makeManager();
    await m.init();
    const run = await m.beginRun({ ...baseInput, mode: 'follow_up', dispatchMode: 'follow_up' });
    await m.markQueued(run.receipt.runId);

    now += 900_000;
    await reconcile(m);

    const receipt = m.get(run.receipt.runId)!;
    expect(receipt.status).toBe('queued');
    expect(receipt.errorCode).toBeUndefined();
  });

  it('passes the honest reason to the never-started callback so the operator can be told the truth', async () => {
    const onStalled = vi.fn();
    const onRunNeverStarted = vi.fn();
    const m = makeManager({ onStalled, onRunNeverStarted });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 900_000;
    await reconcile(m);

    // C2 (contract 1.57.0): a run that never produced work is a NEVER_STARTED,
    // not a stalled turn — the quarantine-flavoured onStalled hook must NOT
    // fire for it (nothing was in flight).
    expect(onRunNeverStarted).toHaveBeenCalledTimes(1);
    expect(onStalled).not.toHaveBeenCalled();
    const receipt = onRunNeverStarted.mock.calls[0][0];
    expect(receipt.liveness?.watchdog?.reason).toBe('no_activity');
    expect(receipt.errorCode).toBe('NEVER_STARTED');
    expect(receipt.runId).toBe(run.receipt.runId);
  });

  it('persists no_activity so the receipt is self-describing after a restart', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);
    now += 900_000;
    await reconcile(m);
    await m.shutdown();

    // Read the durable record from disk: this is what a restart, an operator or
    // the persistence validator actually sees. An unlisted reason value would
    // be dropped or rejected here.
    const persisted = JSON.parse(
      await fs.readFile(path.join(dir, `${run.receipt.runId}.json`), 'utf8'),
    ) as { liveness?: { watchdog?: { reason?: string } } };
    expect(persisted.liveness?.watchdog?.reason).toBe('no_activity');
  });
});

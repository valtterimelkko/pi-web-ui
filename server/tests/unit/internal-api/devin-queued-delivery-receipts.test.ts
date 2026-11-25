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
 * Lane A (W1) — receipt-owned delivery evidence for a queued message.
 *
 * Root cause (audit §2A, verified in this worktree): a Devin follow-up that the
 * service put in its FIFO queue was recorded `started` before any runtime call
 * (routes/sessions.ts:1432 wake, :4399 ordinary), so the start watchdog judged
 * "never began executing" while the item was still waiting and later ran. The
 * operator notice then asserted non-execution and advised a re-dispatch that
 * could duplicate real work.
 *
 * These tests pin the receipt side of the correction:
 *  - a queued message carries its own delivery evidence (queued → dispatched),
 *  - the start clock is measured from dispatch, not acceptance,
 *  - a proven-removed item can release its permit and say "never dispatched",
 *  - late activity is preserved as evidence and never re-labelled,
 *  - the notice wording never advises a retry it cannot prove safe.
 */

const baseInput: BeginRunInput = {
  sessionId: 'devin-session-1',
  runtime: 'devin',
  executionInstanceId: 'devin-local-default',
  model: 'swe-2-flash-medium',
  message: 'wake: child finished',
  mode: 'follow_up',
  dispatchMode: 'follow_up',
  verbosity: 'answers',
  detach: true,
};

describe('RunReceiptManager — queued delivery evidence (lane A)', () => {
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
      runStartWindowMs: 120_000,
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  const reconcile = (m: RunReceiptManager) =>
    (m as unknown as { reconcileStalledRuns(): Promise<void> }).reconcileStalledRuns();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-delivery-'));
    now = 1_000_000;
    nextId = 0;
    metrics = new OperationalMetrics();
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) {
      await m.shutdown().catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  // ── 1. Delivery state is its own evidence ────────────────────────────────

  it('records a queued run as queued-with-delivery-evidence and dispatches it later', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;

    await m.markQueued(runId);
    const queued = m.get(runId)!;
    expect(queued.status).toBe('queued');
    expect(queued.liveness?.delivery).toMatchObject({ state: 'queued', basis: 'follow_up_queue' });
    expect(queued.liveness?.delivery?.observedAt).toBe(new Date(now).toISOString());
    // Never dispatched yet: no start timestamp anywhere.
    expect(queued.startedAt).toBeUndefined();

    now += 60_000;
    await m.markStarted(runId);
    const started = m.get(runId)!;
    expect(started.status).toBe('started');
    expect(started.liveness?.delivery).toMatchObject({ state: 'dispatched', basis: 'dequeue' });
    expect(started.startedAt).toBe(new Date(now).toISOString());
  });

  // ── 2. The start window is measured from dispatch, not acceptance ────────

  it('does not fail a run that waited in the queue longer than the start window before dispatch', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;

    await m.markQueued(runId);
    // Wait far past the start window while legitimately queued: the queue is
    // not a runtime that failed to start.
    now += 300_000;
    await reconcile(m);
    expect(m.get(runId)!.status).toBe('queued');

    // Dispatch happens now; the start clock begins here.
    await m.markStarted(runId);
    now += 1_000;
    await reconcile(m);
    expect(m.get(runId)!.status).toBe('started');

    // Still started (with its own activity) inside the window from dispatch.
    await m.observeEvent(runId, { type: 'agent_start', timestamp: now, data: {} } as NormalizedEvent);
    now += 60_000;
    await reconcile(m);
    expect(m.get(runId)!.status).toBe('started');
  });

  it('still fails a run that produced nothing inside the start window measured from dispatch', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;

    await m.markQueued(runId);
    now += 300_000;
    await m.markStarted(runId);
    now += 121_000;
    await reconcile(m);

    expect(m.get(runId)!.status).toBe('failed');
    expect(m.get(runId)!.errorCode).toBe('NEVER_STARTED');
  });

  it('negative control: an ordinary dispatched Pi run is still failed at the start window', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun({ ...baseInput, runtime: 'pi', executionInstanceId: 'pi-local-default', mode: 'prompt', dispatchMode: 'prompt' });
    await m.markStarted(run.receipt.runId);
    now += 121_000;
    await reconcile(m);
    expect(m.get(run.receipt.runId)!.status).toBe('failed');
    expect(m.get(run.receipt.runId)!.errorCode).toBe('NEVER_STARTED');
  });

  // ── 3. Targeted removal is proven non-execution ──────────────────────────

  it('marketItemRemoved records proven non-execution and releases only that item', async () => {
    const m = makeManager();
    await m.init();
    const lease = { release: vi.fn() };
    const run = await m.beginRun({ ...baseInput, idempotencyKey: 'wake-key-1' });
    const runId = run.receipt.runId;
    m.attachLease(runId, lease);
    await m.markQueued(runId);

    const terminal = await m.markItemRemoved(runId);
    expect(terminal?.status).toBe('cancelled');
    expect(terminal?.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'targeted_removal' });
    // Proven never-dispatched is positive cessation: it releases immediately,
    // it does not enter the drain fence.
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(m.getDrainingCount()).toBe(0);
    expect(m.hasActiveRun(baseInput.sessionId)).toBe(false);
    // Same-key retry still replays the terminal receipt (key is NOT burned).
    const retry = await m.beginRun({ ...baseInput, idempotencyKey: 'wake-key-1' });
    expect(retry.kind).toBe('duplicate');
    expect(retry.kind === 'duplicate' ? retry.receipt.runId : undefined).toBe(runId);
    expect(retry.kind === 'duplicate' ? retry.receipt.status : undefined).toBe('cancelled');
  });

  it('a queued run that can no longer be proven either way stays unconfirmed and holds its lease', async () => {
    const m = makeManager();
    await m.init();
    const lease = { release: vi.fn() };
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    m.attachLease(runId, lease);
    await m.markQueued(runId);

    const terminal = await m.markItemUnconfirmed(runId, 'queue_state_unknown');
    expect(terminal?.status).toBe('failed');
    expect(terminal?.liveness?.delivery).toMatchObject({ state: 'unconfirmed', basis: 'queue_state_unknown' });
    // Cessation is not confirmed, so the tentatively-held permit is not freed
    // here: an unknown outcome must never release capacity.
    expect(m.get(runId)!.liveness?.cessation.state).not.toBe('confirmed');
  });

  // ── 4. Late activity is evidence, never a rewrite ───────────────────────

  it('keeps decision-time lastEligibleActivity when a late agent_end arrives on a terminal receipt', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;

    await m.markStarted(runId);
    now += 121_000;
    await reconcile(m);
    const decided = m.get(runId)!;
    expect(decided.status).toBe('failed');
    expect(decided.errorCode).toBe('NEVER_STARTED');
    const decisionTimeActivity = decided.liveness?.lastEligibleActivity;
    expect(decisionTimeActivity).toBeUndefined();
    const terminalAt = decided.terminalAt;

    // The item then really runs and ends. That is late evidence.
    now += 5_000;
    await m.observeEvent(runId, { type: 'agent_end', timestamp: now, data: {} } as NormalizedEvent);
    const after = m.get(runId)!;

    expect(after.status).toBe('failed'); // never reopened
    expect(after.errorCode).toBe('NEVER_STARTED');
    expect(after.terminalAt).toBe(terminalAt);
    expect(after.liveness?.terminalObservations?.at(-1)).toMatchObject({ type: 'agent_end', late: true });
    // A late terminal observation must not be stamped as decision-time activity.
    expect(after.liveness?.lastEligibleActivity).toBeUndefined();
    expect(after.liveness?.delivery).toMatchObject({ state: 'late_terminal_observed', basis: 'late_terminal' });
  });

  // ── 5. The notice never claims what it cannot prove ─────────────────────

  it('NEVER_STARTED with proven removal keeps the retry advice and names the removal', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    await m.markQueued(runId);
    const removed = await m.markItemRemoved(runId);

    const notice = buildStallNotification(removed!);
    expect(notice.body).toMatch(/removed from the session's follow-up queue/i);
    expect(notice.body).toMatch(/re-dispatch it/i);
    expect(notice.body).toMatch(/new idempotency key/i);
  });

  it('NEVER_STARTED without proven removal forbids a blind re-dispatch', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    await m.markStarted(runId);
    now += 121_000;
    await reconcile(m);
    const decided = m.get(runId)!;

    const notice = buildStallNotification(decided);
    expect(notice.body).not.toMatch(/re-dispatch it/i);
    expect(notice.body).toMatch(/unconfirmed|has not been shown/i);
    // The obsolete blanket claim must be gone for this state.
    expect(notice.body).not.toMatch(/nothing to clean up/i);
  });

  it('a late-terminal contradiction notice says the evidence is contradictory', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    await m.markQueued(runId);
    await m.markItemRemoved(runId);
    await m.observeEvent(runId, { type: 'agent_end', timestamp: now + 1_000, data: {} } as NormalizedEvent);
    const after = m.get(runId)!;

    const notice = buildStallNotification(after);
    expect(after.liveness?.delivery?.state).toBe('late_terminal_observed');
    expect(after.status).toBe('cancelled'); // status never rewritten
    expect(notice.body).toMatch(/contradict/i);
    // No retry advice of any kind: the message may already have run.
    expect(notice.body).not.toMatch(/if the work still matters|if the wake still matters/i);
  });
});

/**
 * Lane A (W1) — the boundaries R0 named explicitly: the shared watchdog change
 * (Pi negative control), the restart annotation, and the two cancellation races.
 */
describe('RunReceiptManager — queued delivery boundaries (lane A)', () => {
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
      runStartWindowMs: 120_000,
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  const reconcile = (m: RunReceiptManager) =>
    (m as unknown as { reconcileStalledRuns(): Promise<void> }).reconcileStalledRuns();

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-bounds-'));
    now = 1_000_000;
    nextId = 0;
    metrics = new OperationalMetrics();
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('exempts a queued item from BOTH the start and idle windows, and never aborts the live turn', async () => {
    const cancelQueuedDelivery = vi.fn(async () => 'removed' as const);
    const m = makeManager({ cancelQueuedDelivery });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markQueued(run.receipt.runId);

    // Past the start window (120 s) AND past the idle window (900 s), still
    // short of the 6 h absolute ceiling.
    now += 1_000_000;
    await reconcile(m);

    expect(m.get(run.receipt.runId)!.status).toBe('queued');
    expect(m.get(run.receipt.runId)!.errorCode).toBeUndefined();
    // Nothing was aborted and no removal was attempted inside the windows.
    expect(cancelQueuedDelivery).not.toHaveBeenCalled();
  });

  it('at the absolute ceiling removes ONLY its own item and records proven non-execution', async () => {
    const cancelQueuedDelivery = vi.fn(async () => 'removed' as const);
    const lease = { release: vi.fn() };
    const m = makeManager({ cancelQueuedDelivery });
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    m.attachLease(runId, lease);
    await m.markQueued(runId);

    now += 21_600_001;
    await reconcile(m);

    expect(cancelQueuedDelivery).toHaveBeenCalledWith(runId, baseInput.sessionId, 'devin');
    const after = m.get(runId)!;
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'targeted_removal' });
    // Proven removal confirms non-execution: only this item's permit is freed.
    expect(lease.release).toHaveBeenCalledTimes(1);
    expect(m.getDrainingCount()).toBe(0);
  });

  it('at the absolute ceiling with an unprovable removal stays unconfirmed and holds the permit behind the fence', async () => {
    const cancelQueuedDelivery = vi.fn(async () => 'unknown' as const);
    const lease = { release: vi.fn() };
    // The cessation fence only exists when the quiescence probe is wired; supply
    // it so "unconfirmed cessation holds the permit" is actually testable.
    const isRuntimeQuiescent = vi.fn(async () => false);
    const m = makeManager({ cancelQueuedDelivery, isRuntimeQuiescent, drainTimeoutMs: 60_000, drainPollMs: 1_000 });
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    m.attachLease(runId, lease);
    await m.markQueued(runId);

    now += 21_600_001;
    await reconcile(m);

    const after = m.get(runId)!;
    expect(after.status).toBe('failed');
    expect(after.liveness?.delivery).toMatchObject({ state: 'unconfirmed' });
    // Unknown must never release capacity: the permit is held behind the fence.
    expect(lease.release).not.toHaveBeenCalled();
    expect(m.getDrainingCount()).toBe(1);
  });

  it('does not claim non-execution when the dequeue won the race to the ceiling', async () => {
    const cancelQueuedDelivery = vi.fn(async () => 'dispatched' as const);
    const m = makeManager({ cancelQueuedDelivery });
    await m.init();
    const run = await m.beginRun(baseInput);
    const runId = run.receipt.runId;
    await m.markQueued(runId);

    now += 21_600_001;
    await reconcile(m);

    // The item is executing; nothing was terminalised as "never dispatched".
    const after = m.get(runId)!;
    expect(after.status).toBe('queued');
    expect(after.liveness?.delivery?.state).toBe('queued');
  });

  it('negative control: a dispatched Pi run still uses the shared clocks unchanged', async () => {
    const m = makeManager();
    await m.init();
    const pi = await m.beginRun({
      sessionId: 'pi-session', runtime: 'pi', executionInstanceId: 'pi-local-default',
      message: 'work', mode: 'prompt', verbosity: 'answers', detach: true,
    });
    await m.markStarted(pi.receipt.runId);
    // Pi dispatched receipts carry no queue-delivery evidence at all.
    expect(m.get(pi.receipt.runId)!.liveness?.delivery).toBeUndefined();
    now += 121_000;
    await reconcile(m);
    expect(m.get(pi.receipt.runId)!.errorCode).toBe('NEVER_STARTED');
  });

  it('annotates a receipt that was still queued at restart as proven non-execution', async () => {
    const storeDir = path.join(dir, 'restart-receipts');
    const storeA = new RunReceiptStore(storeDir, { now: () => now });
    const a = new RunReceiptManager({ store: storeA, now: () => now, idFactory: () => 'run-queued', metrics });
    await a.init();
    await a.markQueued((await a.beginRun({ ...baseInput, idempotencyKey: 'kq' })).receipt.runId);
    await storeA.flush();
    await a.shutdown();

    // A new process scans the same directory.
    const storeB = new RunReceiptStore(storeDir, { now: () => now });
    const b = new RunReceiptManager({ store: storeB, now: () => now, idFactory: () => 'run-other', metrics });
    await b.init();
    const recovered = b.get('run-queued')!;
    expect(recovered.status).toBe('interrupted');
    expect(recovered.errorCode).toBe('SERVER_RESTART');
    expect(recovered.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'memory_queue_lost_at_restart' });
    await b.shutdown();
  });

  it('does NOT claim proven non-execution for a receipt that was already started at restart', async () => {
    const storeDir = path.join(dir, 'restart-started');
    const storeA = new RunReceiptStore(storeDir, { now: () => now });
    const a = new RunReceiptManager({ store: storeA, now: () => now, idFactory: () => 'run-started', metrics });
    await a.init();
    const runId = (await a.beginRun({ ...baseInput, idempotencyKey: 'ks' })).receipt.runId;
    await a.markQueued(runId);
    await a.markStarted(runId);
    await storeA.flush();
    await a.shutdown();

    const storeB = new RunReceiptStore(storeDir, { now: () => now });
    const b = new RunReceiptManager({ store: storeB, now: () => now, idFactory: () => 'run-x', metrics });
    await b.init();
    const recovered = b.get('run-started')!;
    expect(recovered.status).toBe('interrupted');
    // Started at boot is the real unknown, never a safe-to-retry claim.
    expect(recovered.liveness?.delivery).toMatchObject({ state: 'unconfirmed', basis: 'memory_queue_lost_at_restart' });
    await b.shutdown();
  });
});

/**
 * Lane A (W1), R0 §8: "Never infer restart-safe retry for generic Pi queued
 * state without checking its implementation."
 *
 * The checked implementation differs per runtime:
 *   - Devin: the `started` transition is written inside the AWAITED dequeue
 *     barrier, BEFORE the prompt reaches the runtime. So a Devin receipt still
 *     `queued` at boot proves the message never started.
 *   - Pi: `markQueued` is written before `agentSession.followUp(...)`, and
 *     `started` is only written when a `message_start` event is observed
 *     (routes/sessions.ts queuePiFollowUp / the queued-run observer). A crash in
 *     between leaves a receipt `queued` whose message may already be delivered
 *     and executing. Queued-at-boot is therefore NOT proof for Pi.
 */
describe('RunReceiptManager — restart annotation is runtime-specific (lane A)', () => {
  let dir: string;
  let now: number;
  let metrics: OperationalMetrics;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-restart-'));
    now = 1_000_000;
    metrics = new OperationalMetrics();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  async function queuedThenRestart(runtime: 'devin' | 'pi'): Promise<string> {
    const storeDir = path.join(dir, `restart-${runtime}`);
    const storeA = new RunReceiptStore(storeDir, { now: () => now });
    const a = new RunReceiptManager({ store: storeA, now: () => now, idFactory: () => `run-${runtime}`, metrics });
    await a.init();
    const runId = (await a.beginRun({
      ...baseInput,
      runtime,
      executionInstanceId: runtime === 'pi' ? 'pi-local-default' : 'devin-local-default',
      idempotencyKey: `k-${runtime}`,
    })).receipt.runId;
    await a.markQueued(runId);
    await storeA.flush();
    await a.shutdown();

    const b = new RunReceiptManager({ store: new RunReceiptStore(storeDir, { now: () => now }), now: () => now, idFactory: () => 'run-x', metrics });
    await b.init();
    const recovered = b.get(runId)!;
    expect(recovered.status).toBe('interrupted');
    await b.shutdown();
    return runId;
  }

  it('Devin: a receipt still queued at boot proves non-execution (write-ahead barrier)', async () => {
    const runId = await queuedThenRestart('devin');
    const storeDir = path.join(dir, 'restart-devin');
    const b = new RunReceiptManager({ store: new RunReceiptStore(storeDir, { now: () => now }), now: () => now, idFactory: () => 'run-y', metrics });
    await b.init();
    expect(b.get(runId)!.liveness?.delivery).toMatchObject({
      state: 'cancelled_before_dispatch',
      basis: 'memory_queue_lost_at_restart',
    });
    await b.shutdown();
  });

  it('Pi: a receipt still queued at boot stays UNCONFIRMED — queued is not write-ahead proof there', async () => {
    const runId = await queuedThenRestart('pi');
    const storeDir = path.join(dir, 'restart-pi');
    const b = new RunReceiptManager({ store: new RunReceiptStore(storeDir, { now: () => now }), now: () => now, idFactory: () => 'run-z', metrics });
    await b.init();
    // Pi writes `queued` before the SDK call and only stamps `started` when it
    // observes delivery, so this receipt may have run. Claiming proven
    // non-execution here would invite a duplicate dispatch.
    expect(b.get(runId)!.liveness?.delivery).toMatchObject({
      state: 'unconfirmed',
      basis: 'memory_queue_lost_at_restart',
    });
    await b.shutdown();
  });
});

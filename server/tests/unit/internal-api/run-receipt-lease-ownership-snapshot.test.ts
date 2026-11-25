import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

/**
 * Lane A correction (03-parent-correction.md §1) — `getLeaseOwnershipSnapshot`.
 *
 * This is Lane B's mandatory input: a synchronous, read-only, identity-true
 * census of ACTUAL ATTACHED ADMISSION LEASES, so `unexplained = admission -
 * sum(snapshot)` is a real remainder rather than a blind subtraction.
 *
 * Contract fixed by the parent (`02-answer.md` §B, restated in §1 of the
 * correction):
 *  - `activeByRuntime`   — runs holding a lease, EXCLUDING queued receipts.
 *  - `queuedByRuntime`   — runs holding a lease whose delivery is still queued.
 *  - `drainingByRuntime` — terminal runs still holding their lease, not yet
 *                          quarantined.
 *  - `quarantinedByRuntime` — the quarantined SUBSET of draining (counted once,
 *                          never in both).
 *  - The four counts are a DISJOINT partition of the lease-holding population.
 *  - Ownership is `ActiveRun.lease` presence, NOT receipt existence or status
 *    alone: a joined/steer receipt and a Pi queued follow-up hold NO lease and
 *    must count zero, or they would mask a genuine leak.
 *  - Already-loaded maps only: no disk await, no store read, no lock.
 */

const baseInput: BeginRunInput = {
  sessionId: 'session-lease',
  runtime: 'devin',
  executionInstanceId: 'devin-local-default',
  model: 'swe-2-flash-medium',
  message: 'work',
  mode: 'prompt',
  verbosity: 'answers',
  detach: true,
};

const zeroSum = (snap: ReturnType<RunReceiptManager['getLeaseOwnershipSnapshot']>): number =>
  Object.values(snap.activeByRuntime).reduce<number>((n, v) => n + (v ?? 0), 0)
  + Object.values(snap.queuedByRuntime).reduce<number>((n, v) => n + (v ?? 0), 0)
  + Object.values(snap.drainingByRuntime).reduce<number>((n, v) => n + (v ?? 0), 0)
  + Object.values(snap.quarantinedByRuntime).reduce<number>((n, v) => n + (v ?? 0), 0);

describe('RunReceiptManager.getLeaseOwnershipSnapshot (lane A correction §1)', () => {
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
      runStartWindowMs: 0,
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-lease-'));
    now = 1_000_000;
    nextId = 0;
    metrics = new OperationalMetrics();
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('returns four empty maps for a manager with nothing attached', async () => {
    const m = makeManager();
    await m.init();
    expect(m.getLeaseOwnershipSnapshot()).toEqual({
      activeByRuntime: {},
      queuedByRuntime: {},
      drainingByRuntime: {},
      quarantinedByRuntime: {},
    });
  });

  it('counts a started run with an attached lease as active', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    expect(m.getLeaseOwnershipSnapshot().activeByRuntime).toEqual({});
    m.attachLease(run.receipt.runId, { release: () => undefined });
    await m.markStarted(run.receipt.runId);

    expect(m.getLeaseOwnershipSnapshot()).toEqual({
      activeByRuntime: { devin: 1 },
      queuedByRuntime: {},
      drainingByRuntime: {},
      quarantinedByRuntime: {},
    });
  });

  it('separates a queued receipt WITH a lease from active, and counts it once', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun({ ...baseInput, mode: 'follow_up', dispatchMode: 'follow_up' });
    m.attachLease(run.receipt.runId, { release: () => undefined });
    await m.markQueued(run.receipt.runId);

    const snap = m.getLeaseOwnershipSnapshot();
    expect(snap.queuedByRuntime).toEqual({ devin: 1 });
    // Active explicitly EXCLUDES queued: the two categories never overlap.
    expect(snap.activeByRuntime).toEqual({});
    expect(zeroSum(snap)).toBe(1);
  });

  it('does NOT count an unleased joined/steer receipt (the leak-masking case)', async () => {
    const m = makeManager();
    await m.init();
    const joined = await m.beginRun({ ...baseInput, mode: 'steer', dispatchMode: 'steer' });
    // A joined receipt observes another request's turn: no lease is ever attached.
    await m.markStarted(joined.receipt.runId);

    expect(m.getLeaseOwnershipSnapshot()).toEqual({
      activeByRuntime: {},
      queuedByRuntime: {},
      drainingByRuntime: {},
      quarantinedByRuntime: {},
    });
    expect(m.hasActiveRun(baseInput.sessionId)).toBe(true); // it IS tracked...
    expect(zeroSum(m.getLeaseOwnershipSnapshot())).toBe(0); // ...but owns no permit
  });

  it('does NOT count an unleased Pi queued follow-up receipt', async () => {
    const m = makeManager();
    await m.init();
    const queued = await m.beginRun({
      ...baseInput,
      sessionId: 'pi-session',
      runtime: 'pi',
      executionInstanceId: 'pi-local-default',
      mode: 'follow_up',
      dispatchMode: 'follow_up',
    });
    // Pi queued follow-ups return before any permit is acquired.
    await m.markQueued(queued.receipt.runId);

    expect(m.getLeaseOwnershipSnapshot()).toEqual({
      activeByRuntime: {},
      queuedByRuntime: {},
      drainingByRuntime: {},
      quarantinedByRuntime: {},
    });
  });

  it('moves a lease out of active into draining on a cessation-unconfirmed terminal', async () => {
    const isRuntimeQuiescent = vi.fn(async () => false);
    const m = makeManager({ isRuntimeQuiescent, drainTimeoutMs: 60_000, drainPollMs: 1_000 });
    await m.init();
    const run = await m.beginRun(baseInput);
    m.attachLease(run.receipt.runId, { release: () => undefined });
    await m.markStarted(run.receipt.runId);

    await m.finish(run.receipt.runId, { status: 'cancelled' });

    const snap = m.getLeaseOwnershipSnapshot();
    expect(snap.activeByRuntime).toEqual({});
    expect(snap.drainingByRuntime).toEqual({ devin: 1 });
    expect(snap.quarantinedByRuntime).toEqual({});
    expect(zeroSum(snap)).toBe(1); // still exactly one lease
  });

  it('splits quarantine out of draining without double-counting, then releases', async () => {
    const isRuntimeQuiescent = vi.fn(async () => false);
    // drainTimeoutMs must be > 0: positiveTimeout() treats 0 as "unset".
    const m = makeManager({ isRuntimeQuiescent, drainTimeoutMs: 40, drainPollMs: 10 });
    await m.init();
    const run = await m.beginRun(baseInput);
    m.attachLease(run.receipt.runId, { release: () => undefined });
    await m.markStarted(run.receipt.runId);
    await m.finish(run.receipt.runId, { status: 'cancelled' });

    // Let the drain deadline elapse: the entry becomes quarantined.
    const deadline = Date.now() + 3_000;
    while (m.getQuarantinedCount() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const snap = m.getLeaseOwnershipSnapshot();
    expect(snap.quarantinedByRuntime).toEqual({ devin: 1 });
    expect(snap.drainingByRuntime).toEqual({}); // the subset is NOT also draining
    expect(zeroSum(snap)).toBe(1); // one lease, counted once

    // The reconciliation guard releases it once the session is quiescent.
    isRuntimeQuiescent.mockResolvedValue(true);
    await (m as unknown as { reconcileQuarantined(): Promise<void> }).reconcileQuarantined();
    expect(zeroSum(m.getLeaseOwnershipSnapshot())).toBe(0);
  });

  it('partitions several runtimes independently and sums to the lease population', async () => {
    const m = makeManager();
    await m.init();

    const devin = await m.beginRun(baseInput);
    m.attachLease(devin.receipt.runId, { release: () => undefined });
    await m.markStarted(devin.receipt.runId);

    const devin2 = await m.beginRun({ ...baseInput, sessionId: 'devin-2' });
    m.attachLease(devin2.receipt.runId, { release: () => undefined });
    await m.markStarted(devin2.receipt.runId);

    const pi = await m.beginRun({
      ...baseInput, sessionId: 'pi-1', runtime: 'pi', executionInstanceId: 'pi-local-default',
    });
    m.attachLease(pi.receipt.runId, { release: () => undefined });
    await m.markStarted(pi.receipt.runId);

    const queuedDevin = await m.beginRun({ ...baseInput, sessionId: 'devin-3', mode: 'follow_up', dispatchMode: 'follow_up' });
    m.attachLease(queuedDevin.receipt.runId, { release: () => undefined });
    await m.markQueued(queuedDevin.receipt.runId);

    const snap = m.getLeaseOwnershipSnapshot();
    expect(snap.activeByRuntime).toEqual({ devin: 2, pi: 1 });
    expect(snap.queuedByRuntime).toEqual({ devin: 1 });
    expect(snap.drainingByRuntime).toEqual({});
    expect(zeroSum(snap)).toBe(4);
  });

  it('is synchronous and reads no store/disk (no await, no lock)', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    m.attachLease(run.receipt.runId, { release: () => undefined });
    await m.markStarted(run.receipt.runId);

    // A settlement probe must be readable in ONE synchronous tick: any promise
    // or disk read would make Lane B's subtraction read a different moment.
    const snap = m.getLeaseOwnershipSnapshot();
    expect(snap).not.toBeInstanceOf(Promise);
    expect(typeof snap.activeByRuntime.devin).toBe('number');
  });

  it('is read-only: repeated calls never change the population', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    m.attachLease(run.receipt.runId, { release: () => undefined });
    await m.markStarted(run.receipt.runId);

    expect(m.getLeaseOwnershipSnapshot()).toEqual(m.getLeaseOwnershipSnapshot());
    expect(m.hasActiveRun(baseInput.sessionId)).toBe(true);
  });
});

/**
 * Lane A correction 05 §1 — the acceptance ceiling must stay BOUNDED.
 *
 * The parent's probe (`../reviews/a-parent-ceiling-probe.test.ts`) showed a
 * queued item can escape the frozen bounded acceptance budget forever: the
 * service reserves the item in `activeQueueItems` BEFORE the awaited
 * `onDispatched` barrier runs, so a targeted cancellation answers `dispatched`.
 * `expireQueuedRun` treated that as "executing after all" and simply returned on
 * every tick, so `markStarted` never landed and the receipt stayed `queued` for
 * any multiple of the absolute age.
 *
 * The honest bounded resolution: a reservation is NOT a confirmed dispatch. After
 * a bounded grace past the ceiling the receipt is terminalised as UNCONFIRMED —
 * never as non-execution (that would be a lie, the service may still run it) and
 * never by aborting the session's unrelated work.
 */
describe('lane A correction 05 §1 — bounded acceptance ceiling', () => {
  let dir: string;
  let now: number;
  let managers: RunReceiptManager[] = [];

  /** Bind a queued run whose cancellation resolver always answers `dispatched`. */
  const queuedWithReservation = async (m: RunReceiptManager) => {
    const run = await m.beginRun({
      sessionId: 's', runtime: 'devin', executionInstanceId: 'd', model: 'x', message: 'm',
      mode: 'follow_up', verbosity: 'answers', detach: true, dispatchMode: 'follow_up',
    });
    const id = run.receipt.runId;
    await m.markQueued(id);
    m.attachLease(id, { release: () => undefined });
    m.setCancelQueuedDelivery(async () => 'dispatched');
    return id;
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lane-a-ceiling-'));
    now = Date.now(); // anchor at real time so acceptedAt is not in the future
    managers = [];
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  const make = (overrides: Record<string, unknown> = {}) => {
    const m = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }), now: () => now,
      // A positive start window: runStartWindowMs 0 is rejected by the
      // receipt validation, so the fence's terminal write would fail silently.
      turnIdleTimeoutMs: 900_000, turnMaxMs: 60_000, runStartWindowMs: 600_000,
      dispatchBarrierGraceMs: 1, // deterministic: the bound is the property, not 60 s of wall clock
      ...overrides,
    });
    managers.push(m);
    return m;
  };

  it('PARENT PROBE: a reserved-but-never-stamped item cannot stay queued forever', async () => {
    const m = make();
    await m.init();
    const id = await queuedWithReservation(m);

    // Forward in time, past the absolute ceiling, repeatedly: the budget is
    // frozen, so the run must eventually leave `queued` rather than returning
    // forever merely because the service reserved it.
    const start = now;
    for (const t of [70_000, 100_000, 200_000, 400_000, 800_000]) {
      now = start + t;
      await (m as unknown as { reconcileStalledRuns(): Promise<void> }).reconcileStalledRuns();
    }

    const after = m.get(id)!;
    expect(after.status, 'absolute acceptance budget must stay bounded').not.toBe('queued');
    expect(after.status).toBe('failed');
    // Honest: the service reserved it, so execution cannot be ruled out.
    expect(after.liveness?.delivery).toMatchObject({ state: 'unconfirmed', basis: 'dispatch_barrier_expired' });
    // Bound but NOT a lie about non-execution.
    expect(after.liveness?.delivery?.state).not.toBe('cancelled_before_dispatch');
  });

  it('does not terminalise on the first reservation tick: a real dispatch still wins', async () => {
    const m = make();
    await m.init();
    const id = await queuedWithReservation(m);
    const base = now;

    now = base + 70_000;
    await (m as unknown as { reconcileStalledRuns(): Promise<void> }).reconcileStalledRuns();
    // The FIRST reservation tick only records the intent: the barrier may still
    // land, so the run is left alone.
    expect(m.get(id)!.status).toBe('queued');

    // The barrier lands late but legitimately: `started` is then governed by the
    // EXISTING execution clocks, not by the acceptance ceiling.
    await m.markStarted(id);
    expect(m.get(id)!.status).toBe('started');
    expect(m.get(id)!.liveness?.delivery).toMatchObject({ state: 'dispatched', basis: 'dequeue' });
  });

  it('a genuinely removed item still records PROVEN non-execution, unchanged', async () => {
    const m = make();
    await m.init();
    const id = await queuedWithReservation(m);
    m.setCancelQueuedDelivery(async () => 'removed');

    now = now + 70_000;
    await (m as unknown as { reconcileStalledRuns(): Promise<void> }).reconcileStalledRuns();

    const after = m.get(id)!;
    expect(after.status).toBe('cancelled');
    expect(after.liveness?.delivery).toMatchObject({ state: 'cancelled_before_dispatch', basis: 'targeted_removal' });
  });
});

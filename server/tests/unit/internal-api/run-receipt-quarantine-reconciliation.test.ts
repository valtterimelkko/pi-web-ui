import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

/**
 * L1 (R5 follow-up): the §11 fence quarantines a terminal run's admission
 * lease when runtime cessation stays unconfirmed for the whole drain window.
 * Production (2026-10-03) showed those entries are held FOREVER — nothing
 * re-checks after the session actually settles, so phantom "active turns"
 * pile up memory reservations until a restart (the admission-count leak).
 *
 * These tests pin the reconciliation guard: a quarantined entry is re-checked
 * at a slower cadence and released only when the WHOLE session is confirmed
 * quiescent — never while any of that session's runtime work may still run.
 */

const baseInput: BeginRunInput = {
  sessionId: 'session-1',
  runtime: 'pi',
  executionInstanceId: 'pi-local-default',
  model: 'provider/model',
  message: 'run the task',
  mode: 'prompt',
  verbosity: 'answers',
  detach: false,
};

interface Harness {
  manager: RunReceiptManager;
  store: RunReceiptStore;
  metrics: OperationalMetrics;
  dir: string;
  setNow: (ms: number) => void;
  getNow: () => number;
  nextId: () => string;
}

async function makeHarness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'l1-quarantine-'));
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  let idCounter = 0;
  const metrics = new OperationalMetrics({ now: () => now });
  const store = new RunReceiptStore(dir, { now: () => now });
  const manager = new RunReceiptManager({
    store,
    now: () => now,
    idFactory: () => `l1-${++idCounter}`,
    idempotencyTtlMs: 1_000,
    metrics,
    drainPollMs: 5,
    drainTimeoutMs: 50,
    quarantineReconcileMs: 20,
    isRuntimeQuiescent: async () => quiescent,
  });
  await manager.init();
  return {
    manager,
    store,
    metrics,
    dir,
    setNow: (ms: number) => { now = ms; },
    getNow: () => now,
    nextId: () => `l1-${idCounter + 1}`,
  };
}

let quiescent = false;
const leases = new Map<string, ReturnType<typeof vi.fn>>();

function harnessCleanup(h: Harness): Promise<void> {
  return (async () => {
    await h.manager.shutdown();
    await fs.rm(h.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  })();
}

async function beginWithLease(h: Harness, sessionId: string, key: string): Promise<string> {
  const begun = await h.manager.beginRun({ ...baseInput, sessionId, idempotencyKey: key });
  if (begun.kind !== 'created') throw new Error('expected a created run');
  const release = vi.fn();
  leases.set(begun.receipt.runId, release);
  h.manager.attachLease(begun.receipt.runId, { release });
  return begun.receipt.runId;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('L1 reconciliation guard for quarantined admission leases', () => {
  afterEach(() => {
    quiescent = false;
    leases.clear();
  });

  it('releases a quarantined entry once the whole session is confirmed quiescent later', async () => {
    const h = await makeHarness();
    try {
      quiescent = false; // the goal turn keeps the runtime busy through the drain window
      const runId = await beginWithLease(h, 'goal-session', 'k1');
      const release = leases.get(runId)!;
      await h.manager.cancelRun(runId);
      await sleep(150); // past the 50 ms drain timeout → quarantined (today's behaviour)
      expect(h.manager.getQuarantinedCount()).toBe(1);
      expect(release).not.toHaveBeenCalled();

      quiescent = true; // the goal turn ends; the session settles
      await sleep(150); // ≥1 reconcile tick at 20 ms
      expect(release).toHaveBeenCalledTimes(1); // the guard released the slot
      expect(h.manager.getQuarantinedCount()).toBe(0);
    } finally {
      await harnessCleanup(h);
    }
  });

  it('does NOT release a quarantined entry whose session is genuinely still running (no false capacity release)', async () => {
    const h = await makeHarness();
    try {
      quiescent = false;
      const runId = await beginWithLease(h, 'busy-session', 'k2');
      const release = leases.get(runId)!;
      await h.manager.cancelRun(runId);
      await sleep(150); // quarantined
      quiescent = false; // and it STAYS busy (another turn of that session still runs)
      await sleep(200); // many reconcile ticks
      expect(release).not.toHaveBeenCalled(); // fence kept: still-running work is never dropped
      expect(h.manager.getQuarantinedCount()).toBe(1);
    } finally {
      await harnessCleanup(h);
    }
  });

  it('holds a failed wake-run quarantined while the goal turn runs, releases only after the session settles', async () => {
    // Production shape: a wake follow_up run on a busy goal session fails
    // (never starts — the silent turn gives it no activity); its lease drains
    // against the still-busy session and quarantines. The guard must release
    // it once the goal turn's session is quiescent — and not before.
    const h = await makeHarness();
    try {
      quiescent = false;
      const runId = await beginWithLease(h, 'goal-session-2', 'k3');
      const release = leases.get(runId)!;
      await h.manager.finish(runId, { status: 'failed', errorCode: 'NEVER_STARTED', stallReason: 'no_activity' });
      await sleep(150); // quarantined: failed + unconfirmed cessation + busy session
      expect(h.manager.getQuarantinedCount()).toBe(1);
      expect(release).not.toHaveBeenCalled();

      await sleep(120); // reconcile ticks while STILL busy — nothing released
      expect(release).not.toHaveBeenCalled();

      quiescent = true;
      await sleep(150);
      expect(release).toHaveBeenCalledTimes(1);
      expect(h.manager.getQuarantinedCount()).toBe(0);
    } finally {
      await harnessCleanup(h);
    }
  });

  it('getQuarantinedOldestAgeMs reports the oldest quarantined entry age and undefined when none', async () => {
    const h = await makeHarness();
    try {
      quiescent = false;
      expect(h.manager.getQuarantinedOldestAgeMs()).toBeUndefined();
      const t0 = h.getNow();
      const runId = await beginWithLease(h, 'age-session', 'k4');
      await h.manager.cancelRun(runId);
      await sleep(150); // quarantined at ~t0
      h.setNow(t0 + 5_000);
      expect(h.manager.getQuarantinedOldestAgeMs()).toBeGreaterThanOrEqual(4_500);
      expect(h.manager.getQuarantinedOldestAgeMs()).toBeLessThan(6_000);
    } finally {
      await harnessCleanup(h);
    }
  });
});

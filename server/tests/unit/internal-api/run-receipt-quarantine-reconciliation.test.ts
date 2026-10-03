import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { DeletedSessionCessation } from '../../../src/internal-api/run-receipts/deletion-cessation.js';
import { isPiSessionQuiescent } from '../../../src/internal-api/runtime-quiescence.js';
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

  // Correction 01 (Luna r1 finding 1): the stale-streaming watchdog can reset
  // manager status to idle without stopping the SDK stream. The release
  // predicate must share the piLiveness busy truth, so idle+sdkStreaming stays
  // quarantined and releases only when streaming actually ends.
  it('stays quarantined through a stale-streaming reset while the SDK still streams; releases only when streaming ends', async () => {
    const h = await makeHarness();
    try {
      let statusInfo: { status?: string; sdkStreaming?: boolean } = { status: 'streaming', sdkStreaming: true };
      const wired = new RunReceiptManager({
        store: h.store, now: h.getNow, idFactory: () => `c01-${Math.random().toString(36).slice(2, 8)}`,
        idempotencyTtlMs: 1_000, metrics: h.metrics,
        drainPollMs: 5, drainTimeoutMs: 50, quarantineReconcileMs: 20,
        isRuntimeQuiescent: async () => isPiSessionQuiescent(statusInfo),
      });
      await wired.init();
      const begun = await wired.beginRun({ ...baseInput, sessionId: 'stale-stream', idempotencyKey: 'c01' });
      const release = vi.fn();
      wired.attachLease(begun.receipt.runId, { release });
      await wired.cancelRun(begun.receipt.runId);
      await sleep(150); // past the drain timeout → quarantined
      expect(wired.getQuarantinedCount()).toBe(1);

      statusInfo = { status: 'idle', sdkStreaming: true }; // the stale-streaming reset: status idle, SDK still streaming
      await sleep(200); // many reconcile ticks
      expect(release).not.toHaveBeenCalled(); // idle status + streaming SDK is NOT quiescent
      expect(wired.getQuarantinedCount()).toBe(1);

      statusInfo = { status: 'idle', sdkStreaming: false }; // streaming actually ends
      await sleep(150);
      expect(release).toHaveBeenCalledTimes(1);
      expect(wired.getQuarantinedCount()).toBe(0);
      await wired.shutdown();
    } finally {
      await harnessCleanup(h);
    }
  });

  // Correction 01 (Luna r1 finding 2): a deleted session is not proof of
  // cessation unless the runtime gave an awaited termination ack (Pi) — a
  // non-awaiting runtime (Claude) holds through the bounded deletion grace and
  // is then released with the grace-release log.
  it('a DELETE during a quarantined run: Pi releases on the awaited dispose ack; Claude holds through the grace then grace-releases', async () => {
    const h = await makeHarness();
    try {
      const logLines: string[] = [];
      const tracker = new DeletedSessionCessation({
        now: h.getNow,
        graceMs: 20,
        log: (line) => logLines.push(line),
      });
      const wiredFor = (sessionId: string): RunReceiptManager => new RunReceiptManager({
        store: h.store, now: h.getNow, idFactory: () => `c01d-${Math.random().toString(36).slice(2, 8)}`,
        idempotencyTtlMs: 1_000, metrics: h.metrics,
        drainPollMs: 5, drainTimeoutMs: 50, quarantineReconcileMs: 20,
        // The server.ts wiring shape: a missing registry entry consults the deletion tracker.
        isRuntimeQuiescent: async () => tracker.isQuiescent(sessionId),
      });

      // Pi: DELETE awaits disposeLoadedSession → termination acked → releases on the next tick.
      const piManager = wiredFor('pi-del');
      await piManager.init();
      const piRun = await piManager.beginRun({ ...baseInput, sessionId: 'pi-del', idempotencyKey: 'pi-del' });
      const piRelease = vi.fn();
      piManager.attachLease(piRun.receipt.runId, { release: piRelease });
      await piManager.cancelRun(piRun.receipt.runId);
      await sleep(120); // quarantined; the session still exists (predicate false)
      expect(piManager.getQuarantinedCount()).toBe(1);
      tracker.record('pi-del', 'pi', true); // handleDeleteSession: awaited dispose
      await sleep(120);
      expect(piRelease).toHaveBeenCalledTimes(1);
      await piManager.shutdown();

      // Claude: DELETE only aborts without awaiting termination → held through the grace, then grace-released.
      const claudeManager = wiredFor('claude-del');
      await claudeManager.init();
      const claudeRun = await claudeManager.beginRun({ ...baseInput, sessionId: 'claude-del', idempotencyKey: 'claude-del' });
      const claudeRelease = vi.fn();
      claudeManager.attachLease(claudeRun.receipt.runId, { release: claudeRelease });
      await claudeManager.cancelRun(claudeRun.receipt.runId);
      await sleep(120);
      expect(claudeManager.getQuarantinedCount()).toBe(1);
      tracker.record('claude-del', 'claude', false); // no awaited termination ack
      await sleep(120); // reconcile ticks inside the grace (fake now unmoved)
      expect(claudeRelease).not.toHaveBeenCalled();
      h.setNow(h.getNow() + 21); // advance the fake clock past the 20 ms grace
      await sleep(120);
      expect(claudeRelease).toHaveBeenCalledTimes(1);
      const graceLines = logLines.filter((l) => l.includes('grace-release'));
      expect(graceLines.length).toBe(1);
      expect(graceLines[0]).toMatch(/runtime=claude/);
      await claudeManager.shutdown();
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

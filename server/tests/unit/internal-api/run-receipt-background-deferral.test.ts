import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * Lane B (ANTIGRAVITY-POST-TURN-WORK-PLAN, 2026-11-22): a runtime that still
 * tracks a RUNNING background task is legitimately silent.
 *
 * agy 1.5.14 demotes a long `run_command` to a background task, answers
 * STARTED, and then holds the stream turn open in silence until that task
 * finishes (live-probed, T1/T2/T3). For the 33-minute T3 task no event arrived
 * for 15 minutes, so the run watchdog declared TURN_STALLED at the idle
 * window and killed the process — the legitimate command died with it.
 *
 * The manager may therefore ask its owner (the antigravity service) whether the
 * session has known pending work. That deferral is narrow by design:
 *   - it applies to the IDLE rule only (never the absolute ceiling);
 *   - it never terminalises early or synthesises events, so nothing on the wire
 *     changes and a caller that knows nothing keeps today's behaviour;
 *   - the hard ceilings (turnMaxMs, the agy hard turn timer, the background
 *     watch ceiling, user abort/delete) are untouched.
 */

const baseInput: BeginRunInput = {
  sessionId: 'session-bg',
  runtime: 'antigravity',
  executionInstanceId: 'antigravity-default',
  model: 'gemini-3.8-flash-medium',
  message: 'run the long command',
  mode: 'prompt',
  verbosity: 'answers',
  detach: false,
};

/** An ordinary observed unit of work: the STARTED answer T3 reported. */
function startedAnswer(sessionId: string, timestamp: number): NormalizedEvent {
  return {
    type: 'message_update',
    sessionId,
    timestamp,
    data: { assistantMessageEvent: { type: 'text_delta', delta: 'STARTED' } },
  } as NormalizedEvent;
}

describe('RunReceiptManager — known background work defers the idle rule', () => {
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
      // absolute ceiling.
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
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-bg-'));
    now = Date.parse('2026-11-22T01:08:15.000Z');
    nextId = 0;
    metrics = new OperationalMetrics({ now: () => now });
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('leaves the run active while the runtime tracks running background work, then terminalises TURN_STALLED once it stops', async () => {
    let pending = true;
    const asked: Array<[string, string]> = [];
    const onStalled = vi.fn();
    const m = makeManager({
      onStalled,
      hasKnownPendingWork: (sessionId, runtime) => {
        asked.push([sessionId, runtime]);
        return pending;
      },
    });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    // agy answered STARTED and then held the turn open in silence.
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer(baseInput.sessionId, now));

    // The full 15-minute idle window passes with no further event.
    now += 900_100;
    await reconcile(m);

    const deferred = m.get(run.receipt.runId);
    expect(deferred?.status).toBe('started');
    expect(deferred?.errorCode).toBeUndefined();
    expect(onStalled).not.toHaveBeenCalled();
    // The manager asks the owner for the session's runtime, not a guess.
    expect(asked.at(-1)).toEqual([baseInput.sessionId, 'antigravity']);

    // The background task ends (or leaves our tracking) and the session goes
    // quiet again: the idle rule applies exactly as before.
    pending = false;
    now += 900_100;
    await reconcile(m);

    const terminal = m.get(run.receipt.runId);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.errorCode).toBe('TURN_STALLED');
    expect(terminal?.liveness?.watchdog?.reason).toBe('idle');
    expect(onStalled).toHaveBeenCalledTimes(1);
  });

  it('still terminalises at the absolute ceiling while background work is pending (the ceiling is not weakened)', async () => {
    const m = makeManager({
      turnIdleTimeoutMs: 900_000,
      turnMaxMs: 5_000,
      hasKnownPendingWork: () => true,
    });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer(baseInput.sessionId, now));

    now += 6_000;
    await reconcile(m);

    const terminal = m.get(run.receipt.runId);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.errorCode).toBe('TURN_STALLED');
    expect(terminal?.liveness?.watchdog?.reason).toBe('absolute');
  });

  it('keeps today\'s behaviour exactly when no owner declares pending work (no dep)', async () => {
    const m = makeManager();
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer(baseInput.sessionId, now));

    now += 900_100;
    await reconcile(m);

    const terminal = m.get(run.receipt.runId);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.errorCode).toBe('TURN_STALLED');
    expect(terminal?.liveness?.watchdog?.reason).toBe('idle');
  });

  it('does not defer the never-started branch: a silent run with no observed work is still NEVER_STARTED', async () => {
    // Pending-work deferral is for a turn that IS executing and is quiet. A
    // dispatched run that produced nothing at all inside the start window is
    // still reported as never started, whatever the owner claims.
    const m = makeManager({ hasKnownPendingWork: () => true });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);

    now += 120_000;
    await reconcile(m);

    const terminal = m.get(run.receipt.runId);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.errorCode).toBe('NEVER_STARTED');
  });

  it('a throwing owner predicate never keeps a run alive and never breaks the watchdog sweep', async () => {
    const m = makeManager({
      hasKnownPendingWork: () => {
        throw new Error('service lookup failed');
      },
    });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer(baseInput.sessionId, now));

    now += 900_100;
    await expect(reconcile(m)).resolves.toBeUndefined();

    const terminal = m.get(run.receipt.runId);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.errorCode).toBe('TURN_STALLED');
  });

  it('a completed task is not pending work: the owner answers false and the idle rule terminalises', async () => {
    // The predicate is the owner's own tracking, so a session whose task has
    // already completed reports false — the manager trusts the answer and the
    // ordinary idle rule applies at once.
    const m = makeManager({ hasKnownPendingWork: () => false });
    await m.init();
    const run = await m.beginRun(baseInput);
    await m.markStarted(run.receipt.runId);
    now += 500;
    await m.observeEvent(run.receipt.runId, startedAnswer(baseInput.sessionId, now));

    now += 900_100;
    await reconcile(m);

    expect(m.get(run.receipt.runId)?.errorCode).toBe('TURN_STALLED');
  });
});

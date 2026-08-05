import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

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

describe('RunReceiptManager — idempotent dispatch and terminal lifecycle', () => {
  let dir: string;
  let now: number;
  let nextId: number;
  let manager: RunReceiptManager;
  let store: RunReceiptStore;
  let metrics: OperationalMetrics;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-manager-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    nextId = 0;
    metrics = new OperationalMetrics({ now: () => now });
    store = new RunReceiptStore(dir, { now: () => now });
    manager = new RunReceiptManager({
      store,
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      idempotencyTtlMs: 1_000,
      metrics,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  // Phase 3.2 — a watchdog-terminalised TURN_STALLED run fires onStalled so the
  // operator can be notified of a quarantined/unknown run (no required action;
  // the slot is held conservatively until terminalisation).
  it('invokes onStalled when the watchdog terminalises a stalled run', async () => {
    const stalled = vi.fn();
    const localStore = new RunReceiptStore(dir, { now: () => now });
    const m = new RunReceiptManager({
      store: localStore,
      now: () => now,
      idFactory: () => `stall-${++nextId}`,
      idempotencyTtlMs: 1_000,
      metrics,
      turnIdleTimeoutMs: 1000,
      turnMaxMs: 60_000,
      onStalled: stalled,
    });
    await m.init();
    await m.beginRun({ ...baseInput, idempotencyKey: 'stall-1' });
    now += 2000; // exceed the 1s idle timeout
    await (m as unknown as { reconcileStalledRuns: () => Promise<void> }).reconcileStalledRuns();
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0][0]).toMatchObject({ errorCode: 'TURN_STALLED' });
    await m.shutdown();
  });

  // Phase 3.2 §11 fence: admission capacity must NOT be reusable while runtime
  // cessation is unconfirmed. Cancel/stall defers the lease release until the
  // runtime confirms it has stopped (or a bounded drain timeout -> release).
  it('defers admission release on cancel until runtime cessation is confirmed', async () => {
    let quiescent = false;
    const release = vi.fn();
    const localStore = new RunReceiptStore(dir, { now: () => now });
    const m = new RunReceiptManager({
      store: localStore, now: () => now, idFactory: () => `fence-${++nextId}`, idempotencyTtlMs: 1_000, metrics,
      drainPollMs: 5, drainTimeoutMs: 200, isRuntimeQuiescent: async () => quiescent,
    });
    await m.init();
    const begun = await m.beginRun({ ...baseInput, sessionId: 'fence-1', idempotencyKey: 'f1' });
    m.attachLease(begun.receipt.runId, { release });
    await m.cancelRun(begun.receipt.runId);
    expect(release).not.toHaveBeenCalled(); // draining — slot held, capacity not reusable
    quiescent = true;
    await new Promise((r) => setTimeout(r, 30)); // drain poll fires
    expect(release).toHaveBeenCalled();
    await m.shutdown();
  });

  it('accepts explicit positive runtime quiescence evidence without waiting for the next drain poll', async () => {
    const release = vi.fn();
    const localStore = new RunReceiptStore(dir, { now: () => now });
    const m = new RunReceiptManager({
      store: localStore, now: () => now, idFactory: () => `confirm-${++nextId}`, idempotencyTtlMs: 1_000, metrics,
      drainPollMs: 1_000, drainTimeoutMs: 2_000, isRuntimeQuiescent: async () => false,
    });
    await m.init();
    const begun = await m.beginRun({ ...baseInput, sessionId: 'confirm-1', idempotencyKey: 'confirm-1' });
    m.attachLease(begun.receipt.runId, { release });
    await m.cancelRun(begun.receipt.runId);
    expect(release).not.toHaveBeenCalled();
    await expect(m.confirmRuntimeQuiescent(begun.receipt.runId)).resolves.toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(m.get(begun.receipt.runId)?.liveness?.cessation).toMatchObject({
      state: 'confirmed', basis: 'resource_quiescence',
    });
    await expect(m.confirmRuntimeQuiescent(begun.receipt.runId)).resolves.toBe(false);
    await m.shutdown();
  });

  it('quarantines (holds the slot as debt) at the drain timeout if cessation is never confirmed — no false capacity release', async () => {
    const release = vi.fn();
    const localStore = new RunReceiptStore(dir, { now: () => now });
    const m = new RunReceiptManager({
      store: localStore, now: () => now, idFactory: () => `to-${++nextId}`, idempotencyTtlMs: 1_000, metrics,
      drainPollMs: 5, drainTimeoutMs: 50, isRuntimeQuiescent: async () => false,
    });
    await m.init();
    const begun = await m.beginRun({ ...baseInput, sessionId: 'to-1', idempotencyKey: 't1' });
    m.attachLease(begun.receipt.runId, { release });
    await m.cancelRun(begun.receipt.runId);
    expect(release).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 150)); // past the 50ms drain timeout
    expect(release).not.toHaveBeenCalled(); // NOT released — held as quarantined capacity-debt
    expect(m.getQuarantinedCount()).toBe(1);
    await m.shutdown(); // shutdown releases all (incl. quarantined) for cleanup
  });

  it('a late agent_end for a cancelled run does not release capacity twice', async () => {
    const release = vi.fn();
    const localStore = new RunReceiptStore(dir, { now: () => now });
    const m = new RunReceiptManager({
      store: localStore, now: () => now, idFactory: () => `late-${++nextId}`, idempotencyTtlMs: 1_000, metrics,
      drainPollMs: 5, drainTimeoutMs: 200, isRuntimeQuiescent: async () => true,
    });
    await m.init();
    const begun = await m.beginRun({ ...baseInput, sessionId: 'late-1', idempotencyKey: 'a1' });
    m.attachLease(begun.receipt.runId, { release });
    await m.cancelRun(begun.receipt.runId); // terminal -> drain; quiescent -> release
    await new Promise((r) => setTimeout(r, 20)); // drain poll fires + releases once
    const releasedCount = release.mock.calls.length;
    expect(releasedCount).toBe(1);
    // late agent_end for the already-terminal run: evidence-only, must not release again
    await m.observeEvent(begun.receipt.runId, { type: 'agent_end', sessionId: 'late-1', timestamp: now, data: {} });
    expect(release.mock.calls.length).toBe(releasedCount); // no double release
    await m.shutdown();
  });

  it('releases the lease immediately on normal completion (cessation confirmed by agent_end)', async () => {
    const release = vi.fn();
    const localStore = new RunReceiptStore(dir, { now: () => now });
    const m = new RunReceiptManager({
      store: localStore, now: () => now, idFactory: () => `ok-${++nextId}`, idempotencyTtlMs: 1_000, metrics,
      drainPollMs: 5, drainTimeoutMs: 200, isRuntimeQuiescent: async () => false,
    });
    await m.init();
    const begun = await m.beginRun({ ...baseInput, sessionId: 'ok-1', idempotencyKey: 'ok1' });
    m.attachLease(begun.receipt.runId, { release });
    await m.finish(begun.receipt.runId, { status: 'completed' });
    expect(release).toHaveBeenCalled(); // immediate — no drain for normal completion
    await m.shutdown();
  });

  it('creates one run for a key and returns the same receipt on a duplicate request', async () => {
    const first = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });
    const second = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });

    expect(first.kind).toBe('created');
    expect(second.kind).toBe('duplicate');
    expect(second.receipt.runId).toBe(first.receipt.runId);
    expect(first.receipt).not.toHaveProperty('idempotencyKeyDigest');
    expect(first.receipt).not.toHaveProperty('requestFingerprint');
    const files = await fs.readdir(dir);
    const stored = await fs.readFile(path.join(dir, files.find((file) => file.endsWith('.json'))!), 'utf8');
    expect(stored).not.toContain('request-1');
  });

  it('23. round-trips requested mode and actual dispatchMode through durable storage', async () => {
    const created = await manager.beginRun({ ...baseInput, mode: 'follow_up', dispatchMode: 'prompt' });
    expect(created.receipt).toMatchObject({ mode: 'follow_up', dispatchMode: 'prompt' });
    await manager.shutdown();
    manager = new RunReceiptManager({ store: new RunReceiptStore(dir, { now: () => now }), now: () => now });
    await manager.init();
    expect(manager.get(created.receipt.runId)).toMatchObject({ mode: 'follow_up', dispatchMode: 'prompt' });
  });

  it('rejects a same-key request with a different execution fingerprint', async () => {
    await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });
    const collision = await manager.beginRun({ ...baseInput, message: 'a different task', idempotencyKey: 'request-1' });

    expect(collision.kind).toBe('conflict');
    expect(collision.receipt.runId).toBe('run-1');
  });

  it('serializes concurrent retries so only one reservation is created', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => manager.beginRun({ ...baseInput, idempotencyKey: 'concurrent-key' })),
    );

    expect(new Set(results.map((result) => result.receipt.runId))).toEqual(new Set(['run-1']));
    expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(7);
  });

  it('scopes keys to a session and allows distinct keys to dispatch independently', async () => {
    const first = await manager.beginRun({ ...baseInput, idempotencyKey: 'same-key' });
    const otherSession = await manager.beginRun({ ...baseInput, sessionId: 'session-2', idempotencyKey: 'same-key' });
    const otherKey = await manager.beginRun({ ...baseInput, idempotencyKey: 'other-key' });

    expect(otherSession.kind).toBe('created');
    expect(otherSession.receipt.runId).not.toBe(first.receipt.runId);
    expect(otherKey.kind).toBe('created');
    expect(otherKey.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('keeps a key live before the TTL boundary and expires it exactly at the boundary', async () => {
    const first = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });
    now += 999;
    const beforeBoundary = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });
    now += 1;
    const atBoundary = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });

    expect(beforeBoundary).toMatchObject({ kind: 'duplicate', receipt: { runId: first.receipt.runId } });
    expect(atBoundary.kind).toBe('created');
    expect(atBoundary.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('releases a key when a reservation is rejected before runtime dispatch', async () => {
    const first = await manager.beginRun({ ...baseInput, idempotencyKey: 'retryable-preflight' });
    await manager.rejectBeforeDispatch(first.receipt.runId, {
      status: 'cancelled',
      errorCode: 'SESSION_BUSY',
    });
    const retry = await manager.beginRun({ ...baseInput, idempotencyKey: 'retryable-preflight' });

    expect(manager.get(first.receipt.runId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'SESSION_BUSY',
    });
    expect(manager.get(first.receipt.runId)).not.toHaveProperty('idempotencyExpiresAt');
    expect(retry.kind).toBe('created');
    expect(retry.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('releases a pre-dispatch key even if concurrent cancellation reached terminal state first', async () => {
    const first = await manager.beginRun({ ...baseInput, idempotencyKey: 'cancel-race' });
    await manager.cancelSession(baseInput.sessionId);
    await manager.rejectBeforeDispatch(first.receipt.runId, {
      status: 'cancelled',
      errorCode: 'SESSION_BUSY',
    });
    const retry = await manager.beginRun({ ...baseInput, idempotencyKey: 'cancel-race' });

    expect(retry.kind).toBe('created');
    expect(retry.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('does not deduplicate requests that omit an idempotency key', async () => {
    const first = await manager.beginRun(baseInput);
    const second = await manager.beginRun(baseInput);

    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    expect(second.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('records agent_end, completion, and low-cardinality turn latency', async () => {
    const started = await manager.beginRun(baseInput);
    await manager.markStarted(started.receipt.runId);
    now += 1_250;
    manager.observeEvent(started.receipt.runId, {
      type: 'agent_end',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: {},
    });
    await manager.finish(started.receipt.runId);

    expect(manager.get(started.receipt.runId)).toMatchObject({
      status: 'completed',
      agentEndAt: new Date(now).toISOString(),
      terminalAt: new Date(now).toISOString(),
    });
    expect(metrics.snapshot().turns.pi).toMatchObject({
      accepted: 1,
      completed: 1,
      latency: { count: 1, totalMs: 1_250, maxMs: 1_250 },
    });
  });

  it('records a late agent_end signal without reopening terminality or claiming quiescence', async () => {
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);
    await manager.finish(run.receipt.runId);

    now += 5;
    await manager.observeEvent(run.receipt.runId, {
      type: 'agent_end',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: {},
    });

    expect(manager.get(run.receipt.runId)).toMatchObject({
      status: 'completed',
      agentEndAt: new Date(now).toISOString(),
      liveness: {
        terminalObservations: [{
          type: 'agent_end',
          occurredAt: new Date(now).toISOString(),
          observedAt: new Date(now).toISOString(),
          origin: 'runtime_or_adapter',
          late: true,
        }],
        cessation: {
          state: 'unconfirmed',
          basis: 'terminal_signal',
          observedAt: new Date(now).toISOString(),
        },
      },
    });
  });

  it('coalesces ordinary durable activity snapshots to at most one write per second', async () => {
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);
    const patch = vi.spyOn(store, 'patch');

    const observations = Array.from({ length: 10 }, (_, index) => manager.observeEvent(run.receipt.runId, {
      type: 'message_update',
      sessionId: baseInput.sessionId,
      timestamp: now + index,
      data: {},
    }));
    await Promise.all(observations);

    expect(patch).toHaveBeenCalledTimes(1);
    expect(manager.get(run.receipt.runId)?.liveness?.lastEligibleActivity?.eventType).toBe('message_update');
  });

  it('persists only allowlisted low-cardinality terminal reasons', async () => {
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);
    await manager.observeEvent(run.receipt.runId, {
      type: 'agent_end',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: { synthetic: true, reason: 'token_sk:livesecret' },
    });

    expect(manager.get(run.receipt.runId)?.liveness?.terminalObservations?.[0]).toMatchObject({
      origin: 'synthetic',
    });
    expect(manager.get(run.receipt.runId)?.liveness?.terminalObservations?.[0]).not.toHaveProperty('reason');
  });

  it('ignores synthetic stream_activity heartbeats and records an idle watchdog decision', async () => {
    await manager.shutdown();
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      metrics,
      turnIdleTimeoutMs: 1_000,
      turnMaxMs: 10_000,
    });
    await manager.init();
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);

    now += 900;
    await manager.observeEvent(run.receipt.runId, {
      type: 'stream_activity',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: { elapsedMs: 900 },
    });
    now += 100;
    await (manager as any).reconcileStalledRuns();

    expect(manager.get(run.receipt.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'TURN_STALLED',
      liveness: {
        watchdog: {
          reason: 'idle',
          decidedAt: new Date(now).toISOString(),
          idleTimeoutMs: 1_000,
          absoluteTimeoutMs: 10_000,
        },
        cessation: {
          state: 'unknown',
          basis: 'watchdog',
          observedAt: new Date(now).toISOString(),
        },
      },
    });
    expect(manager.get(run.receipt.runId)?.liveness?.lastEligibleActivity?.eventType).not.toBe('stream_activity');
  });

  it('counts Pi extension UI requests as attributable run activity', async () => {
    await manager.shutdown();
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      metrics,
      turnIdleTimeoutMs: 1_000,
      turnMaxMs: 10_000,
    });
    await manager.init();
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);

    now += 900;
    await manager.observeEvent(run.receipt.runId, {
      type: 'extension_ui_request',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: { id: 'ui-1', method: 'confirm' },
    } as NormalizedEvent);
    now += 200;
    await (manager as any).reconcileStalledRuns();

    expect(manager.get(run.receipt.runId)).toMatchObject({
      status: 'started',
      liveness: { lastEligibleActivity: { eventType: 'extension_ui_request' } },
    });
  });

  it('preserves watchdog cessation provenance when terminal evidence arrives late', async () => {
    await manager.shutdown();
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      metrics,
      turnIdleTimeoutMs: 1_000,
      turnMaxMs: 10_000,
    });
    await manager.init();
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);
    now += 1_000;
    await (manager as any).reconcileStalledRuns();

    now += 5;
    await manager.observeEvent(run.receipt.runId, {
      type: 'agent_end', sessionId: baseInput.sessionId, timestamp: now, data: {},
    });

    expect(manager.get(run.receipt.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'TURN_STALLED',
      liveness: {
        watchdog: { reason: 'idle' },
        terminalObservations: [{ late: true, origin: 'runtime_or_adapter' }],
        cessation: { state: 'unknown', basis: 'watchdog' },
      },
    });
  });

  it('records an absolute watchdog decision even when recent attributable activity exists', async () => {
    await manager.shutdown();
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      metrics,
      turnIdleTimeoutMs: 2_000,
      turnMaxMs: 1_000,
    });
    await manager.init();
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);

    now += 900;
    await manager.observeEvent(run.receipt.runId, {
      type: 'tool_execution_end',
      sessionId: baseInput.sessionId,
      timestamp: now,
      data: { result: 'must not be persisted' },
    });
    now += 100;
    await (manager as any).reconcileStalledRuns();

    expect(manager.get(run.receipt.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'TURN_STALLED',
      liveness: {
        lastEligibleActivity: {
          eventType: 'tool_execution_end',
          occurredAt: new Date(now - 100).toISOString(),
          observedAt: new Date(now - 100).toISOString(),
        },
        watchdog: {
          reason: 'absolute',
          decidedAt: new Date(now).toISOString(),
        },
      },
    });
    expect(JSON.stringify(manager.get(run.receipt.runId))).not.toContain('must not be persisted');
  });

  it('serializes competing terminal callbacks without throwing', async () => {
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);

    await expect(Promise.all([
      manager.finish(run.receipt.runId),
      manager.cancelRun(run.receipt.runId),
    ])).resolves.toHaveLength(2);
    expect(['completed', 'cancelled']).toContain(manager.get(run.receipt.runId)?.status);
  });

  it('finishes failures with an error code and supports explicit cancellation', async () => {
    const failed = await manager.beginRun(baseInput);
    await manager.markStarted(failed.receipt.runId);
    await manager.finish(failed.receipt.runId, { status: 'failed', errorCode: 'RUNTIME_ERROR' });

    const cancelled = await manager.beginRun({ ...baseInput, sessionId: 'session-2' });
    await manager.markStarted(cancelled.receipt.runId);
    await manager.cancelSession('session-2');

    expect(manager.get(failed.receipt.runId)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_ERROR' });
    expect(manager.get(cancelled.receipt.runId)).toMatchObject({ status: 'cancelled' });
  });

  it('reloads an in-flight run as interrupted instead of silently losing it', async () => {
    const accepted = await manager.beginRun(baseInput);
    const restarted = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now + 10 }),
      now: () => now + 10,
      idempotencyTtlMs: 1_000,
    });
    await restarted.init();

    expect(restarted.get(accepted.receipt.runId)).toMatchObject({
      status: 'interrupted',
      interruptionReason: 'server_restart',
      errorCode: 'SERVER_RESTART',
    });
  });
});

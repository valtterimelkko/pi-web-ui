import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

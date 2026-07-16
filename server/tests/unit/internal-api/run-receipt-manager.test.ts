import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

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

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-manager-'));
    now = Date.parse('2026-07-15T12:00:00.000Z');
    nextId = 0;
    manager = new RunReceiptManager({
      store: new RunReceiptStore(dir, { now: () => now }),
      now: () => now,
      idFactory: () => `run-${++nextId}`,
      idempotencyTtlMs: 1_000,
    });
    await manager.init();
  });

  afterEach(async () => {
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

  it('allows the same key to be reused after the idempotency TTL expires', async () => {
    const first = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });
    now += 1_001;
    const second = await manager.beginRun({ ...baseInput, idempotencyKey: 'request-1' });

    expect(second.kind).toBe('created');
    expect(second.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('does not deduplicate requests that omit an idempotency key', async () => {
    const first = await manager.beginRun(baseInput);
    const second = await manager.beginRun(baseInput);

    expect(first.kind).toBe('created');
    expect(second.kind).toBe('created');
    expect(second.receipt.runId).not.toBe(first.receipt.runId);
  });

  it('records agent_end and completes successfully when the existing completion callback succeeds', async () => {
    const started = await manager.beginRun(baseInput);
    await manager.markStarted(started.receipt.runId);
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
  });

  it('records a late agent_end signal even when the terminal callback won the race', async () => {
    const run = await manager.beginRun(baseInput);
    await manager.markStarted(run.receipt.runId);
    await manager.finish(run.receipt.runId);

    await manager.observeEvent(run.receipt.runId, {
      type: 'agent_end',
      sessionId: baseInput.sessionId,
      timestamp: now + 5,
      data: {},
    });

    expect(manager.get(run.receipt.runId)).toMatchObject({
      status: 'completed',
      agentEndAt: new Date(now + 5).toISOString(),
    });
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

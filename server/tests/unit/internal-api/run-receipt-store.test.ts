import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  RunReceiptStore,
  type PersistedRunReceipt,
} from '../../../src/internal-api/run-receipts/run-receipt-store.js';

function receipt(overrides: Partial<PersistedRunReceipt> = {}): PersistedRunReceipt {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    runtime: 'pi',
    executionInstanceId: 'pi-local-default',
    model: 'provider/model',
    status: 'accepted',
    acceptedAt: '2026-07-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('RunReceiptStore — durable run ledger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-receipts-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('creates and transitions a receipt through the legal lifecycle', async () => {
    const store = new RunReceiptStore(dir);
    await store.init();
    await store.create(receipt());

    await store.transition('run-1', 'started', { startedAt: '2026-07-15T12:00:01.000Z' });
    await store.transition('run-1', 'completed', { terminalAt: '2026-07-15T12:00:02.000Z' });

    expect(store.get('run-1')).toMatchObject({
      status: 'completed',
      startedAt: '2026-07-15T12:00:01.000Z',
      terminalAt: '2026-07-15T12:00:02.000Z',
    });
  });

  it('rejects illegal transitions and keeps terminal receipts immutable', async () => {
    const store = new RunReceiptStore(dir);
    await store.init();
    await store.create(receipt({ status: 'completed', terminalAt: '2026-07-15T12:00:02.000Z' }));

    await expect(store.transition('run-1', 'started')).rejects.toThrow(/invalid transition/i);
    expect(store.get('run-1')?.status).toBe('completed');
  });

  it('persists receipts and reloads them in a fresh store instance', async () => {
    const first = new RunReceiptStore(dir);
    await first.init();
    await first.create(receipt({ status: 'completed', terminalAt: '2026-07-15T12:00:02.000Z' }));

    const restarted = new RunReceiptStore(dir);
    await restarted.init();

    expect(restarted.get('run-1')).toMatchObject({ runId: 'run-1', status: 'completed' });
  });

  it('marks accepted and started receipts interrupted during restart recovery', async () => {
    const first = new RunReceiptStore(dir);
    await first.init();
    await first.create(receipt({ runId: 'accepted' }));
    await first.create(receipt({ runId: 'started', status: 'started', startedAt: '2026-07-15T12:00:01.000Z' }));

    const restarted = new RunReceiptStore(dir, {
      now: () => Date.parse('2026-07-15T12:01:00.000Z'),
    });
    await restarted.init();

    expect(restarted.get('accepted')).toMatchObject({
      status: 'interrupted',
      interruptionReason: 'server_restart',
      errorCode: 'SERVER_RESTART',
      terminalAt: '2026-07-15T12:01:00.000Z',
    });
    expect(restarted.get('started')).toMatchObject({
      status: 'interrupted',
      interruptionReason: 'server_restart',
    });
  });

  it('does not prune newly recovered in-flight receipts before exposing restart evidence', async () => {
    const first = new RunReceiptStore(dir);
    await first.init();
    await first.create(receipt({ runId: 'accepted-1' }));
    await first.create(receipt({ runId: 'accepted-2' }));

    const restarted = new RunReceiptStore(dir, {
      maxCount: 1,
      now: () => Date.parse('2026-07-15T12:01:00.000Z'),
    });
    await restarted.init();

    expect(restarted.get('accepted-1')?.status).toBe('interrupted');
    expect(restarted.get('accepted-2')?.status).toBe('interrupted');
  });

  it('prunes terminal receipts by age and count while retaining recent records', async () => {
    const store = new RunReceiptStore(dir, {
      now: () => Date.parse('2026-07-15T12:00:00.000Z'),
      maxAgeMs: 60_000,
      maxCount: 2,
    });
    await store.init();
    await store.create(receipt({ runId: 'old', status: 'completed', terminalAt: '2026-07-15T11:58:00.000Z' }));
    await store.create(receipt({ runId: 'new-1', status: 'completed', terminalAt: '2026-07-15T11:59:30.000Z' }));
    await store.create(receipt({ runId: 'new-2', status: 'completed', terminalAt: '2026-07-15T11:59:45.000Z' }));
    await store.prune();

    expect(store.get('old')).toBeUndefined();
    expect(store.list().map((item) => item.runId)).toEqual(expect.arrayContaining(['new-1', 'new-2']));
    expect(store.list()).toHaveLength(2);
  });

  it('rejects unsafe receipt fields so prompts and credentials cannot be persisted', async () => {
    const store = new RunReceiptStore(dir);
    await store.init();

    await expect(store.create({ ...receipt(), prompt: 'do not persist' } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create({ ...receipt(), apiKey: 'secret' } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create({ ...receipt(), token: 'secret' } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create({ ...receipt(), transcript: [] } as never)).rejects.toThrow(/unsupported|unsafe/i);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import type { BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';

describe('Command Code Internal API receipt metrics', () => {
  let directory: string;
  let manager: RunReceiptManager;
  let metrics: OperationalMetrics;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'commandcode-receipt-metrics-'));
    metrics = new OperationalMetrics();
    manager = new RunReceiptManager({
      store: new RunReceiptStore(directory),
      idFactory: () => 'commandcode-run-1',
      metrics,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });

  it('counts one accepted and completed outcome across an idempotent replay', async () => {
    const input: BeginRunInput = {
      sessionId: 'commandcode-session',
      runtime: 'commandcode',
      executionInstanceId: 'commandcode-default',
      model: 'qwen/qwen3.8-max',
      modelSelector: 'qwen/qwen3.8-max',
      message: 'fixture run',
      mode: 'prompt',
      verbosity: 'answers',
      detach: false,
      idempotencyKey: 'commandcode-replay-1',
    };

    const first = await manager.beginRun(input);
    expect(first.kind).toBe('created');
    const replay = await manager.beginRun(input);
    expect(replay).toMatchObject({ kind: 'duplicate', receipt: { runId: 'commandcode-run-1' } });

    await manager.finish(first.receipt.runId, { status: 'completed' });
    await manager.finish(first.receipt.runId, { status: 'completed' });

    expect(metrics.snapshot().turns.commandcode).toMatchObject({ accepted: 1, completed: 1 });
  });
});

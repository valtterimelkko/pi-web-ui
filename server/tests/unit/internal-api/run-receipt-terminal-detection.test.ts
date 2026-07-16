import { describe, it, expect } from 'vitest';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const runtimeFixtures = [
  { runtime: 'pi' as const, executionInstanceId: 'pi-local-default', events: ['agent_start', 'tool_execution_start', 'tool_execution_end', 'agent_end'] },
  { runtime: 'claude' as const, executionInstanceId: 'claude-default', events: ['agent_start', 'message_start', 'message_update', 'message_end', 'agent_end'] },
  { runtime: 'opencode' as const, executionInstanceId: 'opencode-default', events: ['agent_start', 'agent_end'] },
  { runtime: 'antigravity' as const, executionInstanceId: 'antigravity-default', events: ['agent_start', 'agent_end'] },
];

describe('run receipt terminal detection fixtures', () => {
  it.each(runtimeFixtures)('records $runtime agent_end before successful completion', async (fixture) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-terminal-'));
    try {
      let timestamp = Date.parse('2026-07-15T12:00:00.000Z');
      const manager = new RunReceiptManager({
        store: new RunReceiptStore(dir, { now: () => timestamp }),
        now: () => timestamp,
        idFactory: () => `run-${fixture.runtime}`,
      });
      await manager.init();
      const started = await manager.beginRun({
        sessionId: `${fixture.runtime}-session`,
        runtime: fixture.runtime,
        executionInstanceId: fixture.executionInstanceId,
        message: 'fixture prompt',
        mode: 'prompt',
        verbosity: 'answers',
        detach: false,
      });
      await manager.markStarted(started.receipt.runId);

      for (const type of fixture.events) {
        timestamp += 1;
        manager.observeEvent(started.receipt.runId, {
          type,
          sessionId: `${fixture.runtime}-session`,
          timestamp,
          data: {},
        });
      }
      await manager.finish(started.receipt.runId);

      expect(manager.get(started.receipt.runId)).toMatchObject({
        runtime: fixture.runtime,
        executionInstanceId: fixture.executionInstanceId,
        status: 'completed',
        agentEndAt: new Date(timestamp).toISOString(),
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });

  it('does not turn an error turn into a successful receipt just because agent_end follows it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-terminal-error-'));
    try {
      const manager = new RunReceiptManager({ store: new RunReceiptStore(dir) });
      await manager.init();
      const started = await manager.beginRun({
        sessionId: 'antigravity-error',
        runtime: 'antigravity',
        executionInstanceId: 'antigravity-default',
        message: 'fixture prompt',
        mode: 'prompt',
        verbosity: 'answers',
        detach: false,
      });
      await manager.markStarted(started.receipt.runId);
      manager.observeEvent(started.receipt.runId, {
        type: 'error', sessionId: 'antigravity-error', timestamp: Date.now(), data: {},
      });
      manager.observeEvent(started.receipt.runId, {
        type: 'agent_end', sessionId: 'antigravity-error', timestamp: Date.now(), data: {},
      });
      await manager.finish(started.receipt.runId, { status: 'failed', errorCode: 'RUNTIME_ERROR' });

      expect(manager.get(started.receipt.runId)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_ERROR' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    }
  });
});

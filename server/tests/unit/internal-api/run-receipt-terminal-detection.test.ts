import { describe, it, expect } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const runtimeFixtures: Array<{
  source: string;
  runtime: 'pi' | 'claude' | 'opencode' | 'antigravity';
  executionInstanceId: string;
  events: Array<Pick<NormalizedEvent, 'type' | 'data'>>;
}> = [
  {
    source: 'Pi SDK',
    runtime: 'pi',
    executionInstanceId: 'pi-local-default',
    events: [
      { type: 'agent_start', data: {} },
      { type: 'tool_execution_start', data: { toolCallId: 'tool-1', toolName: 'bash' } },
      { type: 'tool_execution_end', data: { toolCallId: 'tool-1', toolName: 'bash', result: 'ok' } },
      { type: 'agent_end', data: { result: null, usage: {} } },
    ],
  },
  {
    source: 'Claude SDK',
    runtime: 'claude',
    executionInstanceId: 'claude-sdk-profile',
    events: [
      { type: 'agent_start', data: {} },
      { type: 'message_start', data: { messageId: 'sdk-message', role: 'assistant' } },
      { type: 'message_update', data: { messageId: 'sdk-message', delta: 'done' } },
      { type: 'message_end', data: { messageId: 'sdk-message' } },
      { type: 'agent_end', data: {} },
    ],
  },
  {
    source: 'Claude channel',
    runtime: 'claude',
    executionInstanceId: 'claude-channel-profile',
    events: [
      { type: 'agent_start', data: {} },
      { type: 'message_start', data: { messageId: 'channel-message', role: 'assistant' } },
      { type: 'message_update', data: { messageId: 'channel-message', delta: 'done' } },
      { type: 'message_end', data: { messageId: 'channel-message' } },
      { type: 'agent_end', data: { result: null, usage: {} } },
    ],
  },
  {
    source: 'OpenCode SSE',
    runtime: 'opencode',
    executionInstanceId: 'opencode-default',
    events: [
      { type: 'agent_start', data: {} },
      { type: 'session_status', data: { status: 'idle' } },
      { type: 'agent_end', data: { result: null, usage: {} } },
    ],
  },
  {
    source: 'Antigravity subprocess',
    runtime: 'antigravity',
    executionInstanceId: 'antigravity-default',
    events: [
      { type: 'agent_start', data: {} },
      { type: 'message_end', data: { role: 'assistant', text: 'done' } },
      { type: 'agent_end', data: { result: null, usage: {} } },
    ],
  },
];

describe('run receipt terminal detection fixtures', () => {
  it.each(runtimeFixtures)('records $source agent_end before successful completion', async (fixture) => {
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

      for (const event of fixture.events) {
        timestamp += 1;
        manager.observeEvent(started.receipt.runId, {
          ...event,
          sessionId: `${fixture.runtime}-session`,
          timestamp,
        } as NormalizedEvent);
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

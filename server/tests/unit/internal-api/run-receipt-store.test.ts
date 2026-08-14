import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  RunReceiptStore,
  type PersistedRunReceipt,
} from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import { classifyPhase7PiShadow } from '../../../src/internal-api/phase7-pi-shadow.js';

/**
 * Fixture era. Receipts carry hardcoded 2026-07-15 timestamps, so stores that
 * create terminal receipts must pin `now` to the same era: with real time, the
 * 30-day prune deletes the fixtures as soon as the wall clock passes 2026-08-14.
 */
const FIXTURE_NOW = Date.parse('2026-07-15T12:00:00.000Z');

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
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
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
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await store.init();
    await store.create(receipt({ status: 'completed', terminalAt: '2026-07-15T12:00:02.000Z' }));

    await expect(store.transition('run-1', 'started')).rejects.toThrow(/invalid transition/i);
    expect(store.get('run-1')?.status).toBe('completed');
  });

  it('persists receipts and reloads them in a fresh store instance', async () => {
    const first = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await first.init();
    await first.create(receipt({ status: 'completed', terminalAt: '2026-07-15T12:00:02.000Z' }));

    const restarted = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await restarted.init();

    expect(restarted.get('run-1')).toMatchObject({ runId: 'run-1', status: 'completed' });
  });

  it('marks accepted and started receipts interrupted during restart recovery', async () => {
    const first = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await first.init();
    await first.create(receipt({ runId: 'accepted' }));
    await first.create(receipt({
      runId: 'started',
      status: 'started',
      startedAt: '2026-07-15T12:00:01.000Z',
      liveness: {
        activityPolicyVersion: 'run-activity-v1',
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 10_000,
        lastEligibleActivity: {
          eventType: 'extension_ui_request',
          occurredAt: '2026-07-15T12:00:30.000Z',
          observedAt: '2026-07-15T12:00:30.000Z',
        },
        cessation: { state: 'unknown', basis: 'no_terminal_signal', observedAt: '2026-07-15T12:00:00.000Z' },
      },
    }));

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
      liveness: {
        lastEligibleActivity: { eventType: 'extension_ui_request' },
        cessation: { state: 'unknown', basis: 'server_restart' },
      },
    });
  });

  it('does not prune newly recovered in-flight receipts before exposing restart evidence', async () => {
    const first = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
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

  it('round-trips bounded liveness evidence while keeping legacy receipts readable', async () => {
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await store.init();
    await store.create(receipt({
      status: 'failed',
      terminalAt: '2026-07-15T12:00:02.000Z',
      errorCode: 'TURN_STALLED',
      liveness: {
        activityPolicyVersion: 'run-activity-v1',
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 10_000,
        lastEligibleActivity: {
          eventType: 'tool_execution_end',
          occurredAt: '2026-07-15T12:00:01.000Z',
          observedAt: '2026-07-15T12:00:01.100Z',
        },
        watchdog: {
          reason: 'idle',
          decidedAt: '2026-07-15T12:00:02.000Z',
          idleTimeoutMs: 1_000,
          absoluteTimeoutMs: 10_000,
        },
        cessation: {
          state: 'unknown',
          basis: 'watchdog',
          observedAt: '2026-07-15T12:00:02.000Z',
        },
      },
    }));

    const restarted = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await restarted.init();
    expect(restarted.get('run-1')?.liveness).toMatchObject({
      activityPolicyVersion: 'run-activity-v1',
      watchdog: { reason: 'idle' },
      cessation: { state: 'unknown', basis: 'watchdog' },
    });

    await restarted.create(receipt({ runId: 'legacy-run' }));
    expect(restarted.get('legacy-run')).not.toHaveProperty('liveness');
  });

  it('rejects native effort metadata that contradicts the Command Code route', async () => {
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await store.init();
    const commandCodeBase = {
      runtime: 'commandcode' as const,
      executionInstanceId: 'commandcode-default',
    };
    // An effort value outside the native enum is rejected for any model.
    await expect(store.create(receipt({
      ...commandCodeBase,
      model: 'qwen/qwen3.8-max',
      effort: 'ultra',
    } as never))).rejects.toThrow(/effort/i);
    // Any advertised model id is a legal receipt route; only the binding must be consistent.
    await expect(store.create(receipt({
      ...commandCodeBase,
      runId: 'bad-commandcode-instance',
      executionInstanceId: 'other-commandcode-instance',
      model: 'qwen/qwen3.8-max',
    } as never))).rejects.toThrow(/execution|instance/i);
    // Any advertised model id is a legal receipt route; only the binding must be consistent.
    await expect(store.create(receipt({
      ...commandCodeBase,
      runId: 'eligible-model-ok',
      model: 'deepseek/deepseek-v4-pro',
    } as never))).resolves.toBeUndefined();
    // Automatic-sourcing is no longer a receipt concept; the effort field stands alone.
  });

  it('round-trips run-scoped token usage across restart and rejects malformed totals', async () => {
    const first = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await first.init();
    await first.create(receipt({
      runId: 'usage-run',
      runtime: 'commandcode',
      executionInstanceId: 'commandcode-default',
      model: 'meta/muse-spark-1.2-contributor',
      status: 'completed',
      terminalAt: '2026-07-15T12:00:02.000Z',
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 11, output: 7, total: 18 },
    } as never));

    const restarted = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await restarted.init();
    expect(restarted.get('usage-run')?.tokenUsage).toEqual({
      scope: 'run', source: 'commandcode-terminal-result-v1', input: 11, output: 7, total: 18,
    });
    await expect(first.create(receipt({
      runId: 'bad-usage',
      runtime: 'commandcode',
      executionInstanceId: 'commandcode-default',
      model: 'meta/muse-spark-1.2-contributor',
      tokenUsage: { scope: 'run', source: 'commandcode-terminal-result-v1', input: 11, output: 7, total: 99 },
    } as never))).rejects.toThrow(/token|usage|total/i);
  });

  it('round-trips additive output evidence and keeps legacy receipts readable', async () => {
    const first = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await first.init();
    await first.create(receipt({
      status: 'completed',
      terminalAt: '2026-07-15T12:00:02.000Z',
      outputEvidence: {
        policyVersion: 'run-output-v1',
        source: 'normalized-events-v1',
        assistantMessages: 1,
        assistantTextBlocks: 2,
        assistantTextChars: 18,
        toolCalls: 1,
        disposition: 'text',
      },
    }));

    const restarted = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await restarted.init();
    expect(restarted.get('run-1')?.outputEvidence).toMatchObject({
      source: 'normalized-events-v1',
      assistantTextChars: 18,
      disposition: 'text',
    });

    await restarted.create(receipt({ runId: 'legacy-run' }));
    expect(restarted.get('legacy-run')).not.toHaveProperty('outputEvidence');
  });

  it('does not expose mutable references to nested liveness evidence', async () => {
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await store.init();
    await store.create(receipt({
      liveness: {
        activityPolicyVersion: 'run-activity-v1',
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 10_000,
        terminalObservations: [{
          type: 'agent_end',
          occurredAt: '2026-07-15T12:00:01.000Z',
          observedAt: '2026-07-15T12:00:01.000Z',
          origin: 'runtime_or_adapter',
          late: false,
        }],
        cessation: { state: 'unconfirmed', basis: 'terminal_signal', observedAt: '2026-07-15T12:00:01.000Z' },
      },
    }));

    const exposed = store.get('run-1')!;
    exposed.liveness!.cessation.state = 'confirmed';
    exposed.liveness!.terminalObservations!.push({
      type: 'agent_end', occurredAt: '2026-07-15T12:00:02.000Z', observedAt: '2026-07-15T12:00:02.000Z',
      origin: 'synthetic', late: true,
    });

    expect(store.get('run-1')?.liveness).toMatchObject({
      cessation: { state: 'unconfirmed' },
      terminalObservations: [{ origin: 'runtime_or_adapter' }],
    });
    expect(store.get('run-1')?.liveness?.terminalObservations).toHaveLength(1);
  });

  it('rejects unsafe receipt and nested liveness fields so payloads and credentials cannot be persisted', async () => {
    const store = new RunReceiptStore(dir, { now: () => FIXTURE_NOW });
    await store.init();

    await expect(store.create({ ...receipt(), prompt: 'do not persist' } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create({ ...receipt(), apiKey: 'secret' } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create({ ...receipt(), token: 'secret' } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create({ ...receipt(), transcript: [] } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create(receipt({
      runtime: 'claude',
      phase7Shadow: classifyPhase7PiShadow({ sessionId: 'session-1', message: 'Keep working.' }),
    }))).rejects.toThrow(/Pi runtime/i);
    await expect(store.create({
      ...receipt(),
      liveness: {
        activityPolicyVersion: 'run-activity-v1',
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 10_000,
        prompt: 'nested prompt leak',
        cessation: { state: 'unknown', basis: 'no_terminal_signal', observedAt: '2026-07-15T12:00:00.000Z' },
      },
    } as never)).rejects.toThrow(/unsupported|unsafe/i);
    await expect(store.create(receipt({
      runId: 'unsafe-reason',
      liveness: {
        activityPolicyVersion: 'run-activity-v1',
        idleTimeoutMs: 1_000,
        absoluteTimeoutMs: 10_000,
        terminalObservations: [{
          type: 'agent_end',
          occurredAt: '2026-07-15T12:00:01.000Z',
          observedAt: '2026-07-15T12:00:01.000Z',
          origin: 'synthetic',
          reason: 'token_sk:livesecret',
          late: false,
        }],
        cessation: { state: 'unconfirmed', basis: 'synthetic_terminal_signal', observedAt: '2026-07-15T12:00:01.000Z' },
      },
    }))).rejects.toThrow(/reason/i);
  });
});

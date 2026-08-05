import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunReceiptManager, type BeginRunInput } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';
import {
  classifyPhase7PiShadow,
  PHASE7_PI_SHADOW_THRESHOLDS,
} from '../../../src/internal-api/phase7-pi-shadow.js';

const baseInput: BeginRunInput = {
  sessionId: 'pi-shadow-session',
  runtime: 'pi',
  executionInstanceId: 'pi-local-default',
  model: 'openai-codex/gpt-test',
  message: 'Keep working.',
  mode: 'prompt',
  dispatchMode: 'prompt',
  verbosity: 'answers',
  detach: true,
};

describe('RunReceiptManager Phase 7 shadow evidence', () => {
  let manager: RunReceiptManager;
  let now: number;

  beforeEach(async () => {
    now = 1_700_000_000_000;
    manager = new RunReceiptManager({
      store: new RunReceiptStore(undefined, { now: () => now }),
      now: () => now,
      idFactory: () => 'phase7-shadow-run',
      turnIdleTimeoutMs: 60_000,
      turnMaxMs: 300_000,
    });
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it('persists final tool-event classification and bounded evidence in the receipt', async () => {
    const begun = await manager.beginRun({
      ...baseInput,
      phase7Shadow: classifyPhase7PiShadow({
        sessionId: baseInput.sessionId,
        message: baseInput.message,
      }),
    });

    await manager.markStarted(begun.receipt.runId);
    for (let index = 0; index < PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount; index += 1) {
      await manager.observeEvent(begun.receipt.runId, {
        type: 'tool_execution_start',
        sessionId: baseInput.sessionId,
        timestamp: now + index,
        data: {},
      });
    }
    now += 1_000;
    await manager.finish(begun.receipt.runId);

    expect(manager.get(begun.receipt.runId)?.phase7Shadow).toMatchObject({
      policyVersion: 'phase7-pi-shadow/v1',
      mode: 'shadow',
      profile: 'heavy',
      reasonCodes: ['tool_event_threshold'],
      affinity: { kind: 'session', sessionId: baseInput.sessionId, ownership: 'server-owned' },
      resourceIdentity: {
        kind: 'shared-service',
        boundary: 'pi-control-process',
        ownership: 'server-owned',
        sessionScoped: false,
      },
      evidence: {
        promptBytes: expect.any(Number),
        toolEventCount: PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount,
        durationMs: 1_000,
      },
    });
  });

  it('rejects caller-forged shadow metadata instead of trusting an internal begin-run field', async () => {
    const classification = classifyPhase7PiShadow({
      sessionId: baseInput.sessionId,
      message: baseInput.message,
    });

    await expect(manager.beginRun({
      ...baseInput,
      phase7Shadow: { ...classification, profile: 'heavy' },
    })).rejects.toThrow('does not match the server classifier');
  });

  it('retains observed tool evidence when a disk-backed receipt is recovered after restart', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-phase7-restart-'));
    try {
      const firstStore = new RunReceiptStore(dir, { now: () => now });
      const firstManager = new RunReceiptManager({
        store: firstStore,
        now: () => now,
        idFactory: () => 'phase7-restart-run',
        turnIdleTimeoutMs: 60_000,
        turnMaxMs: 300_000,
      });
      await firstManager.init();
      const begun = await firstManager.beginRun({
        ...baseInput,
        phase7Shadow: classifyPhase7PiShadow({ sessionId: baseInput.sessionId, message: baseInput.message }),
      });
      await firstManager.markStarted(begun.receipt.runId);
      for (let index = 0; index < 3; index += 1) {
        await firstManager.observeEvent(begun.receipt.runId, {
          type: 'tool_execution_start',
          sessionId: baseInput.sessionId,
          timestamp: now + index,
          data: {},
        });
      }
      await firstManager.shutdown();

      const restartedStore = new RunReceiptStore(dir, { now: () => now + 1_000 });
      const restartedManager = new RunReceiptManager({
        store: restartedStore,
        now: () => now + 1_000,
        turnIdleTimeoutMs: 60_000,
        turnMaxMs: 300_000,
      });
      await restartedManager.init();
      expect(restartedManager.get(begun.receipt.runId)).toMatchObject({
        status: 'interrupted',
        phase7Shadow: { profile: 'standard', evidence: { toolEventCount: 3 } },
      });
      await restartedManager.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not add shadow metadata to non-Pi receipts when no classification is supplied', async () => {
    const begun = await manager.beginRun({
      ...baseInput,
      runtime: 'claude',
      executionInstanceId: 'claude-default',
    });

    expect(manager.get(begun.receipt.runId)).not.toHaveProperty('phase7Shadow');
  });
});

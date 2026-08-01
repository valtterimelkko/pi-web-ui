/* eslint-disable @typescript-eslint/no-explicit-any -- compact scenario client doubles intentionally cover a partial surface */
import { describe, expect, it, vi } from 'vitest';
import { listScenarioIds, scenarioRegistry } from '../../../src/live-validation/scenarios.js';

const capabilities = {
  runtimes: {
    pi: { supportsFollowUp: true },
    claude: { supportsFollowUp: true },
    opencode: { supportsFollowUp: true },
    antigravity: { supportsFollowUp: true },
  },
} as any;

describe('dispatch-integrity live scenarios', () => {
  it('registers every dispatch, approval, and watchdog scenario', () => {
    expect(listScenarioIds()).toEqual(expect.arrayContaining([
      'follow-up',
      'follow-up-strict',
      'prompt-mode-busy',
      'approval-wrong-id',
      'approval-by-toolcall-id',
      'stalled-run-reaped',
    ]));
  });

  it('stalled-run-reaped requires durable idle-watchdog and cessation evidence', async () => {
    const previousTimeout = process.env.INTERNAL_API_TURN_IDLE_TIMEOUT_MS;
    process.env.INTERNAL_API_TURN_IDLE_TIMEOUT_MS = '2000';
    try {
      const client = {
        createSession: vi.fn().mockResolvedValue({ sessionId: 'pi-1' }),
        promptWithIdempotency: vi.fn().mockResolvedValue({ runId: 'run-stalled' }),
        getRunReceipt: vi.fn().mockResolvedValue({
          runId: 'run-stalled',
          sessionId: 'pi-1',
          runtime: 'pi',
          executionInstanceId: 'pi-local-default',
          status: 'failed',
          acceptedAt: '2026-08-01T12:00:00.000Z',
          terminalAt: '2026-08-01T12:00:02.000Z',
          errorCode: 'TURN_STALLED',
          dispatchMode: 'prompt',
          liveness: {
            activityPolicyVersion: 'run-activity-v1',
            idleTimeoutMs: 2000,
            absoluteTimeoutMs: 10000,
            watchdog: {
              reason: 'idle',
              decidedAt: '2026-08-01T12:00:02.000Z',
              idleTimeoutMs: 2000,
              absoluteTimeoutMs: 10000,
            },
            cessation: { state: 'unknown', basis: 'watchdog', observedAt: '2026-08-01T12:00:02.000Z' },
          },
        }),
        getCapacity: vi.fn().mockResolvedValue({ activeTurns: 0 }),
        getSessionInfo: vi.fn().mockResolvedValue({}),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      } as any;

      const result = await scenarioRegistry['stalled-run-reaped'].run({
        client,
        runtime: 'pi',
        capabilities,
        cwd: '/tmp',
      });

      expect(result.assertions).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idle_watchdog_evidence', passed: true }),
        expect.objectContaining({ name: 'cessation_not_overclaimed', passed: true }),
      ]));
    } finally {
      if (previousTimeout === undefined) delete process.env.INTERNAL_API_TURN_IDLE_TIMEOUT_MS;
      else process.env.INTERNAL_API_TURN_IDLE_TIMEOUT_MS = previousTimeout;
    }
  });

  it('follow-up proves idle promotion through the reported dispatch mode', async () => {
    const client = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'pi-1' }),
      promptStream: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { type: 'agent_start', timestamp: 1, data: {} },
          { type: 'message_update', timestamp: 2, data: { delta: 'SECOND-VALIDATION-TURN' } },
          { type: 'agent_end', timestamp: 3, data: {} },
        ]),
      getLastPromptEvidence: vi.fn(() => ({ runId: 'run-2', eventCounts: {}, dispatchMode: 'prompt' })),
      getSessionInfo: vi.fn().mockResolvedValue({}),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    } as any;

    const result = await scenarioRegistry['follow-up'].run({
      client,
      runtime: 'pi',
      capabilities,
      cwd: '/tmp',
    });

    expect(result.assertions).toContainEqual(expect.objectContaining({ name: 'dispatch_mode_promoted', passed: true }));
  });
});

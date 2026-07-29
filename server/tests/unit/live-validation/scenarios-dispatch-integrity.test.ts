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

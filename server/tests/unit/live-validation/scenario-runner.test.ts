import { describe, it, expect, vi } from 'vitest';
import { collectValidationSummary } from '../../../src/live-validation/event-recorder.js';
import { runScenario, scenarioRegistry } from '../../../src/live-validation/scenarios.js';
import type { InternalApiClientLike, ValidationCapabilities } from '../../../src/live-validation/types.js';

function makeCapabilities(overrides: Partial<ValidationCapabilities['runtimes']> = {}): ValidationCapabilities {
  return {
    status: 'ok',
    contract: {
      name: 'pi-web-ui-internal-api',
      routePrefix: '/api/v1',
      majorVersion: 'v1',
      contractVersion: '1.5.0',
      stability: 'beta',
      contractDoc: 'docs/INTERNAL-API-CONTRACT.md',
    },
    runtimes: {
      pi: {
        available: true,
        backendMode: 'native',
        supportsFollowUp: true,
        supportsSteer: true,
        supportsModelSwitch: true,
        supportsThinkingLevel: true,
        supportsPinning: true,
        supportsReplayHistory: false,
        supportsApprovals: false,
        supportsHeartbeat: false,
      },
      claude: {
        available: true,
        backendMode: 'channel',
        supportsFollowUp: true,
        supportsSteer: false,
        supportsModelSwitch: true,
        supportsThinkingLevel: true,
        supportsPinning: true,
        supportsReplayHistory: true,
        supportsApprovals: true,
        supportsHeartbeat: true,
      },
      opencode: {
        available: true,
        backendMode: 'server',
        supportsFollowUp: true,
        supportsSteer: false,
        supportsModelSwitch: true,
        supportsThinkingLevel: false,
        supportsPinning: true,
        supportsReplayHistory: true,
        supportsApprovals: true,
        supportsHeartbeat: false,
      },
      antigravity: {
        available: true,
        backendMode: 'subprocess',
        supportsFollowUp: true,
        supportsSteer: false,
        supportsModelSwitch: true,
        supportsThinkingLevel: false,
        supportsPinning: true,
        supportsReplayHistory: true,
        supportsApprovals: false,
        supportsHeartbeat: false,
      },
      ...overrides,
    },
  };
}

describe('collectValidationSummary', () => {
  it('extracts assistant text, tool names, agent lifecycle, and heartbeat count', () => {
    const summary = collectValidationSummary([
      { type: 'agent_start', timestamp: 1, data: {} },
      { type: 'tool_execution_start', timestamp: 2, data: { toolName: 'Bash' } },
      { type: 'stream_activity', timestamp: 3, data: { detail: 'busy' } },
      { type: 'message_update', timestamp: 4, data: { assistantMessageEvent: { type: 'text_delta', delta: 'LIVE-VALIDATION-OK' } } },
      { type: 'agent_end', timestamp: 5, data: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ] as any);

    expect(summary).toMatchObject({
      sawAgentStart: true,
      sawAgentEnd: true,
      heartbeatCount: 1,
      toolNames: ['Bash'],
      assistantText: 'LIVE-VALIDATION-OK',
    });
  });
});

describe('runScenario', () => {
  it('runs the smoke scenario against a runtime using the internal API client', async () => {
    const client: InternalApiClientLike = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', sessionPath: 'sess-1', runtime: 'claude', cwd: '/root/pi-web-ui', createdAt: '2026-05-20T00:00:00.000Z' }),
      promptStream: vi.fn().mockResolvedValue([
        { type: 'agent_start', timestamp: 1, data: {} },
        { type: 'message_update', timestamp: 2, data: { assistantMessageEvent: { type: 'text_delta', delta: 'LIVE-VALIDATION-OK' } } },
        { type: 'agent_end', timestamp: 3, data: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
      getSessionInfo: vi.fn().mockResolvedValue({
        sessionId: 'sess-1', sessionPath: 'sess-1', runtime: 'claude', executionInstanceId: 'claude-profile-1',
        cwd: '/root/pi-web-ui', model: 'sonnet', backendMode: 'sdk', messageCount: 1, firstMessage: 'x',
        status: 'idle', createdAt: '2026-05-20T00:00:00.000Z', lastActivity: '2026-05-20T00:00:00.000Z',
      }),
      getCapabilities: vi.fn().mockResolvedValue(makeCapabilities()),
      controlSession: vi.fn(),
      getSessionHistory: vi.fn(),
      respondToApproval: vi.fn(),
      optInNotifications: vi.fn().mockResolvedValue({}),
      getNotificationState: vi.fn().mockResolvedValue({ optIn: null, deliveries: [] }),
      getLastPromptEvidence: vi.fn().mockReturnValue({
        runId: 'run-1',
        eventCounts: { agent_start: 1, message_update: 1, agent_end: 1 },
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runScenario({
      client,
      runtime: 'claude',
      scenario: scenarioRegistry['smoke'],
      capabilities: makeCapabilities(),
      cwd: '/root/pi-web-ui',
    });

    expect(result.passed).toBe(true);
    expect(result.assertions.some((assertion) => assertion.name === 'assistant_text')).toBe(true);
    expect(result).toMatchObject({
      runId: 'run-1', model: 'sonnet', backendMode: 'sdk', executionInstanceId: 'claude-profile-1',
      eventCounts: { agent_start: 1, message_update: 1, agent_end: 1 },
      attemptHistory: [{ attempt: 1, passed: true }],
    });
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    expect(result.durationMs).toBeTypeOf('number');
    expect(client.createSession).toHaveBeenCalled();
    expect(client.deleteSession).toHaveBeenCalledWith('sess-1');
  });

  it('preserves the original execution failure and cleanup warnings', async () => {
    const client = {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-fail', runtime: 'pi' }),
      promptStream: vi.fn().mockRejectedValue(new Error('runtime failed')),
      getSessionInfo: vi.fn(),
      getCapabilities: vi.fn(),
      controlSession: vi.fn(),
      getSessionHistory: vi.fn(),
      respondToApproval: vi.fn(),
      optInNotifications: vi.fn(),
      getNotificationState: vi.fn(),
      deleteSession: vi.fn().mockRejectedValue(new Error('delete failed')),
    } as unknown as InternalApiClientLike;
    const result = await runScenario({
      client,
      runtime: 'pi',
      scenario: scenarioRegistry.smoke,
      capabilities: makeCapabilities(),
      cwd: '/root/pi-web-ui',
    });
    expect(result.reason).toContain('runtime failed');
    expect(result.cleanupWarnings).toContain('session cleanup failed: delete failed');
  });

  it('skips unsupported scenarios based on runtime capabilities', async () => {
    const client: InternalApiClientLike = {
      createSession: vi.fn(),
      promptStream: vi.fn(),
      getSessionInfo: vi.fn(),
      getCapabilities: vi.fn(),
      controlSession: vi.fn(),
      getSessionHistory: vi.fn(),
      respondToApproval: vi.fn(),
      optInNotifications: vi.fn(),
      getNotificationState: vi.fn(),
      deleteSession: vi.fn(),
    } as any;

    const result = await runScenario({
      client,
      runtime: 'claude',
      scenario: scenarioRegistry['channel-heartbeat'],
      capabilities: makeCapabilities({ claude: { ...makeCapabilities().runtimes.claude, backendMode: 'direct', supportsHeartbeat: false } }),
      cwd: '/root/pi-web-ui',
    });

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('supportsHeartbeat');
  });

  it('retries a failed scenario once and returns the successful retry result', async () => {
    const attemptResults = [
      {
        scenarioId: 'smoke',
        runtime: 'claude',
        passed: false,
        assertions: [{ name: 'assistant_text', passed: false, details: '' }],
      },
      {
        scenarioId: 'smoke',
        runtime: 'claude',
        passed: true,
        assertions: [{ name: 'assistant_text', passed: true, details: 'LIVE-VALIDATION-OK' }],
      },
    ];

    const retryScenario = {
      id: 'retry-smoke',
      description: 'retry test',
      run: vi.fn()
        .mockResolvedValueOnce(attemptResults[0])
        .mockResolvedValueOnce(attemptResults[1]),
    } as any;

    const client: InternalApiClientLike = {
      createSession: vi.fn(),
      promptStream: vi.fn(),
      getSessionInfo: vi.fn(),
      getCapabilities: vi.fn(),
      controlSession: vi.fn(),
      getSessionHistory: vi.fn(),
      respondToApproval: vi.fn(),
      optInNotifications: vi.fn(),
      getNotificationState: vi.fn(),
      deleteSession: vi.fn(),
    } as any;

    const result = await runScenario({
      client,
      runtime: 'claude',
      scenario: retryScenario,
      capabilities: makeCapabilities(),
      cwd: '/root/pi-web-ui',
    });

    expect(retryScenario.run).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(true);
    expect(result.attempt).toBe(2);
    expect(result.attemptHistory).toMatchObject([
      { attempt: 1, passed: false },
      { attempt: 2, passed: true },
    ]);
  });

  it('uses GLM-5.2 when exercising the OpenCode thinking-level scenario', async () => {
    const client: InternalApiClientLike = {
      createSession: vi.fn().mockResolvedValue({
        sessionId: 'oc-sess-1',
        sessionPath: 'oc-sess-1',
        runtime: 'opencode',
        cwd: '/root/pi-web-ui',
        createdAt: '2026-06-13T00:00:00.000Z',
      }),
      promptStream: vi.fn(),
      getSessionInfo: vi.fn(),
      getCapabilities: vi.fn(),
      controlSession: vi.fn().mockResolvedValue({ ok: true }),
      getSessionHistory: vi.fn(),
      respondToApproval: vi.fn(),
      optInNotifications: vi.fn().mockResolvedValue({}),
      getNotificationState: vi.fn().mockResolvedValue({ optIn: null, deliveries: [] }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };

    await runScenario({
      client,
      runtime: 'opencode',
      scenario: scenarioRegistry['thinking-level'],
      capabilities: makeCapabilities({
        opencode: {
          ...makeCapabilities().runtimes.opencode,
          supportsThinkingLevel: true,
        },
      }),
      cwd: '/root/pi-web-ui',
    });

    expect(client.controlSession).toHaveBeenCalledWith('oc-sess-1', {
      action: 'set_model',
      modelId: 'glm-5.2',
    });
  });
});

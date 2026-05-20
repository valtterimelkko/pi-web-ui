import type {
  ValidationAssertion,
  ValidationCapabilities,
  ValidationContext,
  ValidationRuntime,
  ValidationScenario,
  ValidationScenarioResult,
} from './types.js';
import { collectValidationSummary } from './event-recorder.js';

function requireCapability(
  capabilities: ValidationCapabilities,
  runtime: ValidationRuntime,
  key: keyof ValidationCapabilities['runtimes'][ValidationRuntime],
): string | null {
  const runtimeCaps = capabilities.runtimes[runtime] as unknown as Record<string, unknown>;
  return runtimeCaps[key as string] ? null : `Scenario requires ${String(key)} for ${runtime}`;
}

async function withEphemeralSession(
  context: ValidationContext,
  execute: (sessionId: string) => Promise<ValidationScenarioResult>,
): Promise<ValidationScenarioResult> {
  const session = await context.client.createSession({
    runtime: context.runtime,
    cwd: context.cwd,
    source: 'live-validation',
    scenarioId: 'ephemeral',
    ephemeral: true,
  });

  try {
    const result = await execute(session.sessionId);
    return { ...result, sessionId: session.sessionId };
  } finally {
    await context.client.deleteSession(session.sessionId).catch(() => undefined);
  }
}

function buildAssertions(summary: ReturnType<typeof collectValidationSummary>, expectedText: string): ValidationAssertion[] {
  return [
    { name: 'agent_start', passed: summary.sawAgentStart, details: summary.sawAgentStart ? 'agent_start seen' : 'agent_start missing' },
    { name: 'agent_end', passed: summary.sawAgentEnd, details: summary.sawAgentEnd ? 'agent_end seen' : 'agent_end missing' },
    {
      name: 'assistant_text',
      passed: summary.assistantText.includes(expectedText),
      details: summary.assistantText,
    },
  ];
}

export const scenarioRegistry: Record<string, ValidationScenario> = {
  smoke: {
    id: 'smoke',
    description: 'Create a session and verify a minimal turn completes.',
    async run(context) {
      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with the exact text LIVE-VALIDATION-OK and nothing else.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const assertions = buildAssertions(summary, 'LIVE-VALIDATION-OK');
        return {
          scenarioId: 'smoke',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
        };
      });
    },
  },
  'channel-heartbeat': {
    id: 'channel-heartbeat',
    description: 'Verify Claude channel-backed sessions emit stream_activity heartbeats during a live turn.',
    async run(context) {
      const unsupportedReason = requireCapability(context.capabilities, context.runtime, 'supportsHeartbeat');
      if (unsupportedReason) {
        return {
          scenarioId: 'channel-heartbeat',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: unsupportedReason,
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Run exactly one bash command: echo LIVE-VALIDATION-HEARTBEAT and then report the output in one sentence.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const assertions: ValidationAssertion[] = [
          ...buildAssertions(summary, 'LIVE-VALIDATION-HEARTBEAT'),
          {
            name: 'stream_activity',
            passed: summary.heartbeatCount > 0,
            details: `heartbeatCount=${summary.heartbeatCount}`,
          },
        ];
        return {
          scenarioId: 'channel-heartbeat',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
        };
      });
    },
  },
  'tool-visibility': {
    id: 'tool-visibility',
    description: 'Verify a tool execution event is surfaced in the full stream.',
    async run(context) {
      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Run exactly one bash command: echo LIVE-VALIDATION-TOOL and then report the output.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const assertions: ValidationAssertion[] = [
          ...buildAssertions(summary, 'LIVE-VALIDATION-TOOL'),
          {
            name: 'tool_execution_start',
            passed: summary.toolNames.length > 0,
            details: summary.toolNames.join(', '),
          },
        ];
        return {
          scenarioId: 'tool-visibility',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
        };
      });
    },
  },
  'session-info': {
    id: 'session-info',
    description: 'Verify the enriched session info endpoint returns live runtime metadata.',
    async run(context) {
      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with the exact text LIVE-VALIDATION-INFO and nothing else.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const info = await context.client.getSessionInfo(sessionId);
        const assertions: ValidationAssertion[] = [
          ...buildAssertions(summary, 'LIVE-VALIDATION-INFO'),
          { name: 'session_info_runtime', passed: info.runtime === context.runtime, details: info.runtime },
          { name: 'session_info_message_count', passed: info.messageCount >= 0, details: `${info.messageCount}` },
        ];
        return {
          scenarioId: 'session-info',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
        };
      });
    },
  },
  'follow-up': {
    id: 'follow-up',
    description: 'Verify the runtime accepts a follow-up turn over the Internal API.',
    async run(context) {
      const unsupportedReason = requireCapability(context.capabilities, context.runtime, 'supportsFollowUp');
      if (unsupportedReason) {
        return {
          scenarioId: 'follow-up',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: unsupportedReason,
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        await context.client.promptStream(sessionId, {
          message: 'Reply with FIRST-VALIDATION-TURN.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with SECOND-VALIDATION-TURN.',
          verbosity: 'full',
          mode: 'follow_up',
        });
        const summary = collectValidationSummary(events);
        const assertions = buildAssertions(summary, 'SECOND-VALIDATION-TURN');
        return {
          scenarioId: 'follow-up',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
        };
      });
    },
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runScenario(context: ValidationContext & { scenario: ValidationScenario }): Promise<ValidationScenarioResult> {
  const maxAttempts = 2;
  let lastResult: ValidationScenarioResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await context.scenario.run(context);
    result.attempt = attempt;
    lastResult = result;

    if (result.passed || result.skipped || attempt === maxAttempts) {
      return result;
    }

    await sleep(1500);
  }

  return lastResult ?? {
    scenarioId: context.scenario.id,
    runtime: context.runtime,
    passed: false,
    assertions: [{ name: 'runner', passed: false, details: 'Scenario did not produce a result' }],
    attempt: maxAttempts,
  };
}

export function listScenarioIds(): string[] {
  return Object.keys(scenarioRegistry);
}

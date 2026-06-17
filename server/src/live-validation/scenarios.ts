import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  ValidationAssertion,
  ValidationCapabilities,
  ValidationContext,
  ValidationRuntime,
  ValidationScenario,
  ValidationScenarioResult,
} from './types.js';
import { collectValidationSummary } from './event-recorder.js';

interface OpenCodeJsonConfig {
  provider?: Record<string, {
    models?: Record<string, { options?: Record<string, unknown> }>;
  }>;
  [key: string]: unknown;
}

function findThinkingOption(cfg: OpenCodeJsonConfig): { type: string } | null {
  for (const prov of Object.values(cfg.provider ?? {})) {
    for (const model of Object.values(prov.models ?? {})) {
      const thinking = model.options?.['thinking'];
      if (thinking && typeof thinking === 'object' && 'type' in thinking) {
        return thinking as { type: string };
      }
    }
  }
  return null;
}

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
    model: context.model,
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
  'model-smoke': {
    id: 'model-smoke',
    description: 'Verify a specific model (via --model) is actually usable: minimal turn completes.',
    async run(context) {
      if (!context.model) {
        return {
          scenarioId: 'model-smoke',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'model-smoke requires --model <provider/id>',
          assertions: [],
        };
      }
      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with the exact text LIVE-VALIDATION-OK and nothing else.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const assertions: ValidationAssertion[] = [
          { name: 'model', passed: true, details: context.model },
          ...buildAssertions(summary, 'LIVE-VALIDATION-OK'),
        ];
        return {
          scenarioId: 'model-smoke',
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
  'thinking-level': {
    id: 'thinking-level',
    description: 'Verify thinking level changes write the correct thinkingBudget to opencode.json and clean up on off.',
    async run(context) {
      const unsupportedReason = requireCapability(context.capabilities, context.runtime, 'supportsThinkingLevel');
      if (unsupportedReason) {
        return {
          scenarioId: 'thinking-level',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: unsupportedReason,
          assertions: [],
        };
      }

      if (context.runtime !== 'opencode') {
        return {
          scenarioId: 'thinking-level',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'thinking-level config-file validation only applies to the opencode runtime',
          assertions: [],
        };
      }

      const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

      function readConfig(): OpenCodeJsonConfig {
        try {
          return JSON.parse(readFileSync(configPath, 'utf-8')) as OpenCodeJsonConfig;
        } catch {
          return {};
        }
      }

      return withEphemeralSession(context, async (sessionId) => {
        const assertions: ValidationAssertion[] = [];

        // Capability check
        const caps = context.capabilities.runtimes.opencode;
        assertions.push({
          name: 'capability_supportsThinkingLevel',
          passed: caps.supportsThinkingLevel === true,
          details: `supportsThinkingLevel=${String(caps.supportsThinkingLevel)}`,
        });

        // setThinkingLevel requires a model to be set in the registry (needed to
        // know which provider/model key to write in opencode.json).
        let modelOk = false;
        try {
          await context.client.controlSession(sessionId, { action: 'set_model', modelId: 'glm-5.2' });
          modelOk = true;
          assertions.push({ name: 'set_model', passed: true, details: 'model set to glm-5.2' });
        } catch (err) {
          assertions.push({ name: 'set_model', passed: false, details: String(err) });
        }

        if (!modelOk) {
          return {
            scenarioId: 'thinking-level',
            runtime: context.runtime,
            passed: false,
            assertions,
          };
        }

        // Set thinking level to high
        let controlOk = false;
        try {
          const result = await context.client.controlSession(sessionId, { action: 'set_thinking_level', level: 'high' });
          controlOk = true;
          assertions.push({
            name: 'set_thinking_level_high',
            passed: true,
            details: JSON.stringify(result),
          });
        } catch (err) {
          assertions.push({
            name: 'set_thinking_level_high',
            passed: false,
            details: String(err),
          });
        }

        if (controlOk) {
          // Verify opencode.json was written with thinking:{type:"enabled"}
          const cfgHigh = readConfig();
          const highThinking = findThinkingOption(cfgHigh);
          assertions.push({
            name: 'config_written_enabled',
            passed: highThinking?.type === 'enabled',
            details: `thinking=${JSON.stringify(highThinking)} (expected type=enabled)`,
          });

          // Reset to off — should clean up the config entry
          try {
            await context.client.controlSession(sessionId, { action: 'set_thinking_level', level: 'off' });
            assertions.push({ name: 'set_thinking_level_off', passed: true, details: 'off accepted' });
          } catch (err) {
            assertions.push({ name: 'set_thinking_level_off', passed: false, details: String(err) });
          }

          const cfgOff = readConfig();
          const offThinking = findThinkingOption(cfgOff);
          assertions.push({
            name: 'config_written_off',
            passed: offThinking?.type === 'disabled',
            details: `thinking after off=${JSON.stringify(offThinking)} (expected type=disabled)`,
          });
        }

        return {
          scenarioId: 'thinking-level',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
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

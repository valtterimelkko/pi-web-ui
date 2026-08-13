import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  InternalApiClientLike,
  ValidationAssertion,
  ValidationCapabilities,
  ValidationContext,
  ValidationRuntime,
  ValidationScenario,
  ValidationScenarioResult,
} from './types.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
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

function findReasoningEffort(cfg: OpenCodeJsonConfig): string | null {
  for (const prov of Object.values(cfg.provider ?? {})) {
    for (const model of Object.values(prov.models ?? {})) {
      const effort = model.options?.['reasoning_effort'];
      if (typeof effort === 'string') {
        return effort;
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
  execute: (sessionId: string, session: Awaited<ReturnType<InternalApiClientLike['createSession']>>) => Promise<ValidationScenarioResult>,
): Promise<ValidationScenarioResult> {
  const session = await context.client.createSession({
    runtime: context.runtime,
    cwd: context.cwd,
    model: context.model,
    source: context.runtime === 'commandcode' ? 'live-validation-commandcode-fixture' : 'live-validation',
    scenarioId: 'ephemeral',
    ephemeral: true,
  });

  let result: ValidationScenarioResult | undefined;
  let executionError: unknown;
  let detail: Awaited<ReturnType<InternalApiClientLike['getSessionInfo']>> | undefined;
  const cleanupWarnings: string[] = [];
  try {
    result = await execute(session.sessionId, session);
    detail = await context.client.getSessionInfo(session.sessionId).catch(() => undefined);
  } catch (error) {
    executionError = error;
  } finally {
    try {
      await context.client.deleteSession(session.sessionId);
    } catch (error) {
      cleanupWarnings.push(`session cleanup failed: ${safeFailureMessage(error)}`);
    }
  }
  if (executionError !== undefined) {
    const error = executionError instanceof Error
      ? executionError
      : new Error(safeFailureMessage(executionError));
    Object.assign(error, { cleanupWarnings });
    throw error;
  }
  if (!result) throw new Error('Scenario did not produce a result');
  const promptEvidence = context.client.getLastPromptEvidence?.(session.sessionId);
  return {
    ...result,
    sessionId: session.sessionId,
    model: detail?.model ?? session.model,
    backendMode: detail?.backendMode,
    executionInstanceId: detail?.executionInstanceId,
    runId: promptEvidence?.runId ?? result.runId,
    eventCounts: promptEvidence?.eventCounts ?? result.eventCounts,
    ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
  };
}

/**
 * Build deterministic answers for the `claude-ask-user-question` scenario,
 * keyed by the EXACT question text Claude emitted (not guessed text).
 *
 * Selection rules (matched by keyword in question/header, label-agnostic):
 *  - colour/color  → the option whose label contains "blue"
 *  - size          → the option whose label contains "large"
 *  - feature(s)    → multi-select: the options whose labels contain "search"
 *                    or "export", comma-joined (excludes "attachments")
 *  - otherwise     → the last option (so every question still gets an answer)
 */
export function buildAskUserAnswers(
  questions: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string }> }>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const haystack = `${q.question} ${q.header}`.toLowerCase();
    const labels = q.options.map((o) => o.label);

    if (haystack.includes('colour') || haystack.includes('color')) {
      answers[q.question] = labels.find((l) => /blue/i.test(l)) ?? labels[1] ?? labels[0];
    } else if (haystack.includes('size')) {
      answers[q.question] = labels.find((l) => /large/i.test(l)) ?? labels[1] ?? labels[0];
    } else if (haystack.includes('feature')) {
      const selected = labels.filter((l) => /search|export/i.test(l));
      answers[q.question] = selected.length > 0 ? selected.join(', ') : labels.slice(0, 2).join(', ');
    } else {
      answers[q.question] = labels[labels.length - 1] ?? '';
    }
  }
  return answers;
}

/**
 * Default delay before the `claude-ask-user-question-delayed-answer` scenario
 * answers, proving the dialog does not prematurely expire within a realistic
 * window. Env-overridable via `CLAUDE_ASK_USER_DELAYED_ANSWER_MS` (>= 0).
 */
const DEFAULT_DELAYED_ANSWER_DELAY_MS = 1000;

function readDelayedAnswerDelayMs(): number {
  const raw = process.env.CLAUDE_ASK_USER_DELAYED_ANSWER_MS;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_DELAYED_ANSWER_DELAY_MS;
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

/**
 * Poll a session's notification state until an agent_end delivery appears (or
 * timeout). The manager debounces after agent_end, so the record isn't instant.
 */
async function waitForNotificationDelivery(
  client: { getNotificationState(sessionId: string): Promise<{ deliveries: unknown[] }> },
  sessionId: string,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await client
      .getNotificationState(sessionId)
      .catch(() => ({ deliveries: [] as unknown[] }));
    const captured = (state.deliveries ?? []).some(
      (d) => (d as { notification?: { kind?: string } }).notification?.kind === 'agent_end',
    );
    if (captured) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export const scenarioRegistry: Record<string, ValidationScenario> = {
  'commandcode-fixture-smoke': {
    id: 'commandcode-fixture-smoke',
    description: 'Create a deterministic local Command Code fixture session and verify normalized streaming, replay and terminal usage evidence.',
    async run(context) {
      if (context.runtime !== 'commandcode') {
        return { scenarioId: 'commandcode-fixture-smoke', runtime: context.runtime, passed: true, skipped: true, reason: 'Command Code fixture only', assertions: [] };
      }
      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with the exact text COMMAND-CODE-LIVE-OK and nothing else.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const history = await context.client.getSessionHistory(sessionId);
        const evidence = await context.client.getSessionEvidence?.(sessionId, ['runs', 'transcript']);
        const types = history.events.map((event) => String(event.type ?? ''));
        const assertions: ValidationAssertion[] = [
          { name: 'agent_start', passed: summary.sawAgentStart, details: 'normalized agent_start' },
          { name: 'agent_end', passed: summary.sawAgentEnd, details: 'normalized agent_end' },
          { name: 'assistant_text', passed: summary.assistantText.includes('COMMAND-CODE-LIVE-OK'), details: summary.assistantText },
          { name: 'replay_has_terminal', passed: types.includes('agent_end'), details: types.join(',') },
          { name: 'run_usage_evidence', passed: evidence?.runReceipts?.some((receipt) => receipt.tokenUsage?.source === 'commandcode-terminal-result-v1') === true, details: evidence?.runReceipts?.[0]?.tokenUsage ? 'terminal usage present' : 'terminal usage missing' },
        ];
        return { scenarioId: 'commandcode-fixture-smoke', runtime: context.runtime, passed: assertions.every((a) => a.passed), assertions };
      });
    },
  },
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
  'run-receipt-idempotency': {
    id: 'run-receipt-idempotency',
    description: 'Verify a prompt receives a durable runId and a same-key retry reuses the completed receipt without a second runtime turn.',
    async run(context) {
      return withEphemeralSession(context, async (sessionId) => {
        const idempotencyKey = `live-${context.runtime}-${Date.now()}`;
        const input = {
          message: 'Reply with the exact text RUN-RECEIPT-LIVE-OK and nothing else.',
          verbosity: 'answers' as const,
          mode: 'prompt' as const,
          idempotencyKey,
        };
        const first = await context.client.promptWithIdempotency(sessionId, input);
        const duplicate = await context.client.promptWithIdempotency(sessionId, input);
        const receipt = await context.client.getRunReceipt(first.runId);
        const firstContent = 'content' in first ? first.content : undefined;
        const expectedInstance = context.runtime === 'pi'
          ? 'pi-local-default'
          : context.runtime === 'opencode'
            ? 'opencode-default'
            : context.runtime === 'antigravity'
              ? 'antigravity-default'
              : undefined;
        const assertions: ValidationAssertion[] = [
          { name: 'run_id_returned', passed: typeof first.runId === 'string' && first.runId.length > 0, details: first.runId },
          { name: 'first_response_text', passed: firstContent?.includes('RUN-RECEIPT-LIVE-OK') === true, details: firstContent ?? '' },
          {
            name: 'duplicate_reused_run',
            passed: 'duplicate' in duplicate && duplicate.duplicate === true && duplicate.runId === first.runId,
            details: duplicate.runId,
          },
          { name: 'receipt_completed', passed: receipt.status === 'completed', details: receipt.status },
          {
            name: 'receipt_instance_identity',
            passed: expectedInstance ? receipt.executionInstanceId === expectedInstance : Boolean(receipt.executionInstanceId),
            details: receipt.executionInstanceId,
          },
        ];
        return {
          scenarioId: 'run-receipt-idempotency',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
          assertions,
        };
      });
    },
  },
  'phase7-pi-shadow': {
    id: 'phase7-pi-shadow',
    description: 'Verify the disposable Pi Internal API prompt path persists owner-only shadow classification without changing routing or claiming containment.',
    async run(context) {
      if (context.runtime !== 'pi') {
        return {
          scenarioId: 'phase7-pi-shadow',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'Phase 7 shadow scope is limited to Pi Internal API prompts',
          assertions: [],
        };
      }
      return withEphemeralSession(context, async (sessionId) => {
        const first = await context.client.promptWithIdempotency(sessionId, {
          message: 'Reply with the exact text PHASE7-SHADOW-LIVE-OK and nothing else.',
          verbosity: 'answers',
          mode: 'prompt',
          idempotencyKey: `phase7-shadow-${Date.now()}`,
        });
        const receipt = await context.client.getRunReceipt(first.runId);
        const evidence = context.client.getSessionEvidence
          ? await context.client.getSessionEvidence(sessionId, ['diagnostics', 'runs'])
          : undefined;
        const shadow = receipt.phase7Shadow;
        const evidenceShadow = evidence?.receiptSummary.latest?.phase7Shadow;
        const evidenceDiagnostic = evidence?.diagnostics.records.some((record) => (
          record.runId === first.runId
          && record.msg.includes('[Phase7Shadow]')
          && record.phase7PolicyVersion === 'phase7-pi-shadow/v1'
          && record.phase7AffinitySessionId === sessionId
          && record.phase7ResourceIdentity === 'shared-service'
        )) === true;
        const assertions: ValidationAssertion[] = [
          {
            name: 'receipt_completed',
            passed: receipt.status === 'completed',
            details: receipt.status,
          },
          {
            name: 'shadow_policy',
            passed: shadow?.policyVersion === 'phase7-pi-shadow/v1' && shadow.mode === 'shadow',
            details: shadow?.policyVersion ?? 'missing',
          },
          {
            name: 'evidence_bundle_persistence',
            passed: evidenceShadow?.policyVersion === 'phase7-pi-shadow/v1' && evidenceDiagnostic,
            details: evidenceDiagnostic ? 'receipt and diagnostic projection present' : 'missing evidence projection',
          },
          {
            name: 'server_profile',
            passed: shadow?.profile === 'standard' && shadow.reasonCodes.includes('default_standard'),
            details: shadow?.profile ?? 'missing',
          },
          {
            name: 'session_affinity',
            passed: shadow?.affinity.kind === 'session' && shadow.affinity.sessionId === sessionId && shadow.affinity.ownership === 'server-owned',
            details: shadow?.affinity.sessionId ?? 'missing',
          },
          {
            name: 'honest_shared_resource_identity',
            passed: shadow?.resourceIdentity.kind === 'shared-service'
              && shadow.resourceIdentity.boundary === 'pi-control-process'
              && shadow.resourceIdentity.sessionScoped === false,
            details: shadow?.resourceIdentity.kind ?? 'missing',
          },
          {
            name: 'prompt_body_omitted',
            passed: !JSON.stringify(receipt).includes('PHASE7-SHADOW-LIVE-OK'),
            details: 'receipt contains bounded metadata only',
          },
        ];
        return {
          scenarioId: 'phase7-pi-shadow',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
          runId: first.runId,
        };
      });
    },
  },
  'notify-on-agent-end': {
    id: 'notify-on-agent-end',
    description:
      'Opt a session into notifications, run a turn, and prove the NotificationManager captured agent_end (origin-independent, via the service observer) by observing a delivery record.',
    async run(context) {
      return withEphemeralSession(context, async (sessionId) => {
        // Opt in — attaches the service-level observer (the origin-independent hook).
        await context.client.optInNotifications(sessionId, 'notify-scenario');
        // Drive a turn to completion (agent_end).
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with the exact text LIVE-VALIDATION-OK and nothing else.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        // The manager must have produced an agent_end delivery for this session.
        const captured = await waitForNotificationDelivery(context.client, sessionId);
        const finalState = await context.client
          .getNotificationState(sessionId)
          .catch(() => ({ deliveries: [] as unknown[] }));
        const deliveries = (finalState.deliveries ?? []) as Array<{
          notification?: { kind?: string; sessionId?: string };
          delivery?: { status?: string };
        }>;
        const agentEnd = deliveries.find((d) => d.notification?.kind === 'agent_end');
        const assertions: ValidationAssertion[] = [
          {
            name: 'agent_end_emitted',
            passed: summary.sawAgentEnd,
            details: summary.sawAgentEnd ? 'agent_end seen' : 'agent_end missing',
          },
          {
            name: 'notification_captured',
            passed: captured,
            details: `${deliveries.length} delivery record(s); agent_end captured=${captured}`,
          },
          {
            name: 'notification_session_match',
            passed: agentEnd?.notification?.sessionId === sessionId,
            details: agentEnd?.notification?.sessionId ?? 'no agent_end delivery',
          },
        ];
        return {
          scenarioId: 'notify-on-agent-end',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
          assertions,
        };
      });
    },
  },

  'session-evidence': {
    id: 'session-evidence',
    description: 'Verify compact session evidence resolves by canonical id and registry path without exposing prompt bodies.',
    async run(context) {
      const getEvidence = context.client.getSessionEvidence;
      if (!getEvidence) {
        return {
          scenarioId: 'session-evidence',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'session-evidence requires an Internal API client with getSessionEvidence()',
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        const events = await context.client.promptStream(sessionId, {
          message: 'Reply with the exact text EVIDENCE-LIVE-OK and nothing else.',
          verbosity: 'full',
          mode: 'prompt',
        });
        const summary = collectValidationSummary(events);
        const byId = await getEvidence.call(context.client, sessionId);
        // The create response's sessionPath is runtime-specific (Claude and
        // OpenCode commonly return the internal id). Use the returned registry
        // path from evidence itself for the cross-runtime alias assertion.
        const byPath = await getEvidence.call(context.client, byId.aliases.path);
        const serialized = JSON.stringify(byId);
        const assertions: ValidationAssertion[] = [
          {
            name: 'agent_end',
            passed: summary.sawAgentEnd,
            details: summary.sawAgentEnd ? 'agent_end seen' : 'agent_end missing',
          },
          {
            name: 'canonical_id',
            passed: byId.sessionId === sessionId && byPath.sessionId === sessionId,
            details: `id=${byId.sessionId}; path=${byPath.sessionId}`,
          },
          {
            name: 'path_alias',
            passed: byPath.sessionId === sessionId && byPath.aliases.path === byId.aliases.path,
            details: byId.aliases.path,
          },
          {
            name: 'process_local_label',
            passed: byId.diagnostics.processLocal === true,
            details: String(byId.diagnostics.processLocal),
          },
          {
            name: 'retention_liveness_separated',
            passed: Number.isInteger(byId.retention.durableLeaseCount)
              && Number.isInteger(byId.retention.residentLeaseCount),
            details: `durable=${byId.retention.durableLeaseCount} resident=${byId.retention.residentLeaseCount}`,
          },
          {
            name: 'residency_bounded',
            passed: ['materialized', 'not_materialized', 'unknown'].includes(byId.residency.state),
            details: byId.residency.state,
          },
          {
            name: 'run_liveness_evidence',
            passed: byId.runChronology.some((receipt) =>
              receipt.liveness?.activityPolicyVersion === 'run-activity-v1'
              && receipt.liveness.cessation !== undefined),
            details: `runs=${byId.runChronology.length}`,
          },
          {
            name: 'default_bundle_bounded',
            passed: Buffer.byteLength(serialized) < 5_000,
            details: `${Buffer.byteLength(serialized)} bytes`,
          },
          {
            name: 'prompt_body_omitted',
            passed: !Object.hasOwn(byId, 'firstMessage') && !Object.hasOwn(byId, 'items'),
            details: 'default evidence omits firstMessage and transcript items',
          },
        ];
        return {
          scenarioId: 'session-evidence',
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
  'claude-ask-user-question': {
    id: 'claude-ask-user-question',
    description:
      'Verify the Claude SDK AskUserQuestion round trip: Claude emits ask_user_question_request, the Internal API answers it with structured answers, and Claude continues using the selected answers.',
    async run(context) {
      if (context.runtime !== 'claude') {
        return {
          scenarioId: 'claude-ask-user-question',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'claude-ask-user-question only applies to the claude runtime',
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        const prompt = [
          'Integration validation only. Use the AskUserQuestion tool exactly once to ask the user three questions in a single call:',
          '1) Pick a colour: options Red, Blue.',
          '2) Pick a size: options Small, Large.',
          '3) Pick features (set multiSelect true): options Search, Attachments, Export.',
          'After you receive the answers, reply with EXACTLY one line and nothing else, in this format:',
          'ASK_VALIDATION_RESULT colour=<colour answer>; size=<size answer>; features=<features answer>',
          'Echo the answer values verbatim. Do not use any other tools.',
        ].join('\n');

        const askRequests: Array<{ data: { requestId?: string; questions?: unknown[] } }> = [];
        const events = await context.client.promptStreamLive(
          sessionId,
          { message: prompt, verbosity: 'full', mode: 'prompt' },
          async (evt) => {
            if (evt.type === 'ask_user_question_request') {
              const data = evt.data as { requestId?: string; questions?: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string }> }> };
              askRequests.push({ data });
              const answers = buildAskUserAnswers(data.questions ?? []);
              try {
                await context.client.respondToApproval(sessionId, data.requestId ?? '', {
                  approved: true,
                  answers,
                });
              } catch {
                /* surfaced via assertions below */
              }
            }
          },
        );

        const summary = collectValidationSummary(events);
        const allQuestions = askRequests.flatMap((r) => (r.data.questions ?? []) as Array<{ multiSelect: boolean; question: string }>);
        const hasMulti = allQuestions.some((q) => q.multiSelect === true);
        const text = summary.assistantText;
        const tail = text.slice(-240);

        const assertions: ValidationAssertion[] = [
          {
            name: 'ask_user_question_request_emitted',
            passed: askRequests.length > 0,
            details: askRequests.length > 0 ? `requestId=${askRequests[0].data.requestId}` : 'no ask_user_question_request seen (model may have answered in plain text)',
          },
          {
            name: 'three_questions',
            passed: allQuestions.length === 3,
            details: `total questions across ${askRequests.length} request(s) = ${allQuestions.length}`,
          },
          {
            name: 'multiselect_present',
            passed: hasMulti,
            details: `multiselect question present=${hasMulti}`,
          },
          { name: 'agent_end', passed: summary.sawAgentEnd, details: summary.sawAgentEnd ? 'agent_end seen' : 'agent_end missing' },
          { name: 'result_line', passed: /ASK_VALIDATION_RESULT/i.test(text), details: tail },
          { name: 'colour_blue', passed: /colour\s*=\s*Blue/i.test(text), details: tail },
          { name: 'size_large', passed: /size\s*=\s*Large/i.test(text), details: tail },
          { name: 'features_search_export', passed: /features?\s*=\s*Search,?\s*Export/i.test(text), details: tail },
        ];

        return {
          scenarioId: 'claude-ask-user-question',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
          assertions,
        };
      });
    },
  },
  'claude-ask-user-question-cancel': {
    id: 'claude-ask-user-question-cancel',
    description:
      'Verify a CANCELLED AskUserQuestion is graceful: the Internal API answers with cancelled:true and the Claude turn still completes (agent_end) instead of hanging.',
    async run(context) {
      if (context.runtime !== 'claude') {
        return {
          scenarioId: 'claude-ask-user-question-cancel',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'claude-ask-user-question-cancel only applies to the claude runtime',
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        const prompt = [
          'Integration validation only. Use the AskUserQuestion tool exactly once to ask one question: "Pick a colour?" with options Red, Blue.',
          'After you receive the tool result, reply with EXACTLY one line and nothing else:',
          'ASK_CANCEL_RESULT status=<received|not_received>',
          'Use status=not_received if the tool result says the user did not answer; otherwise status=received.',
          'Do not use any other tools.',
        ].join('\n');

        let cancelledRequestId: string | null = null;
        const events = await context.client.promptStreamLive(
          sessionId,
          { message: prompt, verbosity: 'full', mode: 'prompt' },
          async (evt) => {
            if (evt.type === 'ask_user_question_request' && cancelledRequestId === null) {
              const data = evt.data as { requestId?: string };
              cancelledRequestId = data.requestId ?? null;
              try {
                await context.client.respondToApproval(sessionId, data.requestId ?? '', {
                  approved: true,
                  cancelled: true,
                });
              } catch {
                /* surfaced via assertions */
              }
            }
          },
        );

        const summary = collectValidationSummary(events);
        const text = summary.assistantText;
        const tail = text.slice(-200);

        const assertions: ValidationAssertion[] = [
          {
            name: 'ask_user_question_request_emitted',
            passed: cancelledRequestId !== null,
            details: cancelledRequestId ?? 'no ask_user_question_request seen',
          },
          {
            name: 'agent_end_after_cancel',
            passed: summary.sawAgentEnd,
            details: summary.sawAgentEnd ? 'agent_end seen — cancel did not hang the session' : 'agent_end missing (session may have hung)',
          },
          { name: 'result_line', passed: /ASK_CANCEL_RESULT/i.test(text), details: tail },
          {
            name: 'model_saw_no_answer',
            passed: /not_received/i.test(text),
            details: tail,
          },
        ];

        return {
          scenarioId: 'claude-ask-user-question-cancel',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
          assertions,
        };
      });
    },
  },
  'claude-ask-user-question-timeout': {
    id: 'claude-ask-user-question-timeout',
    description:
      'Verify an UNANSWERED AskUserQuestion times out gracefully: the server-side ask-user timeout resolves it and the Claude turn still completes (agent_end) instead of hanging. Requires the validation server to be booted with a short CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS.',
    async run(context) {
      if (context.runtime !== 'claude') {
        return {
          scenarioId: 'claude-ask-user-question-timeout',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'claude-ask-user-question-timeout only applies to the claude runtime',
          assertions: [],
        };
      }

      const configuredTimeoutMs = Number.parseInt(process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS ?? '', 10);
      if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0 || configuredTimeoutMs > 30_000) {
        return {
          scenarioId: 'claude-ask-user-question-timeout',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'claude-ask-user-question-timeout requires CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS to be set to 1..30000 on the validation server',
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        const prompt = [
          'Integration validation only. Use the AskUserQuestion tool exactly once to ask one question: "Pick a colour?" with options Red, Blue.',
          'If the tool result says the user did not answer, reply with EXACTLY one line and nothing else: ASK_TIMEOUT_RESULT timed_out',
          'Do not use any other tools.',
        ].join('\n');

        let askRequestId: string | null = null;
        // Intentionally do NOT respond: the server-side ask-user timeout must fire.
        const events = await context.client.promptStreamLive(
          sessionId,
          { message: prompt, verbosity: 'full', mode: 'prompt' },
          async (evt) => {
            if (evt.type === 'ask_user_question_request') {
              const data = evt.data as { requestId?: string };
              askRequestId = data.requestId ?? null;
            }
          },
        );

        // After the turn (the server-side timeout resolved the unanswered
        // question), submit a LATE answer and assert it is clearly rejected
        // rather than silently accepted (D3).
        let lateAnswerRejected = false;
        let lateAnswerDetail = 'late answer was accepted (expected a clear rejection)';
        if (askRequestId) {
          try {
            await context.client.respondToApproval(sessionId, askRequestId, {
              approved: true,
              answers: { 'Pick a colour?': 'Blue' },
            });
          } catch (e) {
            lateAnswerRejected = true;
            lateAnswerDetail = e instanceof Error ? e.message : String(e);
          }
        } else {
          lateAnswerDetail = 'no ask_user_question_request seen — late answer not attempted';
        }

        const summary = collectValidationSummary(events);
        const text = summary.assistantText;
        const closedEvents = events.filter((e) => e.type === 'ask_user_question_closed');
        const timeoutClose = closedEvents.find((e) => (e.data as { reason?: string } | null)?.reason === 'timeout');

        const assertions: ValidationAssertion[] = [
          {
            name: 'ask_user_question_request_emitted',
            passed: askRequestId !== null,
            details: askRequestId ?? 'no ask_user_question_request seen',
          },
          {
            name: 'ask_user_question_closed_emitted',
            passed: !!timeoutClose,
            details: timeoutClose
              ? 'ask_user_question_closed(reason=timeout) seen'
              : `no ask_user_question_closed(timeout) seen (${closedEvents.length} close event(s))`,
          },
          {
            name: 'agent_end_after_timeout',
            passed: summary.sawAgentEnd,
            details: summary.sawAgentEnd ? 'agent_end seen — timeout did not hang the session' : 'agent_end missing (session hung past the ask-user timeout)',
          },
          { name: 'model_saw_timeout', passed: /ASK_TIMEOUT_RESULT/i.test(text), details: text.slice(-200) },
          {
            name: 'late_answer_rejected',
            passed: lateAnswerRejected && /ASK_ALREADY_CLOSED|already closed|409/i.test(lateAnswerDetail),
            details: lateAnswerDetail,
          },
        ];

        return {
          scenarioId: 'claude-ask-user-question-timeout',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
          assertions,
        };
      });
    },
  },
  'claude-ask-user-question-delayed-answer': {
    id: 'claude-ask-user-question-delayed-answer',
    description:
      'Verify a DELAYED answer to an AskUserQuestion is accepted (no premature expiry within the window): the answer reaches Claude, NO ask_user_question_closed fires, and the final transcript reflects the answers.',
    async run(context) {
      if (context.runtime !== 'claude') {
        return {
          scenarioId: 'claude-ask-user-question-delayed-answer',
          runtime: context.runtime,
          passed: true,
          skipped: true,
          reason: 'claude-ask-user-question-delayed-answer only applies to the claude runtime',
          assertions: [],
        };
      }

      return withEphemeralSession(context, async (sessionId) => {
        const prompt = [
          'Integration validation only. Use the AskUserQuestion tool exactly once to ask the user three questions in a single call:',
          '1) Pick a colour: options Red, Blue.',
          '2) Pick a size: options Small, Large.',
          '3) Pick features (set multiSelect true): options Search, Attachments, Export.',
          'After you receive the answers, reply with EXACTLY one line and nothing else, in this format:',
          'ASK_VALIDATION_RESULT colour=<colour answer>; size=<size answer>; features=<features answer>',
          'Echo the answer values verbatim. Do not use any other tools.',
        ].join('\n');

        const askRequests: Array<{ data: { requestId?: string; questions?: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string }> }> } }> = [];
        const closedSeen: NormalizedEvent[] = [];
        const delayMs = readDelayedAnswerDelayMs();
        const events = await context.client.promptStreamLive(
          sessionId,
          { message: prompt, verbosity: 'full', mode: 'prompt' },
          async (evt) => {
            if (evt.type === 'ask_user_question_request') {
              const data = evt.data as { requestId?: string; questions?: Array<{ question: string; header: string; multiSelect: boolean; options: Array<{ label: string }> }> };
              askRequests.push({ data });
              const answers = buildAskUserAnswers(data.questions ?? []);
              // Delay the answer to prove the dialog does not prematurely expire
              // within a realistic window (the safety-net timeout is far longer).
              await new Promise((r) => setTimeout(r, delayMs));
              try {
                await context.client.respondToApproval(sessionId, data.requestId ?? '', {
                  approved: true,
                  answers,
                });
              } catch {
                /* surfaced via assertions below */
              }
            }
            if (evt.type === 'ask_user_question_closed') {
              closedSeen.push(evt);
            }
          },
        );

        const summary = collectValidationSummary(events);
        const allQuestions = askRequests.flatMap((r) => r.data.questions ?? []);
        const hasMulti = allQuestions.some((q) => q.multiSelect === true);
        const text = summary.assistantText;
        const tail = text.slice(-240);

        const assertions: ValidationAssertion[] = [
          {
            name: 'ask_user_question_request_emitted',
            passed: askRequests.length > 0,
            details: askRequests.length > 0 ? `requestId=${askRequests[0].data.requestId}` : 'no ask_user_question_request seen',
          },
          {
            name: 'no_premature_close',
            passed: closedSeen.length === 0,
            details: closedSeen.length === 0
              ? 'no ask_user_question_closed fired before the delayed answer landed'
              : `${closedSeen.length} ask_user_question_closed event(s) fired prematurely`,
          },
          {
            name: 'three_questions',
            passed: allQuestions.length === 3,
            details: `total questions across ${askRequests.length} request(s) = ${allQuestions.length}`,
          },
          { name: 'multiselect_present', passed: hasMulti, details: `multiselect question present=${hasMulti}` },
          { name: 'agent_end', passed: summary.sawAgentEnd, details: summary.sawAgentEnd ? 'agent_end seen' : 'agent_end missing' },
          { name: 'result_line', passed: /ASK_VALIDATION_RESULT/i.test(text), details: tail },
          { name: 'colour_blue', passed: /colour\s*=\s*Blue/i.test(text), details: tail },
          { name: 'size_large', passed: /size\s*=\s*Large/i.test(text), details: tail },
          { name: 'features_search_export', passed: /features?\s*=\s*Search,?\s*Export/i.test(text), details: tail },
        ];

        return {
          scenarioId: 'claude-ask-user-question-delayed-answer',
          runtime: context.runtime,
          passed: assertions.every((a) => a.passed),
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
          // AND reasoning_effort:"high" — the graduated depth control.
          const cfgHigh = readConfig();
          const highThinking = findThinkingOption(cfgHigh);
          assertions.push({
            name: 'config_written_enabled',
            passed: highThinking?.type === 'enabled',
            details: `thinking=${JSON.stringify(highThinking)} (expected type=enabled)`,
          });
          const highEffort = findReasoningEffort(cfgHigh);
          assertions.push({
            name: 'config_reasoning_effort_high',
            passed: highEffort === 'high',
            details: `reasoning_effort=${JSON.stringify(highEffort)} (expected "high")`,
          });

          // Intermediate level: 'low' must write reasoning_effort:"low", proving
          // the control is graduated rather than collapsed to a binary on/off.
          try {
            await context.client.controlSession(sessionId, { action: 'set_thinking_level', level: 'low' });
          } catch {
            // surfaced by the assertion below if the config didn't update
          }
          const lowEffort = findReasoningEffort(readConfig());
          assertions.push({
            name: 'config_reasoning_effort_low',
            passed: lowEffort === 'low',
            details: `reasoning_effort=${JSON.stringify(lowEffort)} (expected "low")`,
          });

          // UI ceiling 'xhigh' must map to the API ceiling 'max'.
          try {
            await context.client.controlSession(sessionId, { action: 'set_thinking_level', level: 'xhigh' });
          } catch {
            // surfaced by the assertion below
          }
          const maxEffort = findReasoningEffort(readConfig());
          assertions.push({
            name: 'config_reasoning_effort_xhigh_maps_max',
            passed: maxEffort === 'max',
            details: `reasoning_effort=${JSON.stringify(maxEffort)} (expected "max")`,
          });

          // Reset to off — should disable thinking and clear reasoning_effort
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
          const offEffort = findReasoningEffort(cfgOff);
          assertions.push({
            name: 'config_reasoning_effort_cleared_on_off',
            passed: offEffort === null,
            details: `reasoning_effort after off=${JSON.stringify(offEffort)} (expected none)`,
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
        const evidence = context.client.getLastPromptEvidence?.(sessionId);
        const assertions = [
          ...buildAssertions(summary, 'SECOND-VALIDATION-TURN'),
          {
            name: 'dispatch_mode_promoted',
            passed: evidence?.dispatchMode === 'prompt',
            details: `dispatchMode=${evidence?.dispatchMode ?? 'missing'} (expected prompt)`,
          },
        ];
        return {
          scenarioId: 'follow-up',
          runtime: context.runtime,
          passed: assertions.every((assertion) => assertion.passed),
          assertions,
        };
      });
    },
  },
  'follow-up-strict': {
    id: 'follow-up-strict',
    description: 'Verify strict follow-up rejects an idle session instead of promoting it.',
    async run(context) {
      return withEphemeralSession(context, async (sessionId) => {
        let code: string | undefined;
        try {
          await context.client.promptWithIdempotency(sessionId, {
            message: 'This strict idle follow-up must not run.',
            verbosity: 'answers',
            mode: 'follow_up',
            requireActiveTurn: true,
          });
        } catch (error) {
          code = requestErrorCode(error);
        }
        const assertions = [{
          name: 'idle_strict_follow_up_rejected',
          passed: code === 'SESSION_NOT_STREAMING',
          details: `code=${code ?? 'missing'} (expected SESSION_NOT_STREAMING)`,
        }];
        return { scenarioId: 'follow-up-strict', runtime: context.runtime, passed: assertions.every((a) => a.passed), assertions };
      });
    },
  },
  'prompt-mode-busy': {
    id: 'prompt-mode-busy',
    description: 'Verify Claude refuses follow_up while a question-blocked turn is running and creates no receipt.',
    async run(context) {
      if (context.runtime !== 'claude') return skippedScenario('prompt-mode-busy', context.runtime, 'prompt-mode-busy only applies to Claude');
      return withEphemeralSession(context, async (sessionId) => {
        let resolveQuestion!: (value: { requestId: string }) => void;
        const question = new Promise<{ requestId: string }>((resolve) => { resolveQuestion = resolve; });
        const stream = context.client.promptStreamLive(sessionId, {
          message: 'Use AskUserQuestion exactly once to ask "Continue?" with options Yes and No. Then finish briefly.',
          verbosity: 'full',
          mode: 'prompt',
        }, (event) => {
          if (event.type === 'ask_user_question_request') {
            const data = event.data as { requestId?: string };
            if (data.requestId) resolveQuestion({ requestId: data.requestId });
          }
        });
        const pending = await withTimeout(question, context.timeoutMs ?? 60_000, 'Claude did not ask a question');
        const before = await context.client.getSessionEvidence?.(sessionId, ['runs']);
        let code: string | undefined;
        try {
          await context.client.promptWithIdempotency(sessionId, {
            message: 'This must be rejected while busy.',
            verbosity: 'answers',
            mode: 'follow_up',
            detach: true,
          });
        } catch (error) {
          code = requestErrorCode(error);
        } finally {
          await context.client.respondToApproval(sessionId, pending.requestId, { approved: true, cancelled: true }).catch(() => undefined);
        }
        await stream;
        const after = await context.client.getSessionEvidence?.(sessionId, ['runs']);
        const assertions = [
          { name: 'busy_follow_up_rejected', passed: code === 'SESSION_BUSY', details: `code=${code ?? 'missing'}` },
          {
            name: 'no_receipt_created',
            passed: before?.receiptSummary.count === after?.receiptSummary.count,
            details: `before=${before?.receiptSummary.count ?? 'missing'} after=${after?.receiptSummary.count ?? 'missing'}`,
          },
        ];
        return { scenarioId: 'prompt-mode-busy', runtime: context.runtime, passed: assertions.every((a) => a.passed), assertions };
      });
    },
  },
  'approval-wrong-id': {
    id: 'approval-wrong-id',
    description: 'Verify an unknown approval id returns 404 and leaves the live question pending.',
    async run(context) {
      if (context.runtime !== 'claude') return skippedScenario('approval-wrong-id', context.runtime, 'approval-wrong-id only applies to Claude');
      return withEphemeralSession(context, async (sessionId) => {
        let wrongCode: string | undefined;
        let remainedPending = false;
        let requestId = '';
        let interaction: Promise<void> | undefined;
        const events = await context.client.promptStreamLive(sessionId, {
          message: 'Use AskUserQuestion exactly once to ask "Pick one?" with options Alpha and Beta. After the answer reply APPROVAL-WRONG-ID-RESUMED.',
          verbosity: 'full',
          mode: 'prompt',
        }, (event) => {
          if (event.type !== 'ask_user_question_request' || interaction) return;
          const data = event.data as { requestId?: string; questions?: Array<{ question: string }> };
          requestId = data.requestId ?? '';
          interaction = (async () => {
            try {
              await context.client.respondToApproval(sessionId, 'unknown-request-id', { approved: true, answers: {} });
            } catch (error) {
              wrongCode = requestErrorCode(error);
            }
            const pending = await context.client.getPendingApprovals?.(sessionId);
            remainedPending = pending?.approvals.some((approval) => approval.requestId === requestId) ?? false;
            const questionText = data.questions?.[0]?.question ?? 'Pick one?';
            await context.client.respondToApproval(sessionId, requestId, { approved: true, answers: { [questionText]: 'Alpha' } });
          })();
        });
        await interaction;
        const summary = collectValidationSummary(events);
        const assertions = [
          { name: 'wrong_id_404', passed: wrongCode === 'APPROVAL_REQUEST_NOT_FOUND', details: `code=${wrongCode ?? 'missing'}` },
          { name: 'question_remained_pending', passed: remainedPending, details: `requestId=${requestId || 'missing'}` },
          { name: 'assistant_resumed', passed: summary.assistantText.includes('APPROVAL-WRONG-ID-RESUMED'), details: summary.assistantText.slice(-200) },
        ];
        return { scenarioId: 'approval-wrong-id', runtime: context.runtime, passed: assertions.every((a) => a.passed), assertions };
      });
    },
  },
  'approval-by-toolcall-id': {
    id: 'approval-by-toolcall-id',
    description: 'Verify toolCallId aliases resolve an AskUserQuestion and the assistant resumes.',
    async run(context) {
      if (context.runtime !== 'claude') return skippedScenario('approval-by-toolcall-id', context.runtime, 'approval-by-toolcall-id only applies to Claude');
      return withEphemeralSession(context, async (sessionId) => {
        let resolved = false;
        let toolCallId = '';
        let interaction: Promise<void> | undefined;
        const events = await context.client.promptStreamLive(sessionId, {
          message: 'Use AskUserQuestion exactly once to ask "Pick one?" with options Alpha and Beta. After the answer reply APPROVAL-TOOLCALL-RESUMED.',
          verbosity: 'full',
          mode: 'prompt',
        }, (event) => {
          if (event.type !== 'ask_user_question_request' || interaction) return;
          const data = event.data as { toolCallId?: string; questions?: Array<{ question: string }> };
          toolCallId = data.toolCallId ?? '';
          interaction = (async () => {
            const questionText = data.questions?.[0]?.question ?? 'Pick one?';
            const result = await context.client.respondToApproval(sessionId, toolCallId, {
              approved: true,
              answers: { [questionText]: 'Beta' },
            }) as { resolved?: boolean };
            resolved = result.resolved === true;
          })();
        });
        await interaction;
        const summary = collectValidationSummary(events);
        const assertions = [
          { name: 'tool_call_id_present', passed: toolCallId.length > 0, details: toolCallId || 'missing' },
          { name: 'sdk_resolved', passed: resolved, details: `resolved=${resolved}` },
          { name: 'assistant_resumed', passed: summary.assistantText.includes('APPROVAL-TOOLCALL-RESUMED'), details: summary.assistantText.slice(-200) },
        ];
        return { scenarioId: 'approval-by-toolcall-id', runtime: context.runtime, passed: assertions.every((a) => a.passed), assertions };
      });
    },
  },
  'stalled-run-reaped': {
    id: 'stalled-run-reaped',
    description: 'Verify an admitted Pi turn that stops emitting events is reaped and releases capacity.',
    async run(context) {
      if (context.runtime !== 'pi') return skippedScenario('stalled-run-reaped', context.runtime, 'stalled-run-reaped only applies to Pi');
      const timeout = Number.parseInt(process.env.INTERNAL_API_TURN_IDLE_TIMEOUT_MS ?? '', 10);
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30_000) {
        return skippedScenario('stalled-run-reaped', context.runtime, 'requires INTERNAL_API_TURN_IDLE_TIMEOUT_MS <= 30000 on the disposable server and validator');
      }
      return withEphemeralSession(context, async (sessionId) => {
        const stalled = await context.client.promptWithIdempotency(sessionId, {
          message: `Use the bash tool exactly once to run sleep ${Math.max(5, Math.ceil(timeout / 1000) + 3)}, then reply STALL-SHOULD-HAVE-BEEN-REAPED.`,
          verbosity: 'answers',
          mode: 'prompt',
          detach: true,
        });
        const runId = stalled.runId;
        const deadline = Date.now() + Math.max(timeout * 4, 10_000);
        let receipt = await context.client.getRunReceipt(runId);
        while (!receipt.terminalAt && Date.now() < deadline) {
          await sleep(200);
          receipt = await context.client.getRunReceipt(runId);
        }
        const capacity = await context.client.getCapacity?.();
        const assertions = [
          { name: 'admitted_prompt_dispatch', passed: receipt.dispatchMode === 'prompt', details: `dispatchMode=${receipt.dispatchMode ?? 'missing'}` },
          { name: 'turn_stalled_terminal', passed: receipt.status === 'failed' && receipt.errorCode === 'TURN_STALLED', details: `status=${receipt.status} code=${receipt.errorCode ?? 'missing'}` },
          { name: 'idle_watchdog_evidence', passed: receipt.liveness?.watchdog?.reason === 'idle', details: `reason=${receipt.liveness?.watchdog?.reason ?? 'missing'}` },
          {
            name: 'cessation_not_overclaimed',
            passed: receipt.liveness?.cessation?.state === 'unknown' && receipt.liveness.cessation.basis === 'watchdog',
            details: `state=${receipt.liveness?.cessation?.state ?? 'missing'} basis=${receipt.liveness?.cessation?.basis ?? 'missing'}`,
          },
          { name: 'capacity_released', passed: capacity?.activeTurns === 0, details: `activeTurns=${capacity?.activeTurns ?? 'missing'}` },
        ];
        return { scenarioId: 'stalled-run-reaped', runtime: context.runtime, passed: assertions.every((a) => a.passed), assertions, runId };
      });
    },
  },
};

function requestErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function skippedScenario(scenarioId: string, runtime: ValidationRuntime, reason: string): ValidationScenarioResult {
  return { scenarioId, runtime, passed: true, skipped: true, reason, assertions: [] };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCleanupWarnings(error: unknown): string[] {
  if (!error || typeof error !== 'object' || !('cleanupWarnings' in error)) return [];
  const warnings = (error as { cleanupWarnings?: unknown }).cleanupWarnings;
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 20)
    : [];
}

function safeFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;&]+/gi, '[REDACTED]')
    .replace(/([?&](?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, 500) || 'validation failed';
}

export async function runScenario(context: ValidationContext & { scenario: ValidationScenario }): Promise<ValidationScenarioResult> {
  const maxAttempts = 2;
  const overallStarted = Date.now();
  const startedAt = new Date(overallStarted).toISOString();
  const attemptHistory: NonNullable<ValidationScenarioResult['attemptHistory']> = [];
  const cleanupWarnings: string[] = [];
  let lastResult: ValidationScenarioResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStarted = Date.now();
    let result: ValidationScenarioResult;
    try {
      result = await context.scenario.run(context);
    } catch (error) {
      const failure = { name: error instanceof Error ? error.name : typeof error, message: safeFailureMessage(error) };
      result = {
        scenarioId: context.scenario.id,
        runtime: context.runtime,
        passed: false,
        reason: failure.message,
        failure,
        assertions: [{ name: 'scenario_execution', passed: false, details: failure.message }],
        cleanupWarnings: readCleanupWarnings(error),
      };
    }
    const attemptDuration = Math.max(0, Date.now() - attemptStarted);
    for (const warning of result.cleanupWarnings ?? []) {
      if (!cleanupWarnings.includes(warning)) cleanupWarnings.push(warning);
    }
    result.attempt = attempt;
    attemptHistory.push({
      attempt,
      passed: result.passed,
      skipped: result.skipped,
      durationMs: attemptDuration,
      reason: result.reason,
    });
    lastResult = result;

    if (result.passed || result.skipped || attempt === maxAttempts) {
      const completed = Date.now();
      return {
        ...result,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: Math.max(0, completed - overallStarted),
        attemptHistory,
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      };
    }

    await sleep(1500);
  }

  const completed = Date.now();
  return {
    ...(lastResult ?? {
      scenarioId: context.scenario.id,
      runtime: context.runtime,
      passed: false,
      assertions: [{ name: 'runner', passed: false, details: 'Scenario did not produce a result' }],
      attempt: maxAttempts,
    }),
    startedAt,
    completedAt: new Date(completed).toISOString(),
    durationMs: Math.max(0, completed - overallStarted),
    attemptHistory,
  };
}

export function listScenarioIds(): string[] {
  return Object.keys(scenarioRegistry);
}

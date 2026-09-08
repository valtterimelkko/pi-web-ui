import { z } from 'zod';

/**
 * Wire schemas for the agy 1.1.27 headless JSON surface, live-validated
 * 2026-09-08 (see docs/plans/ANTIGRAVITY-JSON-STREAM-INTEGRATION-PLAN.md §3
 * and the pi-enhancement research capture it references).
 *
 * Design rules:
 * - **Lenient where the wire evolves**: unknown `step_type` values, unknown
 *   top-level event names, and extra fields must parse — agy added
 *   `system_message` and `unknown` steps without doc updates, and the
 *   headless guide explicitly reserves event names for forward-compat.
 * - **Strict where the wire is stable**: the result envelope's `usage` block
 *   is always present (zeroed on failure) — its absence signals schema drift
 *   and must be surfaced as an invalid line, not silently accepted.
 *
 * `parseAgyLine` never throws: the stdout line reader feeds it every line and
 * must survive garbage. Callers branch on the `kind` discriminant.
 */

export const AgyUsageSchema = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    thinking_tokens: z.number(),
    cache_read_tokens: z.number(),
    total_tokens: z.number(),
  })
  .passthrough();
export type AgyUsage = z.infer<typeof AgyUsageSchema>;

export const AgyToolErrorSchema = z
  .object({
    type: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const AgyToolInfoSchema = z
  .object({
    name: z.string(),
    parameters: z.unknown().optional(),
    output: z.string().optional(),
    error: AgyToolErrorSchema.optional(),
  })
  .passthrough();
export type AgyToolInfo = z.infer<typeof AgyToolInfoSchema>;

/**
 * Terminal run status. Documented values: SUCCESS, ERROR, CANCELED,
 * INTERRUPTED, INVALID, WAITING, RUNNING. Kept as a plain string with a
 * documented-values union so unseen statuses still typecheck.
 */
export type AgyStatus = 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED' | 'INVALID' | 'WAITING' | 'RUNNING' | (string & {});

export const AgyEnvelopeSchema = z
  .object({
    conversation_id: z.string(),
    status: z.string(),
    response: z.string(),
    error: z.string().optional(),
    duration_seconds: z.number(),
    num_turns: z.number(),
    structured_output: z.unknown().optional(),
    json_schema: z.unknown().optional(),
    usage: AgyUsageSchema,
  })
  .passthrough();
export type AgyEnvelope = z.infer<typeof AgyEnvelopeSchema> & { status: AgyStatus };

export const AgyStepUpdateSchema = z
  .object({
    conversation_id: z.string(),
    step_index: z.number(),
    state: z.string(),
    step_type: z.string(),
    tool_name: z.string().optional(),
    text_delta: z.string().optional(),
    duration_seconds: z.number().optional(),
    usage: AgyUsageSchema.optional(),
    tool_info: AgyToolInfoSchema.optional(),
    subagent_info: z.unknown().optional(),
  })
  .passthrough();
export type AgyStepUpdate = z.infer<typeof AgyStepUpdateSchema>;

export const AgyInitSchema = z
  .object({
    cwd: z.string(),
    tools: z.array(z.string()),
    permission_mode: z.string(),
    model: z.string().optional(),
    agent: z.string().optional(),
    json_schema: z.unknown().optional(),
  })
  .passthrough();
export type AgyInit = z.infer<typeof AgyInitSchema>;

/** Discriminated parse result for one stdout NDJSON line. */
export type ParsedAgyLine =
  | { kind: 'init'; conversationId: string; init: AgyInit }
  | { kind: 'step'; step: AgyStepUpdate }
  | { kind: 'result'; conversationId: string; result: AgyEnvelope }
  | { kind: 'unknown'; event: string }
  | { kind: 'invalid'; reason: string };

function safeJsonParse(line: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'json parse failed' };
  }
}

/**
 * Parse one NDJSON line from the agy stdout stream. Returns a discriminant
 * result instead of throwing so a stream reader can log-and-continue on
 * garbage while still routing real events.
 */
export function parseAgyLine(line: string): ParsedAgyLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'invalid', reason: 'empty line' };

  const json = safeJsonParse(trimmed);
  if (!json.ok) return { kind: 'invalid', reason: json.reason };
  if (typeof json.value !== 'object' || json.value === null || Array.isArray(json.value)) {
    return { kind: 'invalid', reason: 'line is not a JSON object' };
  }

  const record = json.value as Record<string, unknown>;
  const event = record.event;

  if (event === 'init') {
    const conversationId = typeof record.conversation_id === 'string' ? record.conversation_id : undefined;
    const init = AgyInitSchema.safeParse(record.init);
    if (!conversationId || !init.success) {
      return { kind: 'invalid', reason: 'init event missing conversation_id or valid init payload' };
    }
    return { kind: 'init', conversationId, init: init.data };
  }

  if (event === 'step_update') {
    const step = AgyStepUpdateSchema.safeParse(record.step_update);
    if (!step.success) return { kind: 'invalid', reason: 'step_update payload failed schema' };
    return { kind: 'step', step: step.data };
  }

  if (event === 'result') {
    const result = AgyEnvelopeSchema.safeParse(record.result);
    if (!result.success) return { kind: 'invalid', reason: 'result payload failed schema' };
    return {
      kind: 'result',
      conversationId: result.data.conversation_id,
      result: result.data as AgyEnvelope,
    };
  }

  return { kind: 'unknown', event: typeof event === 'string' ? event : '<missing>' };
}

/**
 * T0.1 capability probe: does this agy binary support the stream-json
 * headless modes? Checks `agy --help` output for both flags (stream input
 * requires stream output; both appeared together in 1.1.x). Injected-text
 * pure function — the caller owns the spawn.
 */
export function helpTextSupportsStream(helpText: string): boolean {
  return helpText.includes('--output-format') && helpText.includes('--input-format');
}

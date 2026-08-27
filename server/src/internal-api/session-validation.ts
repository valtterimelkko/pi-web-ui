/**
 * Internal API: strict request-body validation + bounded concurrency for the
 * session/batch endpoints.
 *
 * These Zod schemas are the single source of truth for the shape of
 * create-session, batch-create, and batch-prompt bodies. They enforce:
 *   - `runtime` is exactly one of the five supported runtimes (no silent
 *     fallback to Pi for an unknown runtime);
 *   - non-empty, bounded arrays (≤ MAX_BATCH_ITEMS);
 *   - bounded string lengths and per-entry shapes;
 *   - valid thinking levels and numeric TTLs.
 *
 * Parsing happens BEFORE any session is created or prompt dispatched, so a
 * structurally invalid batch is rejected atomically (a valid item inside it does
 * not run).
 */

import { z } from 'zod';
import { THINKING_LEVELS, isThinkingLevel } from './types.js';
import { COMMAND_CODE_EFFORT_LEVELS } from '../command-code/command-code-model-catalog.js';

export const MAX_BATCH_ITEMS = 50;

/**
 * Conservative in-process concurrency ceiling for batch fan-out. Matches the
 * most constrained runtime (Pi `maxSessions` = 4) so a batch cannot overrun
 * runtime capacity. Single-item requests are unaffected (1 ≤ limit).
 */
export const BATCH_CONCURRENCY_LIMIT = 4;

export const sessionRuntimeSchema = z.enum(['pi', 'claude', 'opencode', 'antigravity', 'commandcode']);

const cwdSchema = z.string().min(1).max(4096);
const modelSchema = z.string().min(1).max(200);
const sessionIdSchema = z.string().min(1).max(512);
const messageSchema = z.string().min(1).max(100_000);
const idempotencyKeySchema = z.string().min(1).max(200);
const thinkingLevelSchema = z
  .string()
  .refine((v) => isThinkingLevel(v), { message: `thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}` });
const commandCodeEffortSchema = z.enum(COMMAND_CODE_EFFORT_LEVELS);
// TODO(remove once Agent OS drops the fields): accepted and ignored legacy
// Agent OS role fields. Command Code sessions no longer carry roles.
const commandCodeAttestationSchema = z.unknown();
const invocationRoleSchema = z.unknown();

const ttlSecondsSchema = z.number().int().finite().min(1).max(7 * 24 * 60 * 60);
const retentionSchema = z.object({
  mode: z.enum(['durable', 'resident']),
  ttlSeconds: ttlSecondsSchema.optional(),
  ownerId: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
}).strict();
const pinFields = {
  pin: z.boolean().optional(),
  pinTtlSeconds: ttlSecondsSchema.optional(),
  retention: retentionSchema.optional(),
};
// Contract 1.27.0 goal function: create-with-goal. Atomic create+start per
// runtime semantics (pi/claude dispatch detached; commandcode arms for its
// first prompt). OpenCode/antigravity reject — out of the goal surface.
export const goalSpecSchema = z.object({
  objective: z.string().min(1).max(4000),
  maxTurns: z.number().int().min(1).max(100).optional(),
  verifyCommand: z.string().min(1).max(2000).optional(),
  minReviews: z.number().int().min(0).optional(),
  budgetTokens: z.number().int().min(1).optional(),
  budgetUsd: z.number().min(0).optional(),
  modelVerifier: z.string().min(1).max(200).optional(),
  autoContinue: z.boolean().optional(),
}).strict();
const goalField = { goal: goalSpecSchema.optional() };
const goalRuntimeRefine = (body: { runtime: string; goal?: unknown }, ctx: z.RefinementCtx): void => {
  if (body.goal !== undefined && (body.runtime === 'opencode' || body.runtime === 'antigravity')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['goal'], message: `goal is not supported for runtime '${body.runtime}'` });
  }
};

export const createSessionBodySchema = z.object({
  runtime: sessionRuntimeSchema,
  cwd: cwdSchema.optional(),
  model: modelSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  effort: commandCodeEffortSchema.optional(),
  source: z.string().max(200).optional(),
  scenarioId: z.string().max(200).optional(),
  ephemeral: z.boolean().optional(),
  profileId: z.string().min(1).max(200).optional(),
  invocationRole: invocationRoleSchema.optional(),
  commandCodeAttestation: commandCodeAttestationSchema.optional(),
  ...pinFields,
  ...goalField,
}).strict().superRefine((body, ctx) => {
  if (body.pin && body.retention) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retention'], message: 'Use either legacy pin or retention, not both' });
  }
  goalRuntimeRefine(body, ctx);
  if (body.profileId !== undefined && body.runtime !== 'claude') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['profileId'],
      message: 'profileId is only supported for the claude runtime',
    });
  }
  if (body.runtime === 'claude' && body.model?.startsWith('profile:') && !body.model.slice('profile:'.length).trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'Claude profile model selector requires a non-empty profile id',
    });
  }
});

const batchCreateEntrySchema = z.object({
  runtime: sessionRuntimeSchema,
  cwd: cwdSchema.optional(),
  model: modelSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  effort: commandCodeEffortSchema.optional(),
  invocationRole: invocationRoleSchema.optional(),
  commandCodeAttestation: commandCodeAttestationSchema.optional(),
  ...pinFields,
  ...goalField,
}).strict().superRefine((body, ctx) => {
  if (body.runtime === 'claude' && body.model?.startsWith('profile:') && !body.model.slice('profile:'.length).trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: 'Claude profile model selector requires a non-empty profile id',
    });
  }
  goalRuntimeRefine(body, ctx);
});

export const sessionControlBodySchema = z.object({
  action: z.enum(['set_model', 'set_thinking_level', 'set_effort', 'pin', 'unpin', 'acquire_retention', 'renew_retention', 'release_retention']),
  modelId: z.string().min(1).optional(),
  level: z.string().min(1).optional(),
  effort: commandCodeEffortSchema.optional(),
  pinTtlSeconds: ttlSecondsSchema.optional(),
  retentionLeaseId: z.string().uuid().optional(),
  ownerId: z.string().min(1).max(200).optional(),
  retention: retentionSchema.optional(),
}).strict();

export const batchCreateBodySchema = z.object({
  sessions: z.array(batchCreateEntrySchema).min(1).max(MAX_BATCH_ITEMS),
}).strict();

const batchPromptEntrySchema = z.object({
  sessionId: sessionIdSchema,
  message: messageSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

export const batchPromptBodySchema = z.object({
  prompts: z.array(batchPromptEntrySchema).min(1).max(MAX_BATCH_ITEMS),
  parallel: z.boolean().optional(),
}).strict();

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type BatchCreateBody = z.infer<typeof batchCreateBodySchema>;
export type BatchPromptBody = z.infer<typeof batchPromptBodySchema>;

/**
 * Run `fn` over every item with at most `limit` concurrent invocations, returning
 * results in input order. A rejection from `fn` propagates (callers wrap per-item
 * work in try/catch to preserve partial-success semantics).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    let index = cursor;
    cursor += 1;
    while (index < items.length) {
      results[index] = await fn(items[index], index);
      index = cursor;
      cursor += 1;
    }
  };
  const workers = Array.from({ length: effectiveLimit }, () => worker());
  await Promise.all(workers);
  return results;
}

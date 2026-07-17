/**
 * Internal API: strict request-body validation + bounded concurrency for the
 * session/batch endpoints.
 *
 * These Zod schemas are the single source of truth for the shape of
 * create-session, batch-create, and batch-prompt bodies. They enforce:
 *   - `runtime` is exactly one of the four supported runtimes (no silent
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

export const MAX_BATCH_ITEMS = 50;

/**
 * Conservative in-process concurrency ceiling for batch fan-out. Matches the
 * most constrained runtime (Pi `maxSessions` = 4) so a batch cannot overrun
 * runtime capacity. Single-item requests are unaffected (1 ≤ limit).
 */
export const BATCH_CONCURRENCY_LIMIT = 4;

export const sessionRuntimeSchema = z.enum(['pi', 'claude', 'opencode', 'antigravity']);

const cwdSchema = z.string().min(1).max(4096);
const modelSchema = z.string().min(1).max(200);
const sessionIdSchema = z.string().min(1).max(512);
const messageSchema = z.string().min(1).max(100_000);
const idempotencyKeySchema = z.string().min(1).max(200);
const thinkingLevelSchema = z
  .string()
  .refine((v) => isThinkingLevel(v), { message: `thinkingLevel must be one of ${THINKING_LEVELS.join(', ')}` });

const pinFields = {
  pin: z.boolean().optional(),
  pinTtlSeconds: z.number().int().finite().min(1).max(7 * 24 * 60 * 60).optional(),
};

export const createSessionBodySchema = z.object({
  runtime: sessionRuntimeSchema,
  cwd: cwdSchema.optional(),
  model: modelSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  source: z.string().max(200).optional(),
  scenarioId: z.string().max(200).optional(),
  ephemeral: z.boolean().optional(),
  profileId: z.string().min(1).max(200).optional(),
  ...pinFields,
});

const batchCreateEntrySchema = z.object({
  runtime: sessionRuntimeSchema,
  cwd: cwdSchema.optional(),
  model: modelSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  ...pinFields,
});

export const batchCreateBodySchema = z.object({
  sessions: z.array(batchCreateEntrySchema).min(1).max(MAX_BATCH_ITEMS),
});

const batchPromptEntrySchema = z.object({
  sessionId: sessionIdSchema,
  message: messageSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const batchPromptBodySchema = z.object({
  prompts: z.array(batchPromptEntrySchema).min(1).max(MAX_BATCH_ITEMS),
  parallel: z.boolean().optional(),
});

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

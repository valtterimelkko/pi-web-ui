import { z } from 'zod';
import { runtimeSchema } from './internal-api-types.js';

export const sessionIdSchema = z.string().uuid();
export const runIdSchema = z.string().uuid();
export const modelSelectorSchema = z.string().min(1).max(200);
export const messageSchema = z.string().min(1).max(16_000);
export const idempotencyKeySchema = z.string().min(1).max(128);

export const getCapabilitiesSchema = z.object({}).strict();
export const listModelsSchema = z.object({
  runtime: runtimeSchema.optional(),
}).strict();
export const listSessionsSchema = z.object({}).strict();
export const createSessionSchema = z.object({
  runtime: runtimeSchema,
  model: modelSelectorSchema.optional(),
}).strict();
export const dispatchPromptSchema = z.object({
  sessionId: sessionIdSchema,
  message: messageSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
export const getRunSchema = z.object({
  runId: runIdSchema,
}).strict();
export const getTranscriptSchema = z.object({
  sessionId: sessionIdSchema,
  scope: z.enum(['visible_recent', 'visible_full']).default('visible_recent'),
}).strict();

export type GetCapabilitiesInput = z.infer<typeof getCapabilitiesSchema>;
export type ListModelsInput = z.infer<typeof listModelsSchema>;
export type ListSessionsInput = z.infer<typeof listSessionsSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type DispatchPromptInput = z.infer<typeof dispatchPromptSchema>;
export type GetRunInput = z.infer<typeof getRunSchema>;
export type GetTranscriptInput = z.infer<typeof getTranscriptSchema>;

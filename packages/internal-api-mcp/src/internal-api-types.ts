import { z } from 'zod';

export const runtimeSchema = z.enum(['pi', 'claude', 'opencode', 'antigravity']);
export type Runtime = z.infer<typeof runtimeSchema>;

const boundedString = (max: number) => z.string().max(max);

export const contractSchema = z.object({
  name: z.string(),
  routePrefix: z.string(),
  majorVersion: z.string(),
  contractVersion: z.string(),
  stability: z.string().optional(),
  contractDoc: z.string().optional(),
}).passthrough();

const runtimeCapabilitySchema = z.object({
  available: z.boolean().optional(),
  enabled: z.boolean().optional(),
  backendMode: z.string().optional(),
  supportsFollowUp: z.boolean().optional(),
  followUpSemantics: z.string().optional(),
  supportsSteer: z.boolean().optional(),
  supportsSteerWhileBusy: z.boolean().optional(),
}).passthrough();

export const capabilitiesSchema = z.object({
  status: z.string().optional(),
  contract: contractSchema,
  features: z.record(z.string(), z.unknown()).optional(),
  runtimes: z.record(z.string(), runtimeCapabilitySchema),
}).passthrough();
export type CapabilitiesResponse = z.infer<typeof capabilitiesSchema>;

export const modelSchema = z.object({
  id: boundedString(200),
  displayName: boundedString(300).optional(),
  provider: boundedString(100).optional(),
  backend: boundedString(100).optional(),
  claudeModel: boundedString(100).optional(),
  contextWindow: z.number().int().nonnegative().optional(),
  reasoning: z.boolean().optional(),
  thinkingLevels: z.array(boundedString(32)).max(16).optional(),
  effortLevels: z.array(boundedString(32)).max(16).optional(),
  defaultEffort: boundedString(32).optional(),
  supportsEffort: z.boolean().optional(),
}).passthrough();
export type Model = z.infer<typeof modelSchema>;

export const modelsResponseSchema = z.object({
  models: z.record(z.string(), z.array(modelSchema)),
}).passthrough();
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

export const sessionSchema = z.object({
  sessionId: boundedString(256),
  sessionPath: boundedString(1024).optional(),
  runtime: z.string().optional(),
  status: boundedString(64).optional(),
  model: boundedString(200).optional(),
  modelSelector: boundedString(200).optional(),
  executionInstanceId: boundedString(200).optional(),
  createdAt: boundedString(128).optional(),
  lastActivity: boundedString(128).optional(),
  lastActivityAt: z.number().finite().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  firstMessage: boundedString(512).optional(),
}).passthrough();
export type Session = z.infer<typeof sessionSchema>;

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionSchema).max(1000),
}).passthrough();
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: boundedString(256),
  sessionPath: boundedString(1024).optional(),
  runtime: z.string(),
  model: boundedString(200).optional(),
  modelSelector: boundedString(200).optional(),
  createdAt: boundedString(128).optional(),
  cwd: boundedString(2048).optional(),
}).passthrough();
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

const tokenUsageSchema = z.object({
  scope: boundedString(32).optional(),
  source: boundedString(100).optional(),
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  total: z.number().nonnegative().optional(),
}).passthrough();

const outputEvidenceSchema = z.object({
  policyVersion: boundedString(100).optional(),
  source: boundedString(100).optional(),
  assistantMessages: z.number().int().nonnegative().optional(),
  assistantTextBlocks: z.number().int().nonnegative().optional(),
  assistantTextChars: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  disposition: z.enum(['text', 'no-text', 'unknown']).optional(),
}).passthrough();

const cessationSchema = z.object({
  state: z.enum(['confirmed', 'unconfirmed', 'unknown']).optional(),
  basis: boundedString(100).optional(),
  observedAt: boundedString(128).optional(),
}).passthrough();

const livenessSchema = z.object({
  activityPolicyVersion: boundedString(100).optional(),
  idleTimeoutMs: z.number().int().nonnegative().optional(),
  absoluteTimeoutMs: z.number().int().nonnegative().optional(),
  cessation: cessationSchema.optional(),
}).passthrough();

export const runReceiptSchema = z.object({
  runId: boundedString(256),
  sessionId: boundedString(256),
  runtime: z.string(),
  executionInstanceId: boundedString(200).optional(),
  model: boundedString(200).optional(),
  modelSelector: boundedString(200).optional(),
  status: z.enum(['accepted', 'queued', 'started', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
  acceptedAt: boundedString(128).optional(),
  startedAt: boundedString(128).optional(),
  agentEndAt: boundedString(128).optional(),
  terminalAt: boundedString(128).optional(),
  errorCode: boundedString(128).optional(),
  error: boundedString(512).optional(),
  hint: boundedString(512).optional(),
  tokenUsage: tokenUsageSchema.optional(),
  outputEvidence: outputEvidenceSchema.optional(),
  liveness: livenessSchema.optional(),
}).passthrough();
export type RunReceipt = z.infer<typeof runReceiptSchema>;

export const dispatchResponseSchema = z.object({
  sessionId: boundedString(256),
  runId: boundedString(256),
  detached: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  status: z.string().optional(),
  receipt: runReceiptSchema.optional(),
}).passthrough();
export type DispatchResponse = z.infer<typeof dispatchResponseSchema>;

export const transcriptItemSchema = z.object({
  kind: z.enum(['user', 'assistant', 'tool']),
  text: boundedString(32_000),
  timestamp: z.union([z.number().finite(), boundedString(128)]).optional(),
  toolName: boundedString(200).optional(),
  toolPrimaryArg: boundedString(512).optional(),
}).passthrough();
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;

export const transcriptResponseSchema = z.object({
  sessionId: boundedString(256),
  runtime: z.string(),
  scope: z.enum(['visible_recent', 'visible_full']).optional(),
  itemCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  items: z.array(transcriptItemSchema).max(100_000),
}).passthrough();
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

export interface CreateSessionInput {
  runtime: Runtime;
  model?: string;
  cwd?: string;
}

export interface DispatchPromptInput {
  message: string;
  idempotencyKey?: string;
}

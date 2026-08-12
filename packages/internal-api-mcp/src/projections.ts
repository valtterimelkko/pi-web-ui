import type {
  CapabilitiesResponse,
  CreateSessionResponse,
  DispatchResponse,
  Model,
  ModelsResponse,
  RunReceipt,
  Runtime,
  Session,
  SessionsResponse,
  TranscriptItem,
  TranscriptResponse,
} from './internal-api-types.js';

export const ORDINARY_RUNTIMES = ['pi', 'claude', 'opencode', 'antigravity'] as const;
export const MAX_PROJECTED_SESSIONS = 200;
export const MAX_PROJECTED_MODELS = 200;
const MAX_PROVIDER_IDS = 32;
const MAX_TERMINAL_OBSERVATIONS = 4;

type OrdinaryRuntime = (typeof ORDINARY_RUNTIMES)[number];

export function isOrdinaryRuntime(value: unknown): value is OrdinaryRuntime {
  return typeof value === 'string' && (ORDINARY_RUNTIMES as readonly string[]).includes(value);
}

function copyOptional<T extends Record<string, unknown>, K extends keyof T>(source: T, key: K, target: Record<string, unknown>): void {
  const value = source[key];
  if (value !== undefined) target[String(key)] = value;
}

function projectRuntimeCapability(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!value) return result;
  for (const key of [
    'available',
    'enabled',
    'backendMode',
    'supportsFollowUp',
    'followUpSemantics',
    'supportsSteer',
    'supportsSteerWhileBusy',
    'supportsInteractiveQuestions',
    'supportsStructuredQuestionResponse',
    'supportsModelSwitch',
    'supportsThinkingLevel',
    'supportsPinning',
    'supportsReplayHistory',
    'supportsApprovals',
    'supportsHeartbeat',
  ]) copyOptional(value, key, result);
  return result;
}

export interface CapabilitiesProjection {
  contract: {
    name: string;
    routePrefix: string;
    majorVersion: string;
    contractVersion: string;
    stability?: string;
  };
  runtimes: Record<OrdinaryRuntime, Record<string, unknown>>;
  providerPolicy: { blockedProviders: string[] };
}

export function projectCapabilities(value: CapabilitiesResponse): CapabilitiesProjection {
  const runtimes = {} as CapabilitiesProjection['runtimes'];
  for (const runtime of ORDINARY_RUNTIMES) {
    runtimes[runtime] = projectRuntimeCapability(value.runtimes[runtime] as Record<string, unknown> | undefined);
  }
  const policy = value.features?.piProviderPolicy;
  const blockedProviders = policy && typeof policy === 'object' && !Array.isArray(policy)
    ? (policy as Record<string, unknown>).blockedProviders
    : undefined;
  return {
    contract: {
      name: value.contract.name,
      routePrefix: value.contract.routePrefix,
      majorVersion: value.contract.majorVersion,
      contractVersion: value.contract.contractVersion,
      ...(value.contract.stability === undefined ? {} : { stability: value.contract.stability }),
    },
    runtimes,
    providerPolicy: {
      blockedProviders: Array.isArray(blockedProviders)
        ? blockedProviders.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 100).slice(0, MAX_PROVIDER_IDS)
        : [],
    },
  };
}

function projectModel(value: Model): Record<string, unknown> {
  const result: Record<string, unknown> = { id: value.id };
  for (const key of [
    'displayName',
    'provider',
    'backend',
    'claudeModel',
    'contextWindow',
    'reasoning',
    'thinkingLevels',
    'effortLevels',
    'defaultEffort',
    'supportsEffort',
  ]) copyOptional(value as unknown as Record<string, unknown>, key, result);
  return result;
}

export function projectModels(value: ModelsResponse): { models: Partial<Record<Runtime, Array<Record<string, unknown>>>> } {
  const models: Partial<Record<Runtime, Array<Record<string, unknown>>>> = {};
  for (const runtime of ORDINARY_RUNTIMES) {
    const entries = value.models[runtime];
    if (entries === undefined) continue;
    models[runtime] = entries.slice(0, MAX_PROJECTED_MODELS).map(projectModel);
  }
  return { models };
}

function projectSession(value: Session): Record<string, unknown> | undefined {
  if (!isOrdinaryRuntime(value.runtime)) return undefined;
  const result: Record<string, unknown> = {
    sessionId: value.sessionId,
    runtime: value.runtime,
  };
  for (const key of [
    'status',
    'model',
    'modelSelector',
    'executionInstanceId',
    'createdAt',
    'lastActivity',
    'lastActivityAt',
    'messageCount',
    'firstMessage',
  ]) copyOptional(value as unknown as Record<string, unknown>, key, result);
  return result;
}

export function projectSessions(value: SessionsResponse): { sessions: Array<Record<string, unknown>> } {
  const sessions: Array<Record<string, unknown>> = [];
  for (const session of value.sessions) {
    if (sessions.length >= MAX_PROJECTED_SESSIONS) break;
    const projected = projectSession(session);
    if (projected) sessions.push(projected);
  }
  return { sessions };
}

export function assertOrdinaryRuntime(runtime: string): OrdinaryRuntime {
  if (!isOrdinaryRuntime(runtime)) throw new Error('Internal API returned an unsupported runtime');
  return runtime;
}

export function projectCreateSession(value: CreateSessionResponse): Record<string, unknown> {
  const result: Record<string, unknown> = {
    sessionId: value.sessionId,
    runtime: assertOrdinaryRuntime(value.runtime),
  };
  for (const key of ['model', 'modelSelector', 'createdAt'] as const) copyOptional(value as unknown as Record<string, unknown>, key, result);
  return result;
}

export function projectDispatch(value: DispatchResponse): Record<string, unknown> {
  const result: Record<string, unknown> = {
    sessionId: value.sessionId,
    runId: value.runId,
  };
  for (const key of ['detached', 'duplicate', 'status'] as const) copyOptional(value as unknown as Record<string, unknown>, key, result);
  if (value.receipt !== undefined) result.receipt = projectRun(value.receipt);
  return result;
}

function projectTokenUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['scope', 'source', 'input', 'output', 'total']) copyOptional(source, key, result);
  return Object.keys(result).length === 0 ? undefined : result;
}

function projectOutputEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['policyVersion', 'source', 'assistantMessages', 'assistantTextBlocks', 'assistantTextChars', 'toolCalls', 'disposition']) copyOptional(source, key, result);
  return Object.keys(result).length === 0 ? undefined : result;
}

function projectLiveness(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['activityPolicyVersion', 'idleTimeoutMs', 'absoluteTimeoutMs']) copyOptional(source, key, result);
  const cessation = source.cessation;
  if (cessation && typeof cessation === 'object' && !Array.isArray(cessation)) {
    const projectedCessation: Record<string, unknown> = {};
    for (const key of ['state', 'basis', 'observedAt']) copyOptional(cessation as Record<string, unknown>, key, projectedCessation);
    if (Object.keys(projectedCessation).length > 0) result.cessation = projectedCessation;
  }
  const latest = source.lastEligibleActivity;
  if (latest && typeof latest === 'object' && !Array.isArray(latest)) {
    const projectedLatest: Record<string, unknown> = {};
    for (const key of ['eventType', 'occurredAt', 'observedAt']) copyOptional(latest as Record<string, unknown>, key, projectedLatest);
    if (Object.keys(projectedLatest).length > 0) result.lastEligibleActivity = projectedLatest;
  }
  const observations = source.terminalObservations;
  if (Array.isArray(observations)) {
    result.terminalObservations = observations.slice(0, MAX_TERMINAL_OBSERVATIONS).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const projected: Record<string, unknown> = {};
      for (const key of ['type', 'occurredAt', 'observedAt', 'origin', 'late']) copyOptional(entry as Record<string, unknown>, key, projected);
      return Object.keys(projected).length > 0 ? [projected] : [];
    });
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function projectRun(value: RunReceipt): Record<string, unknown> {
  const result: Record<string, unknown> = {
    runId: value.runId,
    sessionId: value.sessionId,
    runtime: assertOrdinaryRuntime(value.runtime),
  };
  for (const key of [
    'executionInstanceId',
    'model',
    'modelSelector',
    'status',
    'acceptedAt',
    'startedAt',
    'agentEndAt',
    'terminalAt',
    'errorCode',
    'hint',
  ]) copyOptional(value as unknown as Record<string, unknown>, key, result);
  const tokenUsage = projectTokenUsage(value.tokenUsage);
  if (tokenUsage) result.tokenUsage = tokenUsage;
  const outputEvidence = projectOutputEvidence(value.outputEvidence);
  if (outputEvidence) result.outputEvidence = outputEvidence;
  const liveness = projectLiveness(value.liveness);
  if (liveness) result.liveness = liveness;
  return result;
}

function projectTranscriptItem(value: TranscriptItem): Record<string, unknown> {
  const result: Record<string, unknown> = { kind: value.kind, text: value.text };
  for (const key of ['timestamp', 'toolName', 'toolPrimaryArg'] as const) copyOptional(value as unknown as Record<string, unknown>, key, result);
  return result;
}

interface TranscriptBase {
  sessionId: string;
  runtime: string;
  scope?: 'visible_recent' | 'visible_full';
  itemCount?: number;
  truncated?: boolean;
  items: Array<Record<string, unknown>>;
}

export interface TranscriptProjection extends TranscriptBase {
  outputTruncated: boolean;
  projectedByteCount: number;
  excerpt?: string;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function transcriptBase(value: TranscriptResponse): TranscriptBase {
  return {
    sessionId: value.sessionId,
    runtime: assertOrdinaryRuntime(value.runtime),
    ...(value.scope === undefined ? {} : { scope: value.scope }),
    ...(value.itemCount === undefined ? {} : { itemCount: value.itemCount }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    items: value.items.map(projectTranscriptItem),
  };
}

export function projectTranscript(value: TranscriptResponse, maxToolOutputBytes: number): TranscriptProjection {
  const base = transcriptBase(value);
  const projectedByteCount = Buffer.byteLength(JSON.stringify(base), 'utf8');
  const intact: TranscriptProjection = { ...base, outputTruncated: false, projectedByteCount };
  if (Buffer.byteLength(JSON.stringify(intact), 'utf8') <= maxToolOutputBytes) return intact;

  const text = base.items.map((item) => String(item.text ?? '')).join('\n');
  const createTruncated = (excerpt: string): TranscriptProjection => ({
    sessionId: base.sessionId,
    runtime: base.runtime,
    ...(base.scope === undefined ? {} : { scope: base.scope }),
    ...(base.itemCount === undefined ? {} : { itemCount: base.itemCount }),
    truncated: true,
    items: [],
    outputTruncated: true,
    projectedByteCount,
    excerpt,
  });

  let low = 0;
  let high = Buffer.byteLength(text, 'utf8');
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(text, middle);
    const serializedSize = Buffer.byteLength(JSON.stringify(createTruncated(candidate)), 'utf8');
    if (serializedSize <= maxToolOutputBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return createTruncated(best);
}

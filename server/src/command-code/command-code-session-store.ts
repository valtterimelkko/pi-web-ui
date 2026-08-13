import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCommandCodeEffort, type CommandCodeEffort, type CommandCodeRuntimeModel } from './command-code-model-catalog.js';
import type { CommandCodePermissionProfile } from './command-code-config.js';

export type CommandCodeSessionState = 'created' | 'running' | 'idle' | 'failed' | 'aborted' | 'deleted';
export type CommandCodeInvocationRole = 'conductor-root' | 'implementation-child';

export interface CommandCodeInternalSessionRecord {
  schemaVersion: 1;
  sessionId: string;
  runtime: 'commandcode';
  nativeSessionId?: string;
  cwd: string;
  modelSelector: CommandCodeRuntimeModel;
  /** Accepted native effort for the next Command Code turn, when adjustable. */
  effort?: CommandCodeEffort;
  effortSource?: 'explicit' | 'default' | 'automatic' | 'none';
  defaultEffort?: CommandCodeEffort;
  effectiveEffort?: CommandCodeEffort;
  effortEvidenceMethod?: 'provider-event' | 'provider-result' | 'unobserved';
  effortCapabilityHash?: string;
  executionInstanceId: 'commandcode-default';
  permissionProfile: CommandCodePermissionProfile;
  invocationRole?: CommandCodeInvocationRole;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  eventJournalRef: string;
  state: CommandCodeSessionState;
  lastResult?: {
    subtype: 'success' | 'error' | 'max_turns';
    stopReason?: string;
    exitCode?: number;
  };
  messageCount: number;
  firstMessage: string;
  lastMessage?: string;
  lastFinalText?: string;
  diagnostics?: {
    suppressedDuplicateCount: number;
    unknownEventTypes: string[];
    stderrTail?: string;
    protocolError?: string;
    nativeSessionId?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    terminationCause?: 'abort' | 'timeout' | 'shutdown';
  };
}

export interface CreateCommandCodeSessionInput {
  sessionId?: string;
  cwd: string;
  modelSelector: CommandCodeRuntimeModel;
  effort?: CommandCodeEffort;
  effortSource?: 'explicit' | 'default' | 'automatic' | 'none';
  defaultEffort?: CommandCodeEffort;
  effortCapabilityHash?: string;
  permissionProfile: CommandCodePermissionProfile;
  invocationRole?: CommandCodeInvocationRole;
  eventJournalRef: string;
}

export class CommandCodeSessionStore {
  private readonly root: string;
  private readonly sessionsDir: string;
  private readonly records = new Map<string, CommandCodeInternalSessionRecord>();
  private readonly invalidSessionIds = new Set<string>();
  private saveQueue: Promise<void> = Promise.resolve();
  private bindingQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.sessionsDir = path.join(this.root, 'sessions');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    for (const filename of await readdir(this.sessionsDir)) {
      if (!filename.endsWith('.json')) continue;
      try {
        const record = validateRecord(JSON.parse(await readFile(path.join(this.sessionsDir, filename), 'utf8')));
        if (filename !== `${record.sessionId}.json`) throw new Error('Command Code session filename does not match its identity');
        const canonical = await canonicalCwd(record.cwd);
        if (canonical !== record.cwd) throw new Error('Command Code persisted cwd is no longer canonical');
        const duplicate = record.nativeSessionId && [...this.records.values()].find((candidate) => candidate.nativeSessionId === record.nativeSessionId);
        if (duplicate) throw new Error(`Duplicate Command Code native session id bound to ${duplicate.sessionId}`);
        this.records.set(record.sessionId, record);
      } catch {
        const invalidSessionId = filename.slice(0, -'.json'.length);
        if (/^[-a-zA-Z0-9_]+$/.test(invalidSessionId)) this.invalidSessionIds.add(invalidSessionId);
        // A corrupt private mapping is not turned into a fabricated session. It
        // remains on disk for diagnosis and is omitted from normal resolution.
      }
    }
    this.initialized = true;
  }

  async create(input: CreateCommandCodeSessionInput): Promise<CommandCodeInternalSessionRecord> {
    await this.init();
    const sessionId = input.sessionId ?? `commandcode-${randomUUID()}`;
    if (!/^[-a-zA-Z0-9_]+$/.test(sessionId)) throw new Error('Invalid Command Code session id');
    if (this.records.has(sessionId)) throw new Error(`Command Code session already exists: ${sessionId}`);
    const model = input.modelSelector;
    if (!isValidCommandCodeRuntimeModel(model)) throw new Error('Command Code model is not a valid exact runtime id');
    const cwd = await canonicalCwd(input.cwd);
    const now = new Date().toISOString();
    const record: CommandCodeInternalSessionRecord = {
      schemaVersion: 1,
      sessionId,
      runtime: 'commandcode',
      cwd,
      modelSelector: model,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.effortSource ? { effortSource: input.effortSource } : {}),
      ...(input.defaultEffort ? { defaultEffort: input.defaultEffort } : {}),
      ...(input.effortCapabilityHash ? { effortCapabilityHash: input.effortCapabilityHash } : {}),
      executionInstanceId: 'commandcode-default',
      permissionProfile: input.permissionProfile,
      ...(input.invocationRole ? { invocationRole: input.invocationRole } : {}),
      createdAt: now,
      updatedAt: now,
      eventJournalRef: validateJournalRef(input.eventJournalRef),
      state: 'created',
      messageCount: 0,
      firstMessage: '',
    };
    validateRecord(record);
    this.records.set(sessionId, record);
    await this.persist(record);
    return clone(record);
  }

  async get(sessionId: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    await this.init();
    const record = this.records.get(sessionId);
    return record ? clone(record) : undefined;
  }

  async list(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    return [...this.records.values()].filter((record) => record.state !== 'deleted').map(clone);
  }

  listInvalidSessionIds(): string[] {
    return [...this.invalidSessionIds];
  }

  async update(sessionId: string, patch: Partial<Pick<CommandCodeInternalSessionRecord,
    'nativeSessionId' | 'activeRunId' | 'state' | 'lastResult' | 'messageCount' | 'firstMessage' |
    'lastMessage' | 'lastFinalText' | 'diagnostics' | 'effectiveEffort' | 'effortEvidenceMethod'>> & {
      cwd?: string;
      modelSelector?: CommandCodeRuntimeModel;
      permissionProfile?: CommandCodePermissionProfile;
      invocationRole?: CommandCodeInvocationRole;
      effort?: CommandCodeEffort;
      effortSource?: 'explicit' | 'default' | 'automatic' | 'none';
      defaultEffort?: CommandCodeEffort;
      effortCapabilityHash?: string;
    }): Promise<CommandCodeInternalSessionRecord> {
    if (patch.nativeSessionId !== undefined) {
      return this.withNativeBindingLock(() => this.updateRecord(sessionId, patch));
    }
    return this.updateRecord(sessionId, patch);
  }

  private async updateRecord(sessionId: string, patch: Partial<Pick<CommandCodeInternalSessionRecord,
    'nativeSessionId' | 'activeRunId' | 'state' | 'lastResult' | 'messageCount' | 'firstMessage' |
    'lastMessage' | 'lastFinalText' | 'diagnostics' | 'effectiveEffort' | 'effortEvidenceMethod'>> & {
      cwd?: string;
      modelSelector?: CommandCodeRuntimeModel;
      permissionProfile?: CommandCodePermissionProfile;
      invocationRole?: CommandCodeInvocationRole;
      effort?: CommandCodeEffort;
      effortSource?: 'explicit' | 'default' | 'automatic' | 'none';
      defaultEffort?: CommandCodeEffort;
      effortCapabilityHash?: string;
    }): Promise<CommandCodeInternalSessionRecord> {
    await this.init();
    const current = this.records.get(sessionId);
    if (!current) throw new Error(`Command Code session not found: ${sessionId}`);
    if (patch.modelSelector !== undefined && patch.modelSelector !== current.modelSelector) throw new Error('Command Code model binding drift');
    if (patch.permissionProfile !== undefined && patch.permissionProfile !== current.permissionProfile) throw new Error('Command Code permission profile drift');
    if (patch.invocationRole !== undefined && patch.invocationRole !== current.invocationRole) throw new Error('Command Code invocation role drift');
    if (patch.cwd !== undefined && path.resolve(patch.cwd) !== current.cwd) throw new Error('Command Code cwd binding drift');
    if (patch.nativeSessionId !== undefined && current.nativeSessionId !== undefined && patch.nativeSessionId !== current.nativeSessionId) {
      throw new Error('Command Code native session id drift');
    }
    const updated: CommandCodeInternalSessionRecord = {
      ...current,
      ...patch,
      ...(patch.nativeSessionId !== undefined ? { nativeSessionId: patch.nativeSessionId } : {}),
      updatedAt: new Date().toISOString(),
    };
    validateRecord(updated);
    this.records.set(sessionId, updated);
    await this.persist(updated);
    return clone(updated);
  }

  async setEffort(sessionId: string, input: {
    effort?: CommandCodeEffort;
    effortSource: 'explicit' | 'default' | 'automatic' | 'none';
    defaultEffort?: CommandCodeEffort;
    effortCapabilityHash?: string;
  }): Promise<CommandCodeInternalSessionRecord> {
    const current = await this.get(sessionId);
    if (!current) throw new Error(`Command Code session not found: ${sessionId}`);
    if (current.state === 'running') throw new Error('Command Code effort can only change while the session is idle');
    return this.update(sessionId, {
      effort: input.effort,
      effortSource: input.effortSource,
      defaultEffort: input.defaultEffort,
      effortCapabilityHash: input.effortCapabilityHash,
    });
  }

  async bindNativeSession(sessionId: string, nativeSessionId: string): Promise<CommandCodeInternalSessionRecord> {
    if (!nativeSessionId || nativeSessionId.length > 512 || /[\r\n]/.test(nativeSessionId)) throw new Error('Invalid Command Code native session id');
    await this.init();
    return this.withNativeBindingLock(async () => {
      const current = this.records.get(sessionId);
      if (!current) throw new Error(`Command Code session not found: ${sessionId}`);
      const duplicate = [...this.records.values()].find((record) => record.sessionId !== sessionId && record.nativeSessionId === nativeSessionId);
      if (duplicate) throw new Error(`Command Code native session id is already bound to ${duplicate.sessionId}`);
      return this.updateRecord(sessionId, { nativeSessionId });
    });
  }

  private async withNativeBindingLock<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.bindingQueue;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.bindingQueue = previous.then(() => current).catch(() => undefined);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async assertBinding(sessionId: string, binding: {
    cwd?: string;
    modelSelector?: CommandCodeRuntimeModel;
    permissionProfile?: CommandCodePermissionProfile;
    invocationRole?: CommandCodeInvocationRole;
    nativeSessionId?: string;
    effort?: CommandCodeEffort;
  }): Promise<CommandCodeInternalSessionRecord> {
    const record = await this.get(sessionId);
    if (!record) throw new Error(`Command Code session not found: ${sessionId}`);
    if (binding.cwd !== undefined && path.resolve(binding.cwd) !== record.cwd) throw new Error('Command Code cwd binding drift');
    if (binding.modelSelector !== undefined && binding.modelSelector !== record.modelSelector) throw new Error('Command Code model binding drift');
    if (binding.permissionProfile !== undefined && binding.permissionProfile !== record.permissionProfile) throw new Error('Command Code permission profile drift');
    if (binding.invocationRole !== undefined && binding.invocationRole !== record.invocationRole) throw new Error('Command Code invocation role drift');
    if (binding.nativeSessionId !== undefined && binding.nativeSessionId !== record.nativeSessionId) throw new Error('Command Code native session id drift');
    if (binding.effort !== undefined && binding.effort !== record.effort) throw new Error('Command Code effort binding drift');
    return record;
  }

  async delete(sessionId: string): Promise<boolean> {
    await this.init();
    const record = this.records.get(sessionId);
    if (!record) return false;
    this.records.delete(sessionId);
    // Deletion participates in the same ordered persistence queue as updates.
    // Otherwise an update already queued before this call can rename a stale
    // snapshot back into existence after the unlink.
    await this.enqueuePersistence(async () => {
      try { await unlink(this.recordPath(sessionId)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
    return true;
  }

  async reconcileAfterRestart(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    const recovered: CommandCodeInternalSessionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'running') continue;
      const updated = await this.update(record.sessionId, {
        state: 'failed',
        activeRunId: undefined,
        lastResult: { subtype: 'error', stopReason: 'server_restart_unknown' },
      });
      recovered.push(updated);
    }
    return recovered;
  }

  private async persist(record: CommandCodeInternalSessionRecord): Promise<void> {
    await this.enqueuePersistence(async () => {
      await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
      const target = this.recordPath(record.sessionId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    });
  }

  private async enqueuePersistence(operationBody: () => Promise<void>): Promise<void> {
    const operation = this.saveQueue.then(operationBody);
    this.saveQueue = operation.catch(() => undefined);
    await operation;
  }

  private recordPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }
}

export async function canonicalCwd(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const { realpath } = await import('node:fs/promises');
  const canonical = await realpath(resolved);
  if (canonical === path.parse(canonical).root) throw new Error('Command Code cwd may not be filesystem root');
  return canonical;
}

function validateJournalRef(value: string): string {
  if (!value || value.startsWith('/') || value.includes('..') || !/^[a-zA-Z0-9_.\-/]+$/.test(value)) {
    throw new Error('Invalid Command Code event journal reference');
  }
  return value;
}

function validateRecord(value: unknown): CommandCodeInternalSessionRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid Command Code session record');
  const record = value as Partial<CommandCodeInternalSessionRecord>;
  if (record.schemaVersion !== 1 || record.runtime !== 'commandcode' || typeof record.sessionId !== 'string' || !/^[-a-zA-Z0-9_]+$/.test(record.sessionId)) throw new Error('Invalid Command Code session record identity');
  const model = record.modelSelector;
  if (!isValidCommandCodeRuntimeModel(model)) throw new Error('Invalid Command Code model binding');
  if (record.executionInstanceId !== 'commandcode-default') throw new Error('Invalid Command Code execution instance');
  if (!record.cwd || !path.isAbsolute(record.cwd) || path.resolve(record.cwd) !== record.cwd || !record.eventJournalRef) throw new Error('Invalid Command Code session record paths');
  if (record.eventJournalRef !== `events/${record.sessionId}.jsonl` && record.eventJournalRef !== `${record.sessionId}.jsonl`) throw new Error('Invalid Command Code event journal binding');
  if (!record.permissionProfile || !record.state || !record.createdAt || !record.updatedAt) throw new Error('Invalid Command Code session record fields');
  if (!['agent-os-7f-root-readonly', 'implementation-child-wide', 'browser-contained'].includes(record.permissionProfile)) throw new Error('Invalid Command Code permission profile');
  if (record.invocationRole !== undefined && !['conductor-root', 'implementation-child'].includes(record.invocationRole)) throw new Error('Invalid Command Code invocation role');
  if (record.permissionProfile === 'browser-contained' && record.invocationRole !== undefined) throw new Error('Browser Command Code sessions cannot carry an invocation role');
  if (record.invocationRole === 'conductor-root' && record.permissionProfile !== 'agent-os-7f-root-readonly') throw new Error('Command Code root role/profile binding drift');
  if (record.invocationRole === 'implementation-child' && record.permissionProfile !== 'implementation-child-wide') throw new Error('Command Code child role/profile binding drift');
  if (record.nativeSessionId !== undefined && (!record.nativeSessionId || record.nativeSessionId.length > 512 || /[\r\n]/.test(record.nativeSessionId))) throw new Error('Invalid Command Code native session id');
  if (typeof record.messageCount !== 'number' || !Number.isSafeInteger(record.messageCount) || record.messageCount < 0 || record.messageCount > 1_000_000) throw new Error('Invalid Command Code message count');
  if (typeof record.firstMessage !== 'string' || record.firstMessage.length > 4_000 || (record.lastMessage !== undefined && (typeof record.lastMessage !== 'string' || record.lastMessage.length > 4_000)) || (record.lastFinalText !== undefined && (typeof record.lastFinalText !== 'string' || record.lastFinalText.length > 20_000))) throw new Error('Invalid Command Code message snapshot');
  if (!isIsoTimestamp(record.createdAt) || !isIsoTimestamp(record.updatedAt)) throw new Error('Invalid Command Code timestamps');
  if (record.diagnostics) {
    if (!Number.isSafeInteger(record.diagnostics.suppressedDuplicateCount) || record.diagnostics.suppressedDuplicateCount < 0) throw new Error('Invalid Command Code diagnostics');
    if (!Array.isArray(record.diagnostics.unknownEventTypes) || record.diagnostics.unknownEventTypes.some((value) => typeof value !== 'string' || value.length > 200)) throw new Error('Invalid Command Code diagnostics');
    if (record.diagnostics.nativeSessionId !== undefined && record.diagnostics.nativeSessionId !== record.nativeSessionId) throw new Error('Command Code diagnostic native session binding drift');
    if (record.diagnostics.stderrTail !== undefined && record.diagnostics.stderrTail.length > 64_000) throw new Error('Invalid Command Code diagnostics');
  }
  if (record.effort !== undefined) {
    try { assertCommandCodeEffort(model, record.effort); } catch { throw new Error('Invalid Command Code effort'); }
  }
  if (record.effortSource !== undefined && !['explicit', 'default', 'automatic', 'none'].includes(record.effortSource)) throw new Error('Invalid Command Code effort source');
  if ((record.effortSource === 'none' || record.effortSource === 'automatic') && record.effort !== undefined) throw new Error('Command Code automatic/non-adjustable effort cannot carry a value');
  if ((record.effortSource === 'explicit' || record.effortSource === 'default') && record.effort === undefined) throw new Error('Command Code adjustable effort source requires a value');
  if (record.defaultEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(record.defaultEffort)) throw new Error('Invalid Command Code default effort');
  if (record.effortCapabilityHash !== undefined && !/^[a-f0-9]{64}$/.test(record.effortCapabilityHash)) throw new Error('Invalid Command Code effort capability hash');
  if (record.effectiveEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(record.effectiveEffort)) throw new Error('Invalid Command Code effective effort');
  if (record.effortEvidenceMethod !== undefined && !['provider-event', 'provider-result', 'unobserved'].includes(record.effortEvidenceMethod)) throw new Error('Invalid Command Code effort evidence method');
  if (!['created', 'running', 'idle', 'failed', 'aborted', 'deleted'].includes(record.state)) throw new Error('Invalid Command Code session state');
  return record as CommandCodeInternalSessionRecord;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isValidCommandCodeRuntimeModel(value: unknown): value is CommandCodeRuntimeModel {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[a-z0-9][a-z0-9._/-]*$/.test(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

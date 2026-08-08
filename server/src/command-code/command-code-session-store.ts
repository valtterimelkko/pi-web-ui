import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertCommandCodeEffort, assertCommandCodeModel, type CommandCodeEffort, type CommandCodeModel } from './command-code-model-catalog.js';
import type { CommandCodePermissionProfile } from './command-code-config.js';

export type CommandCodeSessionState = 'created' | 'running' | 'idle' | 'failed' | 'aborted' | 'deleted';
export type CommandCodeInvocationRole = 'conductor-root' | 'implementation-child';

export interface CommandCodeInternalSessionRecord {
  schemaVersion: 1;
  sessionId: string;
  runtime: 'commandcode';
  nativeSessionId?: string;
  cwd: string;
  modelSelector: CommandCodeModel;
  /** Accepted native effort for the next Command Code turn, when adjustable. */
  effort?: CommandCodeEffort;
  effortSource?: 'explicit' | 'default' | 'none';
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
  modelSelector: CommandCodeModel;
  effort?: CommandCodeEffort;
  effortSource?: 'explicit' | 'default' | 'none';
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
  private saveQueue: Promise<void> = Promise.resolve();
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
        this.records.set(record.sessionId, record);
      } catch {
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
    const model = assertCommandCodeModel(input.modelSelector);
    if (!model) throw new Error('Command Code model is not allowlisted');
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

  async update(sessionId: string, patch: Partial<Pick<CommandCodeInternalSessionRecord,
    'nativeSessionId' | 'activeRunId' | 'state' | 'lastResult' | 'messageCount' | 'firstMessage' |
    'lastMessage' | 'lastFinalText' | 'diagnostics' | 'effectiveEffort' | 'effortEvidenceMethod'>> & {
      cwd?: string;
      modelSelector?: CommandCodeModel;
      permissionProfile?: CommandCodePermissionProfile;
      invocationRole?: CommandCodeInvocationRole;
      effort?: CommandCodeEffort;
      effortSource?: 'explicit' | 'default' | 'none';
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
    effortSource: 'explicit' | 'default' | 'none';
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
    return this.update(sessionId, { nativeSessionId });
  }

  async assertBinding(sessionId: string, binding: {
    cwd?: string;
    modelSelector?: CommandCodeModel;
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
  if (record.schemaVersion !== 1 || record.runtime !== 'commandcode' || typeof record.sessionId !== 'string') throw new Error('Invalid Command Code session record identity');
  const model = assertCommandCodeModel(record.modelSelector);
  if (!model) throw new Error('Invalid Command Code model binding');
  if (record.executionInstanceId !== 'commandcode-default') throw new Error('Invalid Command Code execution instance');
  if (!record.cwd || !path.isAbsolute(record.cwd) || !record.eventJournalRef) throw new Error('Invalid Command Code session record paths');
  if (!record.permissionProfile || !record.state || !record.createdAt || !record.updatedAt) throw new Error('Invalid Command Code session record fields');
  if (!['agent-os-7f-root-readonly', 'implementation-child-wide'].includes(record.permissionProfile)) throw new Error('Invalid Command Code permission profile');
  if (record.invocationRole !== undefined && !['conductor-root', 'implementation-child'].includes(record.invocationRole)) throw new Error('Invalid Command Code invocation role');
  if (record.invocationRole === 'conductor-root' && record.permissionProfile !== 'agent-os-7f-root-readonly') throw new Error('Command Code root role/profile binding drift');
  if (record.invocationRole === 'implementation-child' && record.permissionProfile !== 'implementation-child-wide') throw new Error('Command Code child role/profile binding drift');
  if (record.nativeSessionId !== undefined && (!record.nativeSessionId || record.nativeSessionId.length > 512 || /[\r\n]/.test(record.nativeSessionId))) throw new Error('Invalid Command Code native session id');
  if (record.effort !== undefined) {
    try { assertCommandCodeEffort(model, record.effort); } catch { throw new Error('Invalid Command Code effort'); }
  }
  if (record.effortSource !== undefined && !['explicit', 'default', 'none'].includes(record.effortSource)) throw new Error('Invalid Command Code effort source');
  if (record.effortSource === 'none' && record.effort !== undefined) throw new Error('Command Code non-adjustable effort cannot carry a value');
  if ((record.effortSource === 'explicit' || record.effortSource === 'default') && record.effort === undefined) throw new Error('Command Code adjustable effort source requires a value');
  if (record.defaultEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(record.defaultEffort)) throw new Error('Invalid Command Code default effort');
  if (record.effortCapabilityHash !== undefined && !/^[a-f0-9]{64}$/.test(record.effortCapabilityHash)) throw new Error('Invalid Command Code effort capability hash');
  if (record.effectiveEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(record.effectiveEffort)) throw new Error('Invalid Command Code effective effort');
  if (record.effortEvidenceMethod !== undefined && !['provider-event', 'provider-result', 'unobserved'].includes(record.effortEvidenceMethod)) throw new Error('Invalid Command Code effort evidence method');
  if (!['created', 'running', 'idle', 'failed', 'aborted', 'deleted'].includes(record.state)) throw new Error('Invalid Command Code session state');
  return record as CommandCodeInternalSessionRecord;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

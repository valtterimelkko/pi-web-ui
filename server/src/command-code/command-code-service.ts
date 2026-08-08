import { access, chmod, copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import {
  COMMAND_CODE_EXECUTION_INSTANCE_ID,
  defaultCommandCodeConfig,
  type CommandCodePermissionProfile,
  type CommandCodeRuntimeConfig,
} from './command-code-config.js';
import {
  COMMAND_CODE_MODELS,
  COMMAND_CODE_PROVIDER,
  COMMAND_CODE_VERSION,
  COMMAND_CODE_EFFORT_LEVELS_BY_MODEL,
  assertCommandCodeModel,
  assertCommandCodeEffort,
  discoverCommandCodeEfforts,
  discoverCommandCodeModels,
  type CommandCodeEffort,
  type CommandCodeEffortCapabilities,
  type CommandCodeModel,
  type CommandCodeModelDiscovery,
  type CommandCodeDiscoveryRunner,
} from './command-code-model-catalog.js';
import { adaptCommandCodeOutput } from './command-code-event-adapter.js';
import { verifyCommandCodeRoleAttestation, type CommandCodeRoleAttestation } from './command-code-role-attestation.js';
import { CommandCodeEventJournal } from './command-code-event-journal.js';
import {
  CommandCodeProcessRunner,
  type CommandCodeProcessRunResult,
} from './command-code-process-runner.js';
import {
  CommandCodeSessionStore,
  canonicalCwd,
  type CommandCodeInternalSessionRecord,
  type CommandCodeInvocationRole,
} from './command-code-session-store.js';

export type CommandCodeAvailability =
  | 'disabled'
  | 'executable_missing'
  | 'discovery_error'
  | 'version_mismatch'
  | 'exact_model_unavailable'
  | 'effort_capability_unknown'
  | 'available';

export interface CommandCodeHealth {
  enabled: boolean;
  available: boolean;
  status: CommandCodeAvailability;
  version?: string;
  expectedVersion: string;
  advertisedModels: CommandCodeModel[];
  missingModels: CommandCodeModel[];
  effortCapabilities: Partial<CommandCodeEffortCapabilities>;
  checkedAt: string;
  diagnostic?: string;
}

export interface CommandCodeServiceConfig extends Partial<CommandCodeRuntimeConfig> {
  enabled: boolean;
  executablePath: string;
  stateDir: string;
  allowedCwdRoots?: string[];
  expectedVersion: string;
}

export interface CommandCodeCreateInput {
  cwd: string;
  model: CommandCodeModel;
  /** Native effort; undefined means use the model's discovered default. */
  effort?: string;
  permissionProfile: CommandCodePermissionProfile;
  invocationRole?: CommandCodeInvocationRole;
  roleAttestation?: CommandCodeRoleAttestation;
}

export class CommandCodeRuntimeError extends Error {
  constructor(message: string, public readonly code: CommandCodeErrorClass = 'runtime_error') {
    super(message);
    this.name = 'CommandCodeRuntimeError';
  }
}

export type CommandCodeErrorClass =
  | 'runtime_error'
  | 'auth_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'network_failure'
  | 'provider_failure'
  | 'max_turns'
  | 'no_response'
  | 'credits'
  | 'interrupted'
  | 'protocol_error'
  | 'effort_unsupported';

type RunnerLike = Pick<CommandCodeProcessRunner, 'run' | 'abort' | 'shutdown' | 'isRunning'>;

export class CommandCodeService {
  readonly config: CommandCodeRuntimeConfig;
  readonly store: CommandCodeSessionStore;
  readonly journal: CommandCodeEventJournal;
  private readonly runner: RunnerLike;
  private readonly ownsProcessRunner: boolean;
  private readonly discover: CommandCodeDiscoveryRunner;
  private readonly usesDefaultDiscovery: boolean;
  private discovery?: CommandCodeModelDiscovery;
  private discoveryDiagnostic?: string;
  private healthStatus: CommandCodeAvailability = 'disabled';
  private initialized = false;
  private initPromise?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private readonly pinned = new Set<string>();
  private readonly pendingSessions = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private readonly effortMutations = new Set<string>();
  private readonly abortRequested = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly inFlightTurns = new Map<string, Promise<void>>();
  private readonly inFlightEffortMutations = new Map<string, Promise<void>>();
  private roleAttestationSecret?: string;

  constructor(options: {
    config: CommandCodeServiceConfig;
    runner?: RunnerLike;
    discover?: CommandCodeDiscoveryRunner;
    checkExecutable?: boolean;
  }) {
    const mergedConfig = { ...defaultCommandCodeConfig(options.config), ...options.config };
    if (!options.config.nativeHomeDir) mergedConfig.nativeHomeDir = path.join(mergedConfig.stateDir, 'native-home');
    this.config = {
      ...mergedConfig,
      allowedCwdRoots: options.config.allowedCwdRoots ?? [path.dirname(mergedConfig.stateDir)],
    };
    this.store = new CommandCodeSessionStore(this.config.stateDir);
    this.journal = new CommandCodeEventJournal(this.config.stateDir, {
      maxBytes: this.config.maxStdoutBytes,
    });
    this.ownsProcessRunner = !options.runner;
    this.runner = options.runner ?? new CommandCodeProcessRunner({
      executablePath: this.config.executablePath,
      processGraceMs: this.config.processGraceMs,
      maxWallTimeMs: this.config.maxWallTimeMs,
      maxStdoutLineBytes: this.config.maxStdoutLineBytes,
      maxStdoutBytes: this.config.maxStdoutBytes,
      maxPromptBytes: this.config.maxPromptBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      nativeHomeDir: this.config.nativeHomeDir,
    });
    this.usesDefaultDiscovery = !options.discover;
    this.discover = options.discover ?? discoverCommandCodeModels;
    this.checkExecutable = options.checkExecutable ?? true;
  }

  private readonly checkExecutable: boolean;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await this.store.init();
    await this.store.reconcileAfterRestart();
    if (!this.config.enabled) {
      this.healthStatus = 'disabled';
      this.initialized = true;
      return;
    }
    if (this.ownsProcessRunner) {
      await this.prepareNativeHomeRoot();
      for (const record of await this.store.list()) await this.prepareNativeHome(record.sessionId);
    }
    try {
      if (this.checkExecutable) await access(this.config.executablePath);
    } catch {
      this.healthStatus = 'executable_missing';
      this.discoveryDiagnostic = 'Configured Command Code executable is not accessible';
      this.initialized = true;
      return;
    }
    try {
      const discovered = await this.discover(this.config.executablePath);
      const effortCapabilities = discovered.effortCapabilities
        ?? (this.usesDefaultDiscovery ? (await discoverCommandCodeEfforts(this.config.executablePath)).capabilities : undefined);
      this.discoveryResult = { ...discovered, ...(effortCapabilities ? { effortCapabilities } : {}) };
      if (discovered.version !== this.config.expectedVersion) {
        this.healthStatus = 'version_mismatch';
      } else if (discovered.ambiguous.length > 0 || !COMMAND_CODE_MODELS.every((model) => discovered.models.includes(model))) {
        this.healthStatus = 'exact_model_unavailable';
      } else if (!effortCapabilities || !hasExactEffortCapabilities(effortCapabilities)) {
        this.healthStatus = 'effort_capability_unknown';
        this.discoveryDiagnostic = 'Command Code native effort capability discovery was incomplete or drifted; refusing session creation';
      } else {
        this.healthStatus = 'available';
      }
    } catch (error) {
      this.healthStatus = 'discovery_error';
      this.discoveryDiagnostic = scrubDiagnostic(error instanceof Error ? error.message : String(error));
    }
    this.initialized = true;
  }

  private discoveryResult?: CommandCodeModelDiscovery;

  async createSession(input: CommandCodeCreateInput): Promise<CommandCodeInternalSessionRecord> {
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    await this.init();
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    this.assertRunnable();
    const model = assertCommandCodeModel(input.model);
    if (!model || !this.discoveryResult?.models.includes(model)) throw new CommandCodeRuntimeError('Exact Command Code model is unavailable', 'protocol_error');
    const effortBinding = this.resolveEffort(model, input.effort);
    if (input.invocationRole === 'conductor-root' && input.permissionProfile !== 'agent-os-7f-root-readonly') throw new CommandCodeRuntimeError('Command Code root role requires the server-owned readonly profile', 'permission_denied');
    if (input.invocationRole === 'implementation-child' && input.permissionProfile !== 'implementation-child-wide') throw new CommandCodeRuntimeError('Command Code implementation-child role requires the server-owned wide profile', 'permission_denied');
    const sessionId = `commandcode-${cryptoRandomId()}`;
    const cwd = await canonicalCwd(input.cwd);
    if (this.config.allowedCwdRoots.length === 0 || !this.config.allowedCwdRoots.some((root) => isWithinRoot(root, cwd))) {
      throw new CommandCodeRuntimeError('Command Code cwd is outside the configured isolated workspace roots', 'permission_denied');
    }
    if (input.invocationRole) {
      try {
        verifyCommandCodeRoleAttestation(this.roleAttestationSecret, input.roleAttestation, { role: input.invocationRole, model, cwd, effort: effortBinding.effort });
        if (input.invocationRole === 'implementation-child') {
          const parentId = input.roleAttestation?.parentSessionId;
          const parent = parentId ? await this.store.get(parentId) : undefined;
          if (!parent || parent.invocationRole !== 'conductor-root' || parent.state === 'deleted') {
            throw new Error('Command Code implementation-child parent session is not a live conductor-root session.');
          }
        }
      } catch (error) {
        throw new CommandCodeRuntimeError(error instanceof Error ? error.message : String(error), 'permission_denied');
      }
    }
    try {
      const created = await this.store.create({
        sessionId,
        cwd,
        modelSelector: model,
        ...(effortBinding.effort ? { effort: effortBinding.effort } : {}),
        effortSource: effortBinding.source,
        ...(effortBinding.defaultEffort ? { defaultEffort: effortBinding.defaultEffort } : {}),
        effortCapabilityHash: effortBinding.capabilityHash,
        permissionProfile: input.permissionProfile,
        invocationRole: input.invocationRole,
        eventJournalRef: `events/${sessionId}.jsonl`,
      });
      if (this.ownsProcessRunner) await this.prepareNativeHome(sessionId);
      return created;
    } catch (error) {
      await this.store.delete(sessionId).catch(() => undefined);
      throw error;
    }
  }

  getEffortCapabilities(): Partial<CommandCodeEffortCapabilities> {
    const capabilities = this.discoveryResult?.effortCapabilities;
    const result: Partial<CommandCodeEffortCapabilities> = {};
    if (!capabilities) return result;
    for (const model of COMMAND_CODE_MODELS) {
      const capability = capabilities[model];
      if (capability) result[model] = { ...capability, effortLevels: [...capability.effortLevels] };
    }
    return result;
  }

  getEffortCapability(model: CommandCodeModel) {
    const capability = this.discoveryResult?.effortCapabilities?.[model];
    return capability ? { ...capability, effortLevels: [...capability.effortLevels] } : undefined;
  }

  async setEffort(sessionId: string, effort?: string): Promise<CommandCodeInternalSessionRecord> {
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    if (this.deletedSessions.has(sessionId)) throw new CommandCodeRuntimeError('Command Code session was deleted', 'runtime_error');
    if (this.pendingSessions.has(sessionId) || this.activeSessions.has(sessionId) || this.effortMutations.has(sessionId)) {
      throw new CommandCodeRuntimeError('Command Code session is already running', 'runtime_error');
    }
    this.effortMutations.add(sessionId);
    let resolveMutation!: () => void;
    const mutationSettled = new Promise<void>((resolve) => { resolveMutation = resolve; });
    this.inFlightEffortMutations.set(sessionId, mutationSettled);
    try {
      await this.init();
      this.assertRunnable();
      const record = await this.store.get(sessionId);
      if (!record) throw new CommandCodeRuntimeError('Command Code session not found', 'runtime_error');
      const binding = this.resolveEffort(record.modelSelector, effort);
      try {
        return await this.store.setEffort(sessionId, {
          ...(binding.effort ? { effort: binding.effort } : {}),
          effortSource: binding.source,
          ...(binding.defaultEffort ? { defaultEffort: binding.defaultEffort } : {}),
          effortCapabilityHash: binding.capabilityHash,
        });
      } catch (error) {
        throw new CommandCodeRuntimeError(error instanceof Error ? error.message : String(error), 'effort_unsupported');
      }
    } finally {
      this.effortMutations.delete(sessionId);
      if (this.inFlightEffortMutations.get(sessionId) === mutationSettled) this.inFlightEffortMutations.delete(sessionId);
      resolveMutation();
    }
  }

  async getSession(sessionId: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    await this.init();
    return this.store.get(sessionId);
  }

  async listSessions(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    return this.store.list();
  }

  async findSession(identifier: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    const direct = await this.getSession(identifier);
    if (direct) return direct;
    return (await this.listSessions()).find((record) => record.nativeSessionId === identifier);
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete?: (error?: Error) => void,
    runId?: string,
  ): Promise<void> {
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    if (this.deletedSessions.has(sessionId)) throw new CommandCodeRuntimeError('Command Code session was deleted', 'runtime_error');
    if (this.pendingSessions.has(sessionId) || this.activeSessions.has(sessionId) || this.effortMutations.has(sessionId)) throw new CommandCodeRuntimeError('Command Code session is already running', 'runtime_error');
    let resolveTurn!: () => void;
    const turnSettled = new Promise<void>((resolve) => { resolveTurn = resolve; });
    this.inFlightTurns.set(sessionId, turnSettled);
    this.pendingSessions.add(sessionId);
    try {
      await this.init();
      if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
      this.assertRunnable();
      const record = await this.store.get(sessionId);
      if (!record) throw new CommandCodeRuntimeError('Command Code session not found', 'runtime_error');
      if (this.deletedSessions.has(sessionId)) throw new CommandCodeRuntimeError('Command Code session was deleted', 'runtime_error');
      if (record.state === 'running' || this.runner.isRunning(sessionId)) throw new CommandCodeRuntimeError('Command Code session is already running', 'runtime_error');
      if (this.activeSessions.size >= this.config.concurrency) throw new CommandCodeRuntimeError('Command Code concurrency limit is exhausted', 'runtime_error');
      if (Buffer.byteLength(prompt, 'utf8') > this.config.maxPromptBytes) throw new CommandCodeRuntimeError('Command Code prompt exceeds byte limit', 'protocol_error');
      if (this.abortRequested.has(sessionId)) throw new CommandCodeRuntimeError('Command Code run was aborted before spawn', 'interrupted');
      this.pendingSessions.delete(sessionId);
      this.activeSessions.add(sessionId);
      const nextCount = record.messageCount + 1;
      try {
        await this.store.update(sessionId, {
        state: 'running',
        activeRunId: runId,
        messageCount: nextCount,
        firstMessage: record.firstMessage || prompt.slice(0, 4_000),
        lastMessage: prompt.slice(0, 4_000),
      });
    } catch (error) {
      this.activeSessions.delete(sessionId);
      throw error;
    }

    let completionError: Error | undefined;
    let emittedTerminal = false;
    try {
      const userMessageId = `commandcode-user-${runId ?? cryptoRandomId()}`;
      const userStart: NormalizedEvent = {
        type: 'message_start',
        sessionId,
        timestamp: Date.now(),
        data: { id: userMessageId, role: 'user', content: prompt.slice(0, 20_000) },
      };
      const userEnd: NormalizedEvent = {
        type: 'message_end',
        sessionId,
        timestamp: Date.now(),
        data: { id: userMessageId },
      };
      await this.journal.append(sessionId, userStart);
      onEvent(userStart);
      await this.journal.append(sessionId, userEnd);
      onEvent(userEnd);

      const currentCwd = await canonicalCwd(record.cwd);
      if (currentCwd !== record.cwd) throw new CommandCodeRuntimeError('Command Code cwd binding drift', 'permission_denied');
      if (this.abortRequested.has(sessionId)) throw new CommandCodeRuntimeError('Command Code run was aborted before spawn', 'interrupted');
      const result = await this.runner.run({
        sessionId,
        cwd: currentCwd,
        model: record.modelSelector,
        maxTurns: this.config.maxTurns,
        permissionProfile: record.permissionProfile,
        prompt,
        nativeSessionId: record.nativeSessionId,
        effort: record.effort,
      });
      const adapted = result.parsed
        ? adaptCommandCodeOutput({
            sessionId,
            nativeSessionId: record.nativeSessionId,
            events: result.parsed.events,
            terminal: result.parsed.terminal,
            unknownEventTypes: result.parsed.unknownEventTypes,
            suppressedDuplicateCount: result.parsed.suppressedDuplicateCount,
            bytes: result.parsed.bytes,
            lineCount: result.parsed.lineCount,
          })
        : undefined;
      if (adapted?.nativeSessionId) await this.store.bindNativeSession(sessionId, adapted.nativeSessionId);
      if (adapted) {
        for (const event of adapted.events) {
          const effectiveEffort = extractEffectiveEffort(event);
          if (effectiveEffort) {
            const capability = this.capabilityFor(record.modelSelector);
            if (!capability.effortLevels.includes(effectiveEffort.effort)) {
              throw new CommandCodeRuntimeError(`Command Code reported unsupported effective effort '${effectiveEffort.effort}'`, 'protocol_error');
            }
            await this.store.update(sessionId, {
              effectiveEffort: effectiveEffort.effort,
              effortEvidenceMethod: effectiveEffort.method,
            });
          }
          await this.journal.append(sessionId, event);
          onEvent(event);
          if (event.type === 'agent_end') emittedTerminal = true;
        }
      } else {
        const synthetic = this.syntheticEnd(sessionId, result);
        await this.journal.append(sessionId, synthetic);
        onEvent(synthetic);
        emittedTerminal = true;
      }
      completionError = classifyResult(result, adapted?.terminal);
      if (this.abortRequested.has(sessionId)) completionError = new CommandCodeRuntimeError('Command Code run was aborted', 'interrupted');
      const terminal = adapted?.terminal;
      await this.store.update(sessionId, {
        state: result.terminationCause === 'abort' || this.abortRequested.has(sessionId) ? 'aborted' : completionError ? 'failed' : 'idle',
        activeRunId: undefined,
        ...(terminal ? { lastResult: { subtype: terminal.subtype, ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}), ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}) } } : {}),
        ...(adapted ? { lastFinalText: adapted.finalText.slice(0, 20_000) } : {}),
        diagnostics: {
          suppressedDuplicateCount: result.parsed?.suppressedDuplicateCount ?? 0,
          unknownEventTypes: result.parsed?.unknownEventTypes ?? [],
          ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}),
          ...(result.protocolError ? { protocolError: result.protocolError } : {}),
          ...(adapted?.nativeSessionId ? { nativeSessionId: adapted.nativeSessionId } : {}),
          exitCode: result.exitCode,
          signal: result.signal,
          ...(result.terminationCause ? { terminationCause: result.terminationCause } : {}),
        },
      });
      // Abort can arrive after the child has closed but while the final
      // journal/session snapshot is being persisted. Re-check after the await
      // so a cancelled receipt cannot be paired with an idle/success response.
      if (this.abortRequested.has(sessionId)) {
        completionError = new CommandCodeRuntimeError('Command Code run was aborted', 'interrupted');
        await this.store.update(sessionId, { state: 'aborted', activeRunId: undefined });
      }
    } catch (error) {
      completionError = error instanceof Error ? error : new Error(String(error));
      if (!emittedTerminal) {
        const synthetic = this.syntheticEnd(sessionId, { exitCode: null, signal: null, stderrTail: '', protocolError: completionError.message });
        await this.journal.append(sessionId, synthetic).catch(() => undefined);
        onEvent(synthetic);
      }
      await this.store.update(sessionId, { state: this.abortRequested.has(sessionId) || completionError instanceof CommandCodeRuntimeError && completionError.code === 'interrupted' ? 'aborted' : 'failed', activeRunId: undefined, diagnostics: { suppressedDuplicateCount: 0, unknownEventTypes: [], protocolError: completionError.message, ...(this.abortRequested.has(sessionId) ? { terminationCause: 'abort' as const } : {}) } }).catch(() => undefined);
    }
    this.activeSessions.delete(sessionId);
    onComplete?.(completionError);
    } finally {
      this.pendingSessions.delete(sessionId);
      this.activeSessions.delete(sessionId);
      this.abortRequested.delete(sessionId);
      if (this.inFlightTurns.get(sessionId) === turnSettled) this.inFlightTurns.delete(sessionId);
      resolveTurn();
    }
  }

  async getReplayEvents(sessionId: string): Promise<NormalizedEvent[]> {
    await this.init();
    if (!await this.store.get(sessionId)) throw new CommandCodeRuntimeError('Command Code session not found');
    return this.journal.read(sessionId);
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.pendingSessions.has(sessionId) && !this.activeSessions.has(sessionId)) return;
    this.abortRequested.add(sessionId);
    await this.runner.abort(sessionId);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.deletedSessions.add(sessionId);
    this.abortRequested.add(sessionId);
    try {
      const inFlight = this.inFlightTurns.get(sessionId);
      const effortMutation = this.inFlightEffortMutations.get(sessionId);
      await this.runner.abort(sessionId);
      if (inFlight) await inFlight;
      if (effortMutation) await effortMutation;
      this.pinned.delete(sessionId);
      await this.journal.clear(sessionId).catch(() => undefined);
      if (this.ownsProcessRunner) await rm(path.join(this.config.nativeHomeDir, sessionId), { recursive: true, force: true }).catch(() => undefined);
      return await this.store.delete(sessionId);
    } finally {
      this.deletedSessions.delete(sessionId);
      this.abortRequested.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const sessionId of this.pendingSessions) this.abortRequested.add(sessionId);
    for (const sessionId of this.activeSessions) this.abortRequested.add(sessionId);
    const inFlights = [...this.inFlightTurns.values(), ...this.inFlightEffortMutations.values()];
    this.shutdownPromise = (async () => {
      try {
        await this.runner.shutdown();
      } finally {
        await Promise.allSettled(inFlights);
      }
    })();
    return this.shutdownPromise;
  }

  setRoleAttestationSecret(secret: string): void { this.roleAttestationSecret = secret || undefined; }
  isRunning(sessionId: string): boolean { return this.runner.isRunning(sessionId); }
  async hasSession(sessionId: string): Promise<boolean> { return Boolean(await this.store.get(sessionId)); }
  isEnabled(): boolean { return this.config.enabled; }
  isAvailable(): boolean { return this.healthStatus === 'available'; }
  getExecutionInstanceId(): 'commandcode-default' { return COMMAND_CODE_EXECUTION_INSTANCE_ID; }
  getModels(): Array<{
    id: CommandCodeModel;
    displayName: string;
    provider: string;
    reasoning: boolean;
    supportsEffort: boolean;
    effortLevels: CommandCodeEffort[];
    defaultEffort?: CommandCodeEffort;
    effortCapabilityHash?: string;
  }> {
    const available = this.discoveryResult?.models ?? [];
    return available.map((id) => {
      const capability = this.discoveryResult?.effortCapabilities?.[id];
      return {
        id,
        displayName: id === 'qwen/qwen3.8-max' ? 'Qwen 3.8 Max' : 'Muse Spark 1.2 Contributor',
        provider: COMMAND_CODE_PROVIDER,
        reasoning: true,
        supportsEffort: capability?.supportsEffort === true,
        effortLevels: [...(capability?.effortLevels ?? [])],
        ...(capability?.defaultEffort ? { defaultEffort: capability.defaultEffort } : {}),
        ...(capability?.capabilityHash ? { effortCapabilityHash: capability.capabilityHash } : {}),
      };
    });
  }
  getHealth(): CommandCodeHealth {
    const missingModels = COMMAND_CODE_MODELS.filter((model) => !this.discoveryResult?.models.includes(model));
    return {
      enabled: this.config.enabled,
      available: this.isAvailable(),
      status: this.healthStatus,
      ...(this.discoveryResult?.version ? { version: this.discoveryResult.version } : {}),
      expectedVersion: this.config.expectedVersion,
      advertisedModels: [...(this.discoveryResult?.models ?? [])],
      missingModels,
      effortCapabilities: this.getEffortCapabilities(),
      checkedAt: new Date().toISOString(),
      ...(this.discoveryDiagnostic ? { diagnostic: this.discoveryDiagnostic } : {}),
    };
  }
  getSessionDiagnostics(sessionId: string): Promise<CommandCodeInternalSessionRecord['diagnostics'] | undefined> {
    return this.store.get(sessionId).then((record) => record?.diagnostics);
  }
  pinSession(sessionId: string): boolean { this.pinned.add(sessionId); return true; }
  unpinSession(sessionId: string): boolean { return this.pinned.delete(sessionId); }
  isSessionPinned(sessionId: string): boolean { return this.pinned.has(sessionId); }

  private resolveEffort(model: CommandCodeModel, requested: unknown): {
    effort?: CommandCodeEffort;
    source: 'explicit' | 'default' | 'none';
    defaultEffort?: CommandCodeEffort;
    capabilityHash: string;
  } {
    const capability = this.capabilityFor(model);
    if (capability.status === 'unknown') {
      throw new CommandCodeRuntimeError(`Command Code effort capability is unknown for model ${model}`, 'effort_unsupported');
    }
    if (!capability.supportsEffort) {
      if (requested !== undefined) throw new CommandCodeRuntimeError(`Command Code model ${model} does not support native effort`, 'effort_unsupported');
      return { source: 'none', capabilityHash: capability.capabilityHash };
    }
    if (requested !== undefined) {
      let effort: CommandCodeEffort;
      try { effort = assertCommandCodeEffort(model, requested) as CommandCodeEffort; }
      catch (error) { throw new CommandCodeRuntimeError(error instanceof Error ? error.message : String(error), 'effort_unsupported'); }
      if (!capability.effortLevels.includes(effort)) throw new CommandCodeRuntimeError(`Command Code effort '${effort}' is not advertised for model ${model}`, 'effort_unsupported');
      return { effort, source: 'explicit', ...(capability.defaultEffort ? { defaultEffort: capability.defaultEffort } : {}), capabilityHash: capability.capabilityHash };
    }
    if (!capability.defaultEffort || !capability.effortLevels.includes(capability.defaultEffort)) {
      throw new CommandCodeRuntimeError(`Command Code default effort is unknown for model ${model}`, 'effort_unsupported');
    }
    return { effort: capability.defaultEffort, source: 'default', defaultEffort: capability.defaultEffort, capabilityHash: capability.capabilityHash };
  }

  private capabilityFor(model: CommandCodeModel) {
    const capability = this.discoveryResult?.effortCapabilities?.[model];
    if (!capability) throw new CommandCodeRuntimeError(`Command Code effort capability is unavailable for model ${model}`, 'effort_unsupported');
    return capability;
  }

  private async prepareNativeHomeRoot(): Promise<void> {
    await mkdir(this.config.nativeHomeDir, { recursive: true, mode: 0o700 });
  }

  private async prepareNativeHome(sessionId: string): Promise<void> {
    await this.prepareNativeHomeRoot();
    const sessionHome = path.join(this.config.nativeHomeDir, sessionId);
    const commandCodeHome = path.join(sessionHome, '.commandcode');
    await mkdir(commandCodeHome, { recursive: true, mode: 0o700 });
    const source = path.join(process.env.HOME || '/root', '.commandcode', 'auth.json');
    const target = path.join(commandCodeHome, 'auth.json');
    try {
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile()) return;
      try {
        const targetStat = await lstat(target);
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error('Command Code private auth binding drift');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      // Copy the operator's credential into the session-owned native home. A
      // symlink would let concurrent native invocations mutate one shared
      // auth/config tree and would make per-session isolation illusory.
      const temporary = `${target}.${process.pid}.tmp`;
      await copyFile(source, temporary);
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private assertRunnable(): void {
    if (!this.config.enabled) throw new CommandCodeRuntimeError('Command Code runtime is disabled', 'runtime_error');
    if (this.healthStatus !== 'available') throw new CommandCodeRuntimeError(`Command Code runtime is ${this.healthStatus}`, 'runtime_error');
  }

  private syntheticEnd(sessionId: string, result: CommandCodeProcessRunResult): NormalizedEvent {
    return {
      type: 'agent_end',
      sessionId,
      timestamp: Date.now(),
      data: {
        synthetic: true,
        subtype: result.terminationCause === 'abort' ? 'error' : 'error',
        reason: result.protocolError ?? result.spawnError ?? result.terminationCause ?? 'no_terminal_result',
        exitCode: result.exitCode,
      },
    };
  }
}

function hasExactEffortCapabilities(capabilities: CommandCodeEffortCapabilities): boolean {
  if (JSON.stringify(Object.keys(capabilities).sort()) !== JSON.stringify([...COMMAND_CODE_MODELS].sort())) return false;
  return COMMAND_CODE_MODELS.every((model) => {
    const capability = capabilities[model];
    const expectedLevels = COMMAND_CODE_EFFORT_LEVELS_BY_MODEL[model];
    return Boolean(capability)
      && capability.status !== 'unknown'
      && capability.source === 'live-preflight'
      && /^[a-f0-9]{64}$/.test(capability.capabilityHash)
      && capability.supportsEffort === (expectedLevels.length > 0)
      && JSON.stringify(capability.effortLevels) === JSON.stringify(expectedLevels)
      && (expectedLevels.length === 0 ? capability.defaultEffort === undefined : capability.defaultEffort === 'medium');
  });
}

function extractEffectiveEffort(event: NormalizedEvent): { effort: CommandCodeEffort; method: 'provider-event' | 'provider-result' } | undefined {
  if (event.type !== 'model_request_end' && event.type !== 'agent_end') return undefined;
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined;
  const value = data?.effort ?? data?.effectiveEffort ?? data?.reasoningEffort;
  if (typeof value !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) return undefined;
  return {
    effort: value as CommandCodeEffort,
    method: data?.effortEvidenceMethod === 'provider-result' ? 'provider-result' : 'provider-event',
  };
}

function classifyResult(result: CommandCodeProcessRunResult, terminal?: { subtype: 'success' | 'error' | 'max_turns' }): Error | undefined {
  if (result.protocolError) return new CommandCodeRuntimeError(result.protocolError, 'protocol_error');
  if (result.terminationCause === 'abort') return new CommandCodeRuntimeError('Command Code run was aborted', 'interrupted');
  if (result.terminationCause === 'timeout') return new CommandCodeRuntimeError('Command Code run timed out', 'interrupted');
  if (result.spawnError) return new CommandCodeRuntimeError(result.spawnError, 'runtime_error');
  if (result.exitCode !== 0) {
    const exitClass = exitCodeClass(result.exitCode);
    if (exitClass !== 'runtime_error' || !terminal || terminal.subtype !== 'success') {
      return new CommandCodeRuntimeError(`Command Code exited with code ${result.exitCode ?? result.signal ?? 'unknown'}`, exitClass);
    }
  }
  if (!terminal) return new CommandCodeRuntimeError('Command Code produced no terminal result', 'no_response');
  if (terminal.subtype === 'max_turns') return new CommandCodeRuntimeError('Command Code reached max turns', 'max_turns');
  if (terminal.subtype === 'error') return new CommandCodeRuntimeError('Command Code returned an error result', 'runtime_error');
  return undefined;
}

function exitCodeClass(code: number | null): CommandCodeErrorClass {
  switch (code) {
    case 3: return 'auth_required';
    case 4: return 'permission_denied';
    case 5: return 'rate_limited';
    case 6: return 'network_failure';
    case 7: return 'provider_failure';
    case 8: return 'max_turns';
    case 9: return 'no_response';
    case 10: return 'credits';
    case 130: return 'interrupted';
    default: return 'runtime_error';
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function scrubDiagnostic(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]').slice(0, 320);
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

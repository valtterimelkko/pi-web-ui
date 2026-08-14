import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { CommandCodeCatalogueMetadata, NormalizedEvent } from '@pi-web-ui/shared';
import {
  COMMAND_CODE_EXECUTION_INSTANCE_ID,
  defaultCommandCodeConfig,
  type CommandCodePermissionProfile,
  type CommandCodeRuntimeConfig,
} from './command-code-config.js';
import {
  COMMAND_CODE_MODELS,
  COMMAND_CODE_FULL_MODEL_CATALOGUE,
  COMMAND_CODE_PROVIDER,
  COMMAND_CODE_EFFORT_LEVELS,
  COMMAND_CODE_EFFORT_LEVELS_BY_MODEL,
  validateCommandCodeModelCatalogue,
  assertCommandCodeModel,
  assertCommandCodeRuntimeModel,
  assertCommandCodeEffort,
  discoverCommandCodeEfforts,
  discoverCommandCodeModels,
  type CommandCodeEffort,
  type CommandCodeEffortCapability,
  type CommandCodeEffortCapabilities,
  type CommandCodeRuntimeModel,
  type CommandCodeModel,
  type CommandCodeModelDiscovery,
  type CommandCodeDiscoveryRunner,
} from './command-code-model-catalog.js';
import {
  adaptCommandCodeEvent,
  adaptCommandCodeOutput,
  createCommandCodeIncrementalAdapterState,
} from './command-code-event-adapter.js';
import { verifyCommandCodeRoleAttestation, type CommandCodeRoleAttestation } from './command-code-role-attestation.js';
import { CommandCodeEventJournal } from './command-code-event-journal.js';
import {
  CommandCodeProcessRunner,
  type CommandCodeProcessRunInput,
  type CommandCodeProcessRunResult,
} from './command-code-process-runner.js';
import type { SessionRegistryManager } from '../session-registry.js';
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
  /** Retained for compatibility with older clients; live readiness no longer emits this state. */
  | 'version_mismatch'
  | 'exact_model_unavailable'
  | 'effort_capability_unknown'
  | 'available';

export interface CommandCodeHealth {
  enabled: boolean;
  available: boolean;
  status: CommandCodeAvailability;
  version?: string;
  /** Legacy diagnostic override; it is not used as an execution gate. */
  expectedVersion?: string;
  advertisedModels: CommandCodeRuntimeModel[];
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
  /** Legacy diagnostic override; it is not used as an execution gate. */
  expectedVersion?: string;
}

export interface CommandCodeCreateInput {
  cwd: string;
  model: CommandCodeRuntimeModel;
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

type RunnerLike = Pick<CommandCodeProcessRunner, 'run' | 'abort' | 'shutdown' | 'isRunning'> & {
  browserSandboxReady?: () => boolean;
  setBrowserPolicyRoots?: (
    allowedCwdRoots: string[],
    runtimeRoots: string[],
    nativeHomeDir?: string,
    expected?: { allowed: { dev: number; ino: number }[]; runtime: { dev: number; ino: number }[]; nativeHome: { dev: number; ino: number } },
  ) => void;
  pinExecutable?: (executablePath?: string, expected?: { dev: number; ino: number }) => void;
  pinBrowserSandbox?: (sandboxExecutablePath?: string, expected?: { dev: number; ino: number }) => void;
};

export class CommandCodeService {
  readonly config: CommandCodeRuntimeConfig;
  readonly store: CommandCodeSessionStore;
  readonly journal: CommandCodeEventJournal;
  private readonly runner: RunnerLike;
  private readonly ownsProcessRunner: boolean;
  private readonly discover: CommandCodeDiscoveryRunner;
  private readonly discoverEfforts?: typeof discoverCommandCodeEfforts;
  private readonly usesDefaultDiscovery: boolean;
  private discovery?: CommandCodeModelDiscovery;
  private discoveryDiagnostic?: string;
  private discoveryCheckedAt?: string;
  private healthStatus: CommandCodeAvailability = 'disabled';
  private initialized = false;
  private initPromise?: Promise<void>;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  /** Runtime keepalive claims keyed per session, matching other runtimes' claim semantics. */
  private readonly pinClaims = new Map<string, Set<string>>();
  private readonly pendingSessions = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private readonly effortMutations = new Set<string>();
  private readonly abortRequested = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly inFlightTurns = new Map<string, Promise<void>>();
  private readonly inFlightEffortMutations = new Map<string, Promise<void>>();
  private readonly apiObservers = new Map<string, Set<(event: NormalizedEvent) => void>>();
  private roleAttestationSecret?: string;

  private readonly sessionRegistry?: SessionRegistryManager;
  private registryProjectionError?: string;
  private browserPolicyReady = false;
  private browserAuthHandle?: Awaited<ReturnType<typeof open>>;
  private browserAuthIdentity?: { dev: number; ino: number };
  private executableIdentity?: { dev: number; ino: number };
  private browserSandboxIdentity?: { dev: number; ino: number };

  constructor(options: {
    config: CommandCodeServiceConfig;
    runner?: RunnerLike;
    discover?: CommandCodeDiscoveryRunner;
    /** Optional effort-discovery seam for deterministic bounded validation. */
    discoverEfforts?: typeof discoverCommandCodeEfforts;
    checkExecutable?: boolean;
    sessionRegistry?: SessionRegistryManager;
  }) {
    const mergedConfig = { ...defaultCommandCodeConfig(options.config), ...options.config };
    if (!options.config.nativeHomeDir) mergedConfig.nativeHomeDir = path.join(mergedConfig.stateDir, 'native-home');
    this.config = {
      ...mergedConfig,
      allowedCwdRoots: options.config.allowedCwdRoots ?? [path.dirname(mergedConfig.stateDir)],
      browserAllowedCwdRoots: options.config.browserAllowedCwdRoots ?? [],
      browserRuntimeRoots: options.config.browserRuntimeRoots ?? [],
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
      browserSandboxExecutablePath: this.config.browserSandboxExecutablePath,
      browserAllowedCwdRoots: this.config.browserAllowedCwdRoots,
      browserRuntimeRoots: this.config.browserRuntimeRoots,
    });
    this.usesDefaultDiscovery = !options.discover;
    this.discover = options.discover ?? discoverCommandCodeModels;
    this.discoverEfforts = options.discoverEfforts;
    this.checkExecutable = options.checkExecutable ?? true;
    this.sessionRegistry = options.sessionRegistry;
  }

  private readonly checkExecutable: boolean;

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize().finally(() => {
      // One immutable timestamp per initial discovery attempt makes freshness
      // evidence meaningful across every projection instead of changing on
      // each read of getHealth().
      this.discoveryCheckedAt ??= new Date().toISOString();
    });
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await this.store.init();
    for (const invalidSessionId of this.store.listInvalidSessionIds()) {
      await rm(path.join(this.config.nativeHomeDir, invalidSessionId), { recursive: true, force: true }).catch(() => undefined);
    }
    await this.store.reconcileAfterRestart();
    const privateRecords = await this.store.list();
    if (this.sessionRegistry) {
      // Rebuild the public projection only after discovery and browser-policy
      // checks complete. In particular, a persisted browser session must not
      // remain discoverable after the browser gate is disabled or its policy
      // becomes invalid between restarts.
      try {
        for (const entry of await this.sessionRegistry.listBySdkType('commandcode')) {
          await this.sessionRegistry.delete(entry.id).catch(() => undefined);
        }
      } catch {
        // Registry projection is best-effort; the private store remains the
        // Command Code source of truth and every public lookup is gated below.
      }
    }
    if (!this.config.enabled && !this.config.browserEnabled) {
      for (const record of privateRecords) {
        if (record.permissionProfile === 'browser-contained') {
          await rm(path.join(this.config.nativeHomeDir, record.sessionId), { recursive: true, force: true }).catch(() => undefined);
        }
      }
      this.healthStatus = 'disabled';
      this.initialized = true;
      return;
    }
    if (this.ownsProcessRunner) {
      await this.prepareNativeHomeRoot();
      for (const record of await this.store.list()) {
        // Native shadow sessions may be rehydrated into their private homes;
        // browser sessions are prepared lazily only after the browser policy is
        // validated, so a disabled/invalid browser gate cannot copy credentials.
        if (record.permissionProfile !== 'browser-contained') {
          await this.prepareNativeHome(record.sessionId, record.permissionProfile);
        }
      }
    }
    try {
      if (this.checkExecutable) {
        const canonicalExecutable = await realpath(this.config.executablePath);
        const executableStat = await stat(canonicalExecutable);
        if (!executableStat.isFile()) throw new Error('Command Code executable is not a regular file');
        await access(canonicalExecutable, fsConstants.X_OK);
        this.executableIdentity = { dev: executableStat.dev, ino: executableStat.ino };
        this.config.executablePath = canonicalExecutable;
      }
      if (this.config.browserEnabled) await this.validateBrowserPolicy();
      if (this.ownsProcessRunner) this.runner.pinExecutable?.(this.config.executablePath, this.executableIdentity);
    } catch {
      await this.browserAuthHandle?.close().catch(() => undefined);
      this.browserAuthHandle = undefined;
      this.browserAuthIdentity = undefined;
      this.browserPolicyReady = false;
      this.runner.setBrowserPolicyRoots?.([], [], this.config.nativeHomeDir);
      await this.removeInaccessibleBrowserHomes();
      this.healthStatus = 'executable_missing';
      this.discoveryDiagnostic = 'Configured Command Code executable is not accessible';
      this.initialized = true;
      return;
    }
    try {
      const discovered = await this.discover(this.config.executablePath);
      let effortCapabilities = discovered.effortCapabilities;
      let effortDiscoveryDiagnostic: string | undefined;
      if (!effortCapabilities && (this.usesDefaultDiscovery || this.discoverEfforts)) {
        try {
          // Extra live catalogue entries remain evidence-only, but the exact
          // shadow pair must always receive exhaustive probes. The bounded
          // invalid-value probe is used for every other model so a catalogue
          // update cannot silently weaken the shadow contract or turn startup
          // into an unbounded N×probe operation.
          effortCapabilities = (await (this.discoverEfforts ?? discoverCommandCodeEfforts)(this.config.executablePath, {
            models: discovered.models,
            probeAllValues: false,
            probeAllValuesForModels: COMMAND_CODE_MODELS,
          })).capabilities;
        } catch (error) {
          // Model discovery and effort discovery are separate evidence layers.
          // Preserve the complete model catalogue when the bounded hybrid
          // effort pass times out, cannot spawn, or emits malformed output;
          // only execution authority is withdrawn.
          effortDiscoveryDiagnostic = scrubDiagnostic(error instanceof Error ? error.message : String(error));
        }
      }
      this.discoveryResult = { ...discovered, ...(effortCapabilities ? { effortCapabilities } : {}) };
      const catalogueValidation = this.usesDefaultDiscovery
        ? validateCommandCodeModelCatalogue(discovered.models)
        : { valid: true as const };
      if (!catalogueValidation.valid) {
        this.healthStatus = 'exact_model_unavailable';
        this.discoveryDiagnostic = `Command Code model catalogue is invalid: ${catalogueValidation.reason}`;
      } else if (discovered.ambiguous.length > 0 || discovered.models.length === 0) {
        this.healthStatus = 'exact_model_unavailable';
      } else if (effortDiscoveryDiagnostic || !effortCapabilities || !hasExactEffortCapabilities(effortCapabilities, discovered.models)) {
        this.healthStatus = 'effort_capability_unknown';
        this.discoveryDiagnostic = effortDiscoveryDiagnostic
          ? `Command Code native effort capability discovery failed: ${effortDiscoveryDiagnostic}`
          : 'Command Code native effort capability discovery was incomplete or drifted; refusing session creation';
      } else {
        this.healthStatus = 'available';
      }
    } catch (error) {
      this.healthStatus = 'discovery_error';
      this.discoveryDiagnostic = scrubDiagnostic(error instanceof Error ? error.message : String(error));
    }
    if (this.ownsProcessRunner && this.isBrowserAvailable()) {
      for (const record of await this.store.list()) {
        if (record.permissionProfile === 'browser-contained' && this.isSessionRecordAccessible(record)) await this.prepareNativeHome(record.sessionId, record.permissionProfile);
      }
    }
    await this.removeInaccessibleBrowserHomes();
    for (const record of await this.store.list()) {
      if (record.permissionProfile === 'browser-contained' && !this.isSessionRecordAccessible(record)) {
        const staleSessionId = (record as CommandCodeInternalSessionRecord).sessionId;
        await rm(path.join(this.config.nativeHomeDir, staleSessionId), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (this.isSessionRecordAccessible(record)) await this.syncRegistryRecord(record);
    }
    this.initialized = true;
  }

  private discoveryResult?: CommandCodeModelDiscovery;

  async createSession(input: CommandCodeCreateInput): Promise<CommandCodeInternalSessionRecord> {
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    await this.init();
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    this.assertRunnable();
    if (input.permissionProfile !== 'browser-contained' && !this.isShadowAvailable()) {
      throw new CommandCodeRuntimeError('Command Code shadow catalogue is unavailable under the active policy', 'protocol_error');
    }
    const model = assertCommandCodeRuntimeModel(input.model, this.discoveryResult?.models ?? []);
    if (!model) throw new CommandCodeRuntimeError('Exact Command Code model is unavailable', 'protocol_error');
    if (input.permissionProfile !== 'browser-contained' && !assertCommandCodeModel(model)) {
      throw new CommandCodeRuntimeError('Command Code shadow sessions require one of the exact policy-approved model ids', 'permission_denied');
    }
    const effortBinding = this.resolveEffort(model, input.effort);
    if (input.permissionProfile === 'browser-contained') {
      if (input.invocationRole) throw new CommandCodeRuntimeError('Browser Command Code sessions cannot carry Agent OS invocation roles', 'permission_denied');
      if (!this.isBrowserAvailable()) {
        throw new CommandCodeRuntimeError('Command Code browser containment is unavailable', 'permission_denied');
      }
      if (!this.isBrowserModelAllowed(model)) {
        throw new CommandCodeRuntimeError(`Command Code model ${model} is not approved for browser use`, 'permission_denied');
      }
    }
    if (input.invocationRole === 'conductor-root' && input.permissionProfile !== 'agent-os-7f-root-readonly') throw new CommandCodeRuntimeError('Command Code root role requires the server-owned readonly profile', 'permission_denied');
    if (input.invocationRole === 'implementation-child' && input.permissionProfile !== 'implementation-child-wide') throw new CommandCodeRuntimeError('Command Code implementation-child role requires the server-owned wide profile', 'permission_denied');
    const sessionId = `commandcode-${cryptoRandomId()}`;
    const cwd = await canonicalCwd(input.cwd);
    const cwdRoots = input.permissionProfile === 'browser-contained'
      ? (this.config.browserAllowedCwdRoots ?? [])
      : this.config.allowedCwdRoots;
    if (cwdRoots.length === 0 || !cwdRoots.some((root) => isWithinRoot(root, cwd))) {
      throw new CommandCodeRuntimeError('Command Code cwd is outside the configured isolated workspace roots', 'permission_denied');
    }
    if (input.invocationRole) {
      try {
        const attestedModel = assertCommandCodeModel(model);
        if (!attestedModel) throw new Error('Agent OS role attestations are restricted to the shadow model routes.');
        verifyCommandCodeRoleAttestation(this.roleAttestationSecret, input.roleAttestation, { role: input.invocationRole, model: attestedModel, cwd, effort: effortBinding.effort });
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
      if (this.ownsProcessRunner) await this.prepareNativeHome(sessionId, input.permissionProfile);
      await this.syncRegistryRecord(created);
      return created;
    } catch (error) {
      await this.store.delete(sessionId).catch(() => undefined);
      throw error;
    }
  }

  getEffortCapabilities(): CommandCodeEffortCapabilities {
    const capabilities = this.discoveryResult?.effortCapabilities;
    const result: CommandCodeEffortCapabilities = {};
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return result;
    for (const [model, capability] of Object.entries(capabilities)) {
      if (isSafeEffortCapability(capability)) result[model] = { ...capability, effortLevels: [...capability.effortLevels] };
    }
    return result;
  }

  getEffortCapability(model: CommandCodeRuntimeModel): CommandCodeEffortCapability | undefined {
    const capability = this.discoveryResult?.effortCapabilities?.[model];
    return isSafeEffortCapability(capability)
      ? { ...capability, effortLevels: [...capability.effortLevels] }
      : undefined;
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
      if (!this.isSessionRecordAccessible(record)) {
        throw new CommandCodeRuntimeError('Command Code session is no longer enabled by the active runtime policy', 'permission_denied');
      }
      const binding = this.resolveEffort(record.modelSelector, effort);
      try {
        const updated = await this.store.setEffort(sessionId, {
          ...(binding.effort ? { effort: binding.effort } : {}),
          effortSource: binding.source,
          ...(binding.defaultEffort ? { defaultEffort: binding.defaultEffort } : {}),
          effortCapabilityHash: binding.capabilityHash,
        });
        await this.syncRegistryRecord(updated);
        return updated;
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
    const record = await this.store.get(sessionId);
    return this.isSessionRecordAccessible(record) ? record : undefined;
  }

  /** Internal API / Agent OS may see only the attested shadow profile. */
  async getShadowSession(sessionId: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    await this.init();
    const record = await this.store.get(sessionId);
    return record && record.permissionProfile !== 'browser-contained' && this.isSessionRecordAccessible(record)
      ? record
      : undefined;
  }

  async listSessions(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    if (!this.isShadowEnabled() && !this.config.browserEnabled) return [];
    return (await this.store.list()).filter((record) => this.isSessionRecordAccessible(record));
  }

  async listShadowSessions(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    if (!this.isShadowAvailable()) return [];
    return (await this.store.list()).filter((record) => record.permissionProfile !== 'browser-contained' && this.isSessionRecordAccessible(record));
  }

  async listBrowserSessions(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    if (!this.isBrowserAvailable()) return [];
    return (await this.store.list()).filter((record) => this.isSessionRecordAccessible(record) && this.isBrowserSessionRecord(record));
  }

  async isBrowserSession(sessionId: string): Promise<boolean> {
    await this.init();
    const record = await this.store.get(sessionId);
    return Boolean(record && this.isSessionRecordAccessible(record) && this.isBrowserSessionRecord(record));
  }

  /** Browser/WebSocket lookups must never fall back to the shadow-inclusive accessor. */
  async getBrowserSession(sessionId: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    await this.init();
    const record = await this.store.get(sessionId);
    return record && this.isSessionRecordAccessible(record) && this.isBrowserSessionRecord(record) ? record : undefined;
  }

  async isSessionAccessible(sessionId: string): Promise<boolean> {
    await this.init();
    return this.isSessionRecordAccessible(await this.store.get(sessionId));
  }

  async findSession(identifier: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    const direct = await this.getSession(identifier);
    if (direct) return direct;
    return (await this.listSessions()).find((record) => record.nativeSessionId === identifier);
  }

  async findShadowSession(identifier: string): Promise<CommandCodeInternalSessionRecord | undefined> {
    const direct = await this.getShadowSession(identifier);
    if (direct) return direct;
    return (await this.listShadowSessions()).find((record) => record.nativeSessionId === identifier);
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
      if (!this.isSessionRecordAccessible(record)) throw new CommandCodeRuntimeError('Command Code session is no longer enabled by the active runtime policy', 'permission_denied');
      if (this.deletedSessions.has(sessionId)) throw new CommandCodeRuntimeError('Command Code session was deleted', 'runtime_error');
      const discoveredModel = assertCommandCodeRuntimeModel(record.modelSelector, this.discoveryResult?.models ?? []);
      if (!discoveredModel) throw new CommandCodeRuntimeError('Command Code session model is no longer advertised', 'protocol_error');
      const capability = this.capabilityFor(discoveredModel);
      if (!record.effortCapabilityHash || record.effortCapabilityHash !== capability.capabilityHash) {
        throw new CommandCodeRuntimeError('Command Code effort capability changed; recreate the session', 'effort_unsupported');
      }
      if (record.permissionProfile === 'browser-contained' && !this.isBrowserModelAllowed(record.modelSelector)) {
        throw new CommandCodeRuntimeError('Command Code browser policy no longer permits this session model', 'permission_denied');
      }
      if (record.state === 'running' || this.runner.isRunning(sessionId)) throw new CommandCodeRuntimeError('Command Code session is already running', 'runtime_error');
      if (this.activeSessions.size >= this.config.concurrency) throw new CommandCodeRuntimeError('Command Code concurrency limit is exhausted', 'runtime_error');
      if (Buffer.byteLength(prompt, 'utf8') > this.config.maxPromptBytes) throw new CommandCodeRuntimeError('Command Code prompt exceeds byte limit', 'protocol_error');
      if (this.abortRequested.has(sessionId)) throw new CommandCodeRuntimeError('Command Code run was aborted before spawn', 'interrupted');
      this.pendingSessions.delete(sessionId);
      this.activeSessions.add(sessionId);
      const nextCount = record.messageCount + 1;
      try {
        const runningRecord = await this.store.update(sessionId, {
        state: 'running',
        activeRunId: runId,
        messageCount: nextCount,
        firstMessage: record.firstMessage || prompt.slice(0, 4_000),
        lastMessage: prompt.slice(0, 4_000),
      });
      await this.syncRegistryRecord(runningRecord);
    } catch (error) {
      this.activeSessions.delete(sessionId);
      throw error;
    }

    let completionError: Error | undefined;
    let emittedTerminal = false;
    const streamState = createCommandCodeIncrementalAdapterState();
    const streamedEvents: NormalizedEvent[] = [];
    let streamQueue = Promise.resolve();
    const observedAt = Date.now();
    const queueStreamEvent = (parsed: Parameters<NonNullable<CommandCodeProcessRunInput['onEvent']>>[0]): void => {
      const event = adaptCommandCodeEvent({ sessionId, parsed, state: streamState, observedAt });
      if (!event) return;
      // The native stream can emit turn/run/session end markers before the
      // terminal result frame. Hold every normalized terminal marker back: the
      // final adapter emits one authoritative agent_end carrying terminal
      // effort and usage evidence, avoiding duplicate or under-specified
      // receipts when the early marker lacks those fields.
      if (event.type === 'agent_end') return;
      streamedEvents.push(event);
      streamQueue = streamQueue.then(async () => {
        await this.recordEffectiveEffort(sessionId, record.modelSelector, event);
        await this.journal.append(sessionId, event);
        this.publishApiEvent(sessionId, event);
        onEvent(event);
        if (event.type === 'agent_end') emittedTerminal = true;
      });
    };
    try {
      const agentStart: NormalizedEvent = {
        type: 'agent_start',
        sessionId,
        timestamp: Date.now(),
        data: { runtime: 'commandcode', runId },
      };
      await this.journal.append(sessionId, agentStart);
      this.publishApiEvent(sessionId, agentStart);
      onEvent(agentStart);

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
      this.publishApiEvent(sessionId, userStart);
      onEvent(userStart);
      await this.journal.append(sessionId, userEnd);
      this.publishApiEvent(sessionId, userEnd);
      onEvent(userEnd);

      const currentCwd = await canonicalCwd(record.cwd);
      if (currentCwd !== record.cwd) throw new CommandCodeRuntimeError('Command Code cwd binding drift', 'permission_denied');
      const activeCwdRoots = record.permissionProfile === 'browser-contained'
        ? (this.config.browserAllowedCwdRoots ?? [])
        : this.config.allowedCwdRoots;
      if (!activeCwdRoots.some((root) => isWithinRoot(root, currentCwd))) {
        throw new CommandCodeRuntimeError('Command Code cwd is outside the active workspace policy', 'permission_denied');
      }
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
        ...(record.permissionProfile === 'browser-contained'
          ? { browserAuthFd: this.browserAuthHandle?.fd, browserAuthIdentity: this.browserAuthIdentity }
          : {}),
        onEvent: queueStreamEvent,
      });
      await streamQueue;
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
      if (adapted?.nativeSessionId) {
        const bound = await this.store.bindNativeSession(sessionId, adapted.nativeSessionId);
        await this.syncRegistryRecord(bound);
      }
      if (adapted) {
        // The parser has already delivered visible events incrementally. The
        // final adapter is still authoritative for terminal metadata and any
        // terminal-only text, but must not replay the streamed prefix. Match
        // by stable type/data counts rather than array length: unknown native
        // frames and non-visible events make a positional slice unsafe.
        const streamedKeys = new Map<string, number>();
        for (const streamedEvent of streamedEvents) {
          const key = normalizedEventKey(streamedEvent);
          streamedKeys.set(key, (streamedKeys.get(key) ?? 0) + 1);
        }
        for (const event of adapted.events) {
          if (event.type === 'agent_end' && emittedTerminal) continue;
          const key = normalizedEventKey(event);
          const remaining = streamedKeys.get(key) ?? 0;
          if (remaining > 0) {
            streamedKeys.set(key, remaining - 1);
            continue;
          }
          await this.recordEffectiveEffort(sessionId, record.modelSelector, event);
          await this.journal.append(sessionId, event);
          this.publishApiEvent(sessionId, event);
          onEvent(event);
          if (event.type === 'agent_end') emittedTerminal = true;
        }
      } else {
        const synthetic = this.syntheticEnd(sessionId, result);
        await this.journal.append(sessionId, synthetic);
        this.publishApiEvent(sessionId, synthetic);
        onEvent(synthetic);
        emittedTerminal = true;
      }
      completionError = classifyResult(result, adapted?.terminal);
      if (this.abortRequested.has(sessionId)) completionError = new CommandCodeRuntimeError('Command Code run was aborted', 'interrupted');
      const terminal = adapted?.terminal;
      const completedRecord = await this.store.update(sessionId, {
        state: result.terminationCause === 'abort' || this.abortRequested.has(sessionId) ? 'aborted' : completionError ? 'failed' : 'idle',
        activeRunId: undefined,
        ...(terminal ? { lastResult: { subtype: terminal.subtype, ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}), ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}) } } : {}),
        ...(adapted ? { lastFinalText: scrubDiagnostic(adapted.finalText) } : {}),
        diagnostics: {
          suppressedDuplicateCount: result.parsed?.suppressedDuplicateCount ?? 0,
          unknownEventTypes: result.parsed?.unknownEventTypes ?? [],
          ...(result.stderrTail ? { stderrTail: scrubDiagnostic(result.stderrTail) } : {}),
          ...(result.protocolError ? { protocolError: scrubDiagnostic(result.protocolError) } : {}),
          ...(adapted?.nativeSessionId ? { nativeSessionId: adapted.nativeSessionId } : {}),
          exitCode: result.exitCode,
          signal: result.signal,
          ...(result.terminationCause ? { terminationCause: result.terminationCause } : {}),
        },
      });
      await this.syncRegistryRecord(completedRecord);
      // Abort can arrive after the child has closed but while the final
      // journal/session snapshot is being persisted. Re-check after the await
      // so a cancelled receipt cannot be paired with an idle/success response.
      if (this.abortRequested.has(sessionId)) {
        completionError = new CommandCodeRuntimeError('Command Code run was aborted', 'interrupted');
        const abortedRecord = await this.store.update(sessionId, { state: 'aborted', activeRunId: undefined });
        await this.syncRegistryRecord(abortedRecord);
      }
    } catch (error) {
      completionError = error instanceof Error ? error : new Error(String(error));
      if (!emittedTerminal) {
        const synthetic = this.syntheticEnd(sessionId, { exitCode: null, signal: null, stderrTail: '', protocolError: completionError.message });
        await this.journal.append(sessionId, synthetic).catch(() => undefined);
        this.publishApiEvent(sessionId, synthetic);
        onEvent(synthetic);
      }
      await this.store.update(sessionId, { state: this.abortRequested.has(sessionId) || completionError instanceof CommandCodeRuntimeError && completionError.code === 'interrupted' ? 'aborted' : 'failed', activeRunId: undefined, diagnostics: { suppressedDuplicateCount: 0, unknownEventTypes: [], protocolError: scrubDiagnostic(completionError.message), ...(this.abortRequested.has(sessionId) ? { terminationCause: 'abort' as const } : {}) } }).then((record) => this.syncRegistryRecord(record)).catch(() => undefined);
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
    const record = await this.store.get(sessionId);
    if (!this.isSessionRecordAccessible(record)) {
      throw new CommandCodeRuntimeError('Command Code session is no longer enabled by the active runtime policy', 'permission_denied');
    }
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
      this.pinClaims.delete(sessionId);
      this.apiObservers.delete(sessionId);
      await this.journal.clear(sessionId).catch(() => undefined);
      if (this.ownsProcessRunner) await rm(path.join(this.config.nativeHomeDir, sessionId), { recursive: true, force: true }).catch(() => undefined);
      const deleted = await this.store.delete(sessionId);
      if (deleted) await this.sessionRegistry?.delete(sessionId).catch(() => undefined);
      return deleted;
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
        await this.browserAuthHandle?.close().catch(() => undefined);
        this.browserAuthHandle = undefined;
        this.browserAuthIdentity = undefined;
      }
    })();
    return this.shutdownPromise;
  }

  addApiObserver(sessionId: string, observer: (event: unknown) => void): void {
    const observers = this.apiObservers.get(sessionId) ?? new Set<(event: NormalizedEvent) => void>();
    observers.add(observer as (event: NormalizedEvent) => void);
    this.apiObservers.set(sessionId, observers);
  }

  removeApiObserver(sessionId: string, observer: (event: unknown) => void): void {
    const observers = this.apiObservers.get(sessionId);
    if (!observers) return;
    observers.delete(observer as (event: NormalizedEvent) => void);
    if (observers.size === 0) this.apiObservers.delete(sessionId);
  }

  private publishApiEvent(sessionId: string, event: NormalizedEvent): void {
    for (const observer of this.apiObservers.get(sessionId) ?? []) {
      try { observer(event); } catch { /* observer failures never affect runtime turns */ }
    }
  }

  setRoleAttestationSecret(secret: string): void { this.roleAttestationSecret = secret || undefined; }
  isRunning(sessionId: string): boolean { return this.runner.isRunning(sessionId); }
  async hasSession(sessionId: string): Promise<boolean> {
    await this.init();
    return this.isSessionRecordAccessible(await this.store.get(sessionId));
  }
  isEnabled(): boolean { return this.config.enabled || this.config.browserEnabled === true; }
  isShadowEnabled(): boolean { return this.config.shadowEnabled ?? this.config.enabled; }
  /** Runtime-wide availability, including dynamically discovered browser models. */
  isAvailable(): boolean { return this.healthStatus === 'available'; }
  /** The narrow Agent OS shadow surface remains separately gated. */
  isShadowAvailable(): boolean {
    const models = this.discoveryResult?.models ?? [];
    const capabilities = this.discoveryResult?.effortCapabilities;
    return this.isShadowEnabled()
      && this.isAvailable()
      && hasOrderedShadowCatalogue(models)
      && capabilities !== undefined
      && hasExactEffortCapabilities(capabilities, models);
  }
  isBrowserEnabled(): boolean { return this.config.browserEnabled === true; }
  isBrowserAvailable(): boolean {
    return this.isAvailable()
      && this.isBrowserEnabled()
      && this.browserPolicyReady
      && (this.config.browserAllowedCwdRoots ?? []).length > 0
      && (this.config.browserAllowedModels ?? []).some((model) => assertCommandCodeModel(model) !== undefined)
      && this.runner.browserSandboxReady?.() === true;
  }
  getBrowserModels() {
    return this.getModels().filter((model) => model.browserRunnable);
  }
  /** Publicly usable Agent OS shadow catalogue; extra CLI discovery remains evidence-only. */
  getShadowModels() {
    return this.getModels().filter((model) => (COMMAND_CODE_MODELS as readonly string[]).includes(model.id));
  }
  getShadowEffortCapabilities(): Partial<CommandCodeEffortCapabilities> {
    const capabilities = this.getEffortCapabilities();
    return Object.fromEntries(COMMAND_CODE_MODELS.flatMap((model) => capabilities[model] ? [[model, capabilities[model]]] : []));
  }
  private isBrowserModelAllowed(model: CommandCodeRuntimeModel): boolean {
    const allowlist = this.config.browserAllowedModels ?? [];
    // Browser containment is a separate gate, not a second execution policy:
    // the exact two approved routes remain the only models executable on any
    // surface, even if an operator accidentally lists an evidence-only model
    // in the browser environment.
    return assertCommandCodeModel(model) !== undefined && allowlist.length > 0 && allowlist.includes(model);
  }
  private isBrowserSessionRecord(record: CommandCodeInternalSessionRecord): boolean {
    return record.permissionProfile === 'browser-contained'
      && this.isBrowserAvailable()
      && this.isBrowserModelAllowed(record.modelSelector);
  }

  private isSessionRecordAccessible(record: CommandCodeInternalSessionRecord | undefined): record is CommandCodeInternalSessionRecord {
    if (!record || record.state === 'deleted') return false;
    const capability = this.getEffortCapability(record.modelSelector);
    if (!capability || !record.effortCapabilityHash || record.effortCapabilityHash !== capability.capabilityHash) return false;
    const activeRoots = record.permissionProfile === 'browser-contained'
      ? (this.config.browserAllowedCwdRoots ?? [])
      : this.config.allowedCwdRoots;
    if (activeRoots.length === 0 || !activeRoots.some((root) => isWithinRoot(root, record.cwd))) return false;
    if (record.permissionProfile === 'browser-contained') return this.isBrowserSessionRecord(record);
    return assertCommandCodeModel(record.modelSelector) !== undefined && this.isShadowAvailable();
  }

  getExecutionInstanceId(): 'commandcode-default' { return COMMAND_CODE_EXECUTION_INSTANCE_ID; }
  getModels(): Array<{
    id: CommandCodeRuntimeModel;
    displayName: string;
    provider: string;
    reasoning: boolean;
    runnable: boolean;
    status: 'runnable' | 'evidence-only' | 'unavailable';
    browserRunnable: boolean;
    supportsEffort: boolean;
    effortLevels: CommandCodeEffort[];
    defaultEffort?: CommandCodeEffort;
    effortCapabilityHash?: string;
    catalogue: CommandCodeCatalogueMetadata;
  }> {
    const available = this.discoveryResult?.models ?? [];
    const catalogue = this.getCatalogueMetadata();
    return available.map((id) => {
      const discoveredCapability = this.discoveryResult?.effortCapabilities?.[id];
      const capability = isSafeEffortCapability(discoveredCapability) ? discoveredCapability : undefined;
      const isShadowModel = (COMMAND_CODE_MODELS as readonly string[]).includes(id);
      const shadowRunnable = isShadowModel
        && this.isShadowAvailable()
        && capability?.status !== 'unknown'
        && capability?.source === 'live-preflight';
      const shadowUnavailable = isShadowModel && this.isShadowEnabled() && !shadowRunnable;
      const browserRunnable = this.isBrowserAvailable()
        && this.isBrowserModelAllowed(id)
        && capability?.status !== 'unknown';
      return {
        id,
        displayName: commandCodeDisplayName(id),
        provider: COMMAND_CODE_PROVIDER,
        reasoning: true,
        runnable: shadowRunnable,
        status: shadowRunnable ? 'runnable' : shadowUnavailable || capability?.status === 'unknown' || !capability ? 'unavailable' : 'evidence-only',
        browserRunnable,
        supportsEffort: capability?.supportsEffort === true,
        effortLevels: [...(capability?.effortLevels ?? [])],
        ...(capability?.defaultEffort ? { defaultEffort: capability.defaultEffort } : {}),
        ...(capability?.capabilityHash ? { effortCapabilityHash: capability.capabilityHash } : {}),
        catalogue,
      };
    });
  }
  getCatalogueMetadata(): CommandCodeCatalogueMetadata {
    const health = this.getHealth();
    return {
      availabilityStatus: health.status,
      checkedAt: health.checkedAt,
      source: 'live-discovery',
    };
  }
  getHealth(): CommandCodeHealth {
    const missingModels = COMMAND_CODE_MODELS.filter((model) => !this.discoveryResult?.models.includes(model));
    return {
      enabled: this.isEnabled(),
      available: this.isAvailable(),
      status: this.healthStatus,
      ...(this.discoveryResult?.version ? { version: this.discoveryResult.version } : {}),
      ...(this.config.expectedVersion ? { expectedVersion: this.config.expectedVersion } : {}),
      advertisedModels: [...(this.discoveryResult?.models ?? [])],
      missingModels,
      effortCapabilities: this.getEffortCapabilities(),
      checkedAt: this.discoveryCheckedAt ?? new Date().toISOString(),
      ...(this.discoveryDiagnostic ? { diagnostic: this.discoveryDiagnostic } : {}),
      ...(this.registryProjectionError ? { diagnostic: `${this.discoveryDiagnostic ? `${this.discoveryDiagnostic}; ` : ''}registry projection: ${this.registryProjectionError}` } : {}),
    };
  }
  async getSessionDiagnostics(sessionId: string): Promise<CommandCodeInternalSessionRecord['diagnostics'] | undefined> {
    await this.init();
    const record = await this.store.get(sessionId);
    return this.isSessionRecordAccessible(record) ? record.diagnostics : undefined;
  }
  pinSession(sessionId: string, claimId = 'web-ui'): boolean {
    const claims = this.pinClaims.get(sessionId) ?? new Set<string>();
    claims.add(claimId);
    this.pinClaims.set(sessionId, claims);
    return true;
  }
  unpinSession(sessionId: string, claimId = 'web-ui'): boolean {
    const claims = this.pinClaims.get(sessionId);
    if (!claims) return false;
    claims.delete(claimId);
    if (claims.size === 0) this.pinClaims.delete(sessionId);
    return true;
  }
  isSessionPinned(sessionId: string): boolean { return (this.pinClaims.get(sessionId)?.size ?? 0) > 0; }

  private resolveEffort(model: CommandCodeRuntimeModel, requested: unknown): {
    effort?: CommandCodeEffort;
    source: 'explicit' | 'default' | 'automatic' | 'none';
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
      // Some Command Code models expose an adjustable effort selector but do
      // not publish a native default. Automatic must therefore omit --effort;
      // never guess from the first advertised value.
      return { source: 'automatic', capabilityHash: capability.capabilityHash };
    }
    return { effort: capability.defaultEffort, source: 'default', defaultEffort: capability.defaultEffort, capabilityHash: capability.capabilityHash };
  }

  private capabilityFor(model: CommandCodeRuntimeModel) {
    const capability = this.discoveryResult?.effortCapabilities?.[model];
    if (!capability) throw new CommandCodeRuntimeError(`Command Code effort capability is unavailable for model ${model}`, 'effort_unsupported');
    return capability;
  }

  private async recordEffectiveEffort(sessionId: string, model: CommandCodeRuntimeModel, event: NormalizedEvent): Promise<void> {
    const effectiveEffort = extractEffectiveEffort(event);
    if (!effectiveEffort) return;
    const capability = this.capabilityFor(model);
    if (!capability.effortLevels.includes(effectiveEffort.effort)) {
      throw new CommandCodeRuntimeError(`Command Code reported unsupported effective effort '${effectiveEffort.effort}'`, 'protocol_error');
    }
    await this.store.update(sessionId, {
      effectiveEffort: effectiveEffort.effort,
      effortEvidenceMethod: effectiveEffort.method,
    });
  }

  private async syncRegistryRecord(record: CommandCodeInternalSessionRecord): Promise<void> {
    if (!this.sessionRegistry) return;
    try {
      await this.sessionRegistry.upsert({
        id: record.sessionId,
        sdkType: 'commandcode',
        path: record.sessionId,
        commandCodeNativeSessionId: record.nativeSessionId,
        cwd: record.cwd,
        model: record.modelSelector,
        firstMessage: record.firstMessage,
        messageCount: record.messageCount,
        createdAt: record.createdAt,
        lastActivity: record.updatedAt,
        status: record.state === 'running' ? 'running' : record.state === 'failed' || record.state === 'aborted' ? 'error' : 'idle',
      });
      this.registryProjectionError = undefined;
    } catch (error) {
      this.registryProjectionError = error instanceof Error ? error.message : String(error);
      // Registry projection is discoverability evidence, not the private
      // session source of truth; a persistence hiccup must not abort a turn.
    }
  }

  private async removeInaccessibleBrowserHomes(): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.permissionProfile === 'browser-contained' && !this.isSessionRecordAccessible(record)) {
        const staleSessionId = (record as CommandCodeInternalSessionRecord).sessionId;
        await rm(path.join(this.config.nativeHomeDir, staleSessionId), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async prepareNativeHomeRoot(): Promise<void> {
    await ensurePrivateDirectory(this.config.nativeHomeDir, 'Command Code native home root');
  }

  private async prepareNativeHome(sessionId: string, permissionProfile: CommandCodePermissionProfile): Promise<void> {
    await this.prepareNativeHomeRoot();
    const sessionHome = path.join(this.config.nativeHomeDir, sessionId);
    const commandCodeHome = path.join(sessionHome, '.commandcode');
    await ensurePrivateDirectory(sessionHome, 'Command Code session home');
    await ensurePrivateDirectory(commandCodeHome, 'Command Code private auth directory');
    const source = permissionProfile === 'browser-contained'
      ? this.config.browserAuthFile
      : path.join(process.env.HOME || '/root', '.commandcode', 'auth.json');
    const target = path.join(commandCodeHome, 'auth.json');
    if (!source) return;

    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    const temporary = `${target}.${process.pid}.${cryptoRandomId()}.tmp`;
    try {
      if (permissionProfile === 'browser-contained') {
        sourceHandle = this.browserAuthHandle;
        if (!sourceHandle) throw new Error('Command Code browser auth is not pinned');
      } else {
        sourceHandle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      }
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) return;
      try {
        const targetStat = await lstat(target);
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error('Command Code private auth binding drift');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      temporaryHandle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o400);
      const contents = permissionProfile === 'browser-contained'
        ? await readFile(`/proc/self/fd/${sourceHandle.fd}`)
        : await sourceHandle.readFile();
      await temporaryHandle.writeFile(contents);
      await temporaryHandle.chmod(0o400);
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, target);
    } catch (error) {
      if (permissionProfile === 'browser-contained' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      if (sourceHandle && sourceHandle !== this.browserAuthHandle) await sourceHandle.close().catch(() => undefined);
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async validateBrowserPolicy(): Promise<void> {
    this.browserPolicyReady = false;
    await this.browserAuthHandle?.close().catch(() => undefined);
    this.browserAuthHandle = undefined;
    this.browserAuthIdentity = undefined;
    if (!this.config.browserAuthFile || (this.config.browserRuntimeRoots ?? []).length === 0 || (this.config.browserAllowedCwdRoots ?? []).length === 0 || (this.config.browserAllowedModels ?? []).length === 0) {
      this.discoveryDiagnostic = 'Command Code browser credential, model allowlist, runtime roots, and workspace roots are all required';
      return;
    }
    try {
      const authStat = await lstat(this.config.browserAuthFile);
      if (!authStat.isFile() || authStat.isSymbolicLink()) throw new Error('browser auth must be a regular non-symlink file');
      const authParent = path.dirname(path.resolve(this.config.browserAuthFile));
      if (await realpath(authParent) !== authParent) throw new Error('browser auth parent may not contain symlinked path components');
      const runtimeValidation = await canonicalBrowserDirectories(this.config.browserRuntimeRoots ?? [], 'runtime roots');
      const workspaceValidation = await canonicalBrowserDirectories(this.config.browserAllowedCwdRoots ?? [], 'workspace roots', true);
      const canonicalRuntimeRoots = runtimeValidation.paths;
      const canonicalWorkspaceRoots = workspaceValidation.paths;
      const canonicalAuth = await realpath(this.config.browserAuthFile);
      let authHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        authHandle = await open(canonicalAuth, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const openedAuth = await authHandle.stat();
        if (!openedAuth.isFile() || openedAuth.isSymbolicLink()) throw new Error('browser auth must be a regular file');
        if (openedAuth.dev !== authStat.dev || openedAuth.ino !== authStat.ino) throw new Error('browser auth changed during validation');
        if ((openedAuth.mode & 0o077) !== 0) throw new Error('browser auth must not be group/world accessible');
        if (typeof process.getuid === 'function' && openedAuth.uid !== process.getuid()) throw new Error('browser auth must be owned by the server user');
      } catch (error) {
        await authHandle?.close().catch(() => undefined);
        throw error;
      }
      this.browserAuthHandle = authHandle;
      this.browserAuthIdentity = { dev: (await authHandle.stat()).dev, ino: (await authHandle.stat()).ino };
      const canonicalSandbox = this.config.browserSandboxExecutablePath ? await realpath(this.config.browserSandboxExecutablePath) : '';
      const sandboxStat = await stat(canonicalSandbox);
      if (!sandboxStat.isFile()) throw new Error('browser sandbox launcher is not a regular file');
      await access(canonicalSandbox, fsConstants.X_OK);
      this.browserSandboxIdentity = { dev: sandboxStat.dev, ino: sandboxStat.ino };
      if (canonicalRuntimeRoots.some(isBroadRuntimeRoot) || canonicalWorkspaceRoots.some(isBroadWorkspaceRoot)) throw new Error('browser roots are too broad');
      const pinnedRootIdentities = this.runner.setBrowserPolicyRoots
        ? {
            allowed: workspaceValidation.identities,
            runtime: runtimeValidation.identities,
            nativeHome: await identityForDirectory(this.config.nativeHomeDir),
          }
        : undefined;
      this.runner.setBrowserPolicyRoots?.(
        canonicalWorkspaceRoots,
        canonicalRuntimeRoots,
        this.config.nativeHomeDir,
        pinnedRootIdentities,
      );
      if (this.ownsProcessRunner) this.runner.pinBrowserSandbox?.(this.config.browserSandboxExecutablePath, this.browserSandboxIdentity);
      if (this.runner.browserSandboxReady?.() !== true) throw new Error('browser sandbox launcher is unavailable');
      this.config.browserRuntimeRoots = canonicalRuntimeRoots;
      this.config.browserAllowedCwdRoots = canonicalWorkspaceRoots;
      this.config.browserAuthFile = canonicalAuth;
      this.config.browserSandboxExecutablePath = canonicalSandbox;
      this.browserPolicyReady = true;
    } catch (error) {
      await this.browserAuthHandle?.close().catch(() => undefined);
      this.browserAuthHandle = undefined;
      this.browserAuthIdentity = undefined;
      this.browserPolicyReady = false;
      this.runner.setBrowserPolicyRoots?.([], [], this.config.nativeHomeDir);
      this.discoveryDiagnostic = `Command Code browser containment unavailable: ${scrubDiagnostic(error instanceof Error ? error.message : String(error))}`;
    }
  }

  private assertRunnable(): void {
    if (!this.isEnabled()) throw new CommandCodeRuntimeError('Command Code runtime is disabled', 'runtime_error');
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

function commandCodeDisplayName(model: CommandCodeRuntimeModel): string {
  if (model === 'qwen/qwen3.8-max') return 'Qwen 3.8 Max';
  if (model === 'meta/muse-spark-1.2-contributor') return 'Muse Spark 1.2 Contributor';
  const leaf = model.split('/').pop() ?? model;
  return leaf
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function isSafeEffortCapability(value: unknown): value is CommandCodeEffortCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const capability = value as Partial<CommandCodeEffortCapability>;
  if (typeof capability.supportsEffort !== 'boolean'
    || !Array.isArray(capability.effortLevels)
    || !capability.effortLevels.every((effort) => typeof effort === 'string' && (COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(effort))
    || !['adjustable', 'unavailable', 'unknown'].includes(capability.status as string)
    || capability.source !== 'live-preflight'
    || typeof capability.capabilityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(capability.capabilityHash)
    || capability.defaultEffort !== undefined
      && (typeof capability.defaultEffort !== 'string' || !(COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(capability.defaultEffort))) return false;
  if (capability.status === 'unknown' || capability.status === 'unavailable') {
    return capability.supportsEffort === false && capability.effortLevels.length === 0 && capability.defaultEffort === undefined;
  }
  return capability.supportsEffort === true
    && capability.effortLevels.length > 0
    && (capability.defaultEffort === undefined || capability.effortLevels.includes(capability.defaultEffort));
}

function hasExactEffortCapabilities(
  capabilities: CommandCodeEffortCapabilities,
  models: readonly CommandCodeRuntimeModel[],
): boolean {
  if (JSON.stringify(Object.keys(capabilities).sort()) !== JSON.stringify([...models].sort())) return false;
  return models.every((model) => {
    const capability = capabilities[model];
    if (!capability
      || typeof capability.supportsEffort !== 'boolean'
      || !Array.isArray(capability.effortLevels)
      || !['adjustable', 'unavailable', 'unknown'].includes(capability.status)
      || capability.source !== 'live-preflight'
      || !/^[a-f0-9]{64}$/.test(capability.capabilityHash)
      || new Set(capability.effortLevels).size !== capability.effortLevels.length
      || capability.effortLevels.some((effort) => typeof effort !== 'string' || !(COMMAND_CODE_EFFORT_LEVELS as readonly string[]).includes(effort))) return false;
    if (capability.status === 'unknown' || capability.status === 'unavailable') {
      if (capability.supportsEffort || capability.effortLevels.length > 0 || capability.defaultEffort !== undefined) return false;
    } else if (capability.status === 'adjustable'
      && (!capability.supportsEffort
        || capability.effortLevels.length === 0
        || capability.defaultEffort !== undefined && !capability.effortLevels.includes(capability.defaultEffort))) return false;
    // Extra catalogue models may have inconclusive effort probes. They remain
    // explicit unavailable evidence and never become runnable; the approved
    // pair still has to satisfy its exact capability contract below. An
    // unknown approved model is never equivalent to a confirmed non-adjustable
    // model (Muse), even though both carry an empty effort list.
    if ((COMMAND_CODE_MODELS as readonly string[]).includes(model) && capability.status === 'unknown') return false;
    if (!(COMMAND_CODE_MODELS as readonly string[]).includes(model) && capability.status === 'unknown') return true;
    // The shadow contract is model-specific even when the live catalogue also
    // contains extra evidence-only models. Never let an extra model bypass
    // drift checks for Qwen or Muse.
    if ((COMMAND_CODE_MODELS as readonly string[]).includes(model)) {
      const expectedLevels = COMMAND_CODE_EFFORT_LEVELS_BY_MODEL[model] ?? [];
      return JSON.stringify(capability.effortLevels) === JSON.stringify(expectedLevels)
        && (expectedLevels.length === 0 ? capability.defaultEffort === undefined : capability.defaultEffort === 'medium');
    }
    return true;
  });
}

function hasOrderedShadowCatalogue(models: readonly CommandCodeRuntimeModel[]): boolean {
  // Once the complete catalogue is present, its exact identity and order are
  // part of the shadow readiness contract. Do not let an injected/custom
  // discovery path bypass the same fail-closed rule used by startup discovery.
  if (models.length === COMMAND_CODE_FULL_MODEL_CATALOGUE.length) {
    return validateCommandCodeModelCatalogue(models).valid;
  }
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model)) return false;
    seen.add(model);
  }
  let previousIndex = -1;
  for (const model of COMMAND_CODE_MODELS) {
    const index = models.indexOf(model);
    if (index < 0 || index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
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

function normalizedEventKey(event: NormalizedEvent): string {
  return JSON.stringify({ type: event.type, data: event.data });
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

function isBroadWorkspaceRoot(root: string): boolean {
  const canonical = path.resolve(root);
  return new Set(['/','/home','/root','/tmp','/var','/etc','/usr','/bin','/sbin','/lib','/lib64']).has(canonical);
}

function isBroadRuntimeRoot(root: string): boolean {
  return new Set(['/','/home','/root','/tmp','/var','/usr','/usr/local','/etc','/bin','/sbin','/lib','/lib64']).has(path.resolve(root));
}

async function identityForDirectory(directory: string): Promise<{ dev: number; ino: number }> {
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error(`Command Code browser root is not a directory: ${directory}`);
  return { dev: metadata.dev, ino: metadata.ino };
}

async function canonicalBrowserDirectories(
  roots: string[],
  label: string,
  rejectSymlinkAliases = false,
): Promise<{ paths: string[]; identities: Array<{ dev: number; ino: number }> }> {
  const canonical: string[] = [];
  const identities: Array<{ dev: number; ino: number }> = [];
  for (const root of [...new Set(roots.map((value) => path.resolve(value)))]) {
    const link = await lstat(root);
    if (!link.isDirectory() || link.isSymbolicLink()) throw new Error(`browser ${label} must be regular directories`);
    const resolved = await realpath(root);
    if (rejectSymlinkAliases && resolved !== path.resolve(root)) throw new Error(`browser ${label} may not contain symlinked path components`);
    const resolvedStat = await stat(resolved);
    if (!resolvedStat.isDirectory()) throw new Error(`browser ${label} must be directories`);
    canonical.push(resolved);
    identities.push({ dev: resolvedStat.dev, ino: resolvedStat.ino });
  }
  const uniquePaths = [...new Set(canonical)];
  return { paths: uniquePaths, identities: identities.slice(0, uniquePaths.length) };
}

async function ensurePrivateDirectory(directory: string, label: string): Promise<void> {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  if (await realpath(resolved) !== resolved) throw new Error(`${label} may not contain symlinked path components`);
  await chmod(resolved, 0o700);
}

function scrubDiagnostic(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]').slice(0, 320);
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 12);
}

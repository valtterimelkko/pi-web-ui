import { access, chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { constants as fsConstants, type Dirent } from 'node:fs';
import path from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import {
  COMMAND_CODE_EXECUTION_INSTANCE_ID,
  defaultCommandCodeConfig,
  type CommandCodeRuntimeConfig,
} from './command-code-config.js';
import {
  COMMAND_CODE_PROVIDER,
  assertCommandCodeRuntimeModel,
  assertCommandCodeEffort,
  commandCodeEffortSpec,
  discoverCommandCodeModels,
  isCommandCodeEligible,
  type CommandCodeEffort,
  type CommandCodeRuntimeModel,
  type CommandCodeModelDiscovery,
  type CommandCodeDiscoveryRunner,
} from './command-code-model-catalog.js';
import {
  adaptCommandCodeEvent,
  adaptCommandCodeOutput,
  createCommandCodeIncrementalAdapterState,
} from './command-code-event-adapter.js';
import {
  coalesceCommandCodeReplayEvents,
  describeCommandCodeReplayCoalesce,
  type CommandCodeReplayCoalesceStats,
} from './command-code-replay-projection.js';
import { CommandCodeEventJournal, type CommandCodeJournalStats, type CommandCodeReplayProjectionSnapshot } from './command-code-event-journal.js';
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
  type CommandCodeSessionTokenUsage,
} from './command-code-session-store.js';

/** Session statistics shaped for the browser session-info view. */
export interface CommandCodeSessionStats {
  sessionFile: string;
  sessionId: string;
  nativeSessionId?: string;
  cwd: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: CommandCodeSessionTokenUsage;
  model: string;
  effort?: string;
  defaultEffort?: string;
  lastActivityAt: number;
}

export type CommandCodeAvailability =
  | 'disabled'
  | 'executable_missing'
  | 'discovery_error'
  | 'exact_model_unavailable'
  | 'available';

export interface CommandCodeHealth {
  enabled: boolean;
  available: boolean;
  status: CommandCodeAvailability;
  version?: string;
  advertisedModels: CommandCodeRuntimeModel[];
  checkedAt: string;
  diagnostic?: string;
}

export interface CommandCodeServiceConfig extends Partial<CommandCodeRuntimeConfig> {
  enabled: boolean;
  executablePath: string;
  stateDir: string;
  allowedCwdRoots?: string[];
}

export interface CommandCodeCreateInput {
  cwd: string;
  model: CommandCodeRuntimeModel;
  /** Native effort; undefined means the CLI default applies. */
  effort?: string;
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
  | 'plan_ineligible'
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
  private lastReplayProjection?: CommandCodeReplayProjectionSnapshot;

  private readonly sessionRegistry?: SessionRegistryManager;
  private registryProjectionError?: string;

  constructor(options: {
    config: CommandCodeServiceConfig;
    runner?: RunnerLike;
    discover?: CommandCodeDiscoveryRunner;
    checkExecutable?: boolean;
    sessionRegistry?: SessionRegistryManager;
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
    this.discover = options.discover ?? discoverCommandCodeModels;
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
    if (!this.config.enabled) {
      this.healthStatus = 'disabled';
      this.initialized = true;
      return;
    }
    if (this.ownsProcessRunner) {
      await this.prepareNativeHomeRoot();
      for (const record of await this.store.list()) {
        await this.prepareNativeHome(record.sessionId);
      }
    }
    if (this.sessionRegistry) {
      // Rebuild the public projection from the private store after discovery.
      try {
        for (const entry of await this.sessionRegistry.listBySdkType('commandcode')) {
          await this.sessionRegistry.delete(entry.id).catch(() => undefined);
        }
      } catch {
        // Registry projection is best-effort; the private store remains the
        // Command Code source of truth.
      }
    }
    try {
      if (this.checkExecutable) {
        const canonicalExecutable = await realpath(this.config.executablePath);
        const executableStat = await stat(canonicalExecutable);
        if (!executableStat.isFile()) throw new Error('Command Code executable is not a regular file');
        await access(canonicalExecutable, fsConstants.X_OK);
        this.config.executablePath = canonicalExecutable;
      }
    } catch {
      this.healthStatus = 'executable_missing';
      this.discoveryDiagnostic = 'Configured Command Code executable is not accessible';
      this.initialized = true;
      return;
    }
    try {
      const discovered = await this.discover(this.config.executablePath);
      this.discoveryResult = discovered;
      if (discovered.models.length === 0) {
        this.healthStatus = 'exact_model_unavailable';
        this.discoveryDiagnostic = 'Command Code advertised no models';
      } else {
        this.healthStatus = 'available';
      }
    } catch (error) {
      this.healthStatus = 'discovery_error';
      this.discoveryDiagnostic = scrubDiagnostic(error instanceof Error ? error.message : String(error));
    }
    for (const record of await this.store.list()) {
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
    const model = assertCommandCodeRuntimeModel(input.model, this.discoveryResult?.models ?? []);
    if (!model) throw new CommandCodeRuntimeError('Exact Command Code model is unavailable', 'protocol_error');
    if (!isCommandCodeEligible(model)) {
      throw new CommandCodeRuntimeError(`Command Code model ${model} is not available on the current plan`, 'plan_ineligible');
    }
    const effort = this.resolveEffort(model, input.effort);
    const sessionId = `commandcode-${cryptoRandomId()}`;
    const cwd = await canonicalCwd(input.cwd);
    if (this.config.allowedCwdRoots.length === 0 || !this.config.allowedCwdRoots.some((root) => isWithinRoot(root, cwd))) {
      throw new CommandCodeRuntimeError('Command Code cwd is outside the configured isolated workspace roots', 'permission_denied');
    }
    try {
      const created = await this.store.create({
        sessionId,
        cwd,
        modelSelector: model,
        ...(effort ? { effort } : {}),
        eventJournalRef: `events/${sessionId}.jsonl`,
      });
      if (this.ownsProcessRunner) await this.prepareNativeHome(sessionId);
      await this.syncRegistryRecord(created);
      return created;
    } catch (error) {
      await this.store.delete(sessionId).catch(() => undefined);
      throw error;
    }
  }

  async setEffort(sessionId: string, effort?: string): Promise<CommandCodeInternalSessionRecord> {
    this.assertTurnAvailable(sessionId);
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
      const resolved = this.resolveEffort(record.modelSelector, effort);
      try {
        const updated = await this.store.setEffort(sessionId, resolved);
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

  async listSessions(): Promise<CommandCodeInternalSessionRecord[]> {
    await this.init();
    if (!this.isEnabled()) return [];
    return (await this.store.list()).filter((record) => this.isSessionRecordAccessible(record));
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
    this.assertTurnAvailable(sessionId);
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
    // Turn-unique prefix for synthetic message ids: a fresh per-turn counter
    // alone would re-emit commandcode-message-1..N for every turn, colliding
    // with earlier journal entries; clients keyed by id then merged turns.
    const syntheticMessagePrefix = `commandcode-message-${runId ?? cryptoRandomId()}-`;
    const streamState = createCommandCodeIncrementalAdapterState(syntheticMessagePrefix);
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
        await this.emit(sessionId, event, onEvent);
        if (event.type === 'agent_end') emittedTerminal = true;
      });
    };
    try {
      const makeEvent = (type: NormalizedEvent['type'], data: Record<string, unknown>): NormalizedEvent =>
        ({ type, sessionId, timestamp: Date.now(), data });
      await this.emit(sessionId, makeEvent('agent_start', { runtime: 'commandcode', runId }), onEvent);
      const userMessageId = `commandcode-user-${runId ?? cryptoRandomId()}`;
      await this.emit(sessionId, makeEvent('message_start', { id: userMessageId, role: 'user', content: prompt.slice(0, 20_000) }), onEvent);
      await this.emit(sessionId, makeEvent('message_end', { id: userMessageId }), onEvent);

      const currentCwd = await canonicalCwd(record.cwd);
      if (currentCwd !== record.cwd) throw new CommandCodeRuntimeError('Command Code cwd binding drift', 'permission_denied');
      if (!this.config.allowedCwdRoots.some((root) => isWithinRoot(root, currentCwd))) {
        throw new CommandCodeRuntimeError('Command Code cwd is outside the active workspace policy', 'permission_denied');
      }
      if (this.abortRequested.has(sessionId)) throw new CommandCodeRuntimeError('Command Code run was aborted before spawn', 'interrupted');
      const result = await this.runner.run({
        sessionId,
        cwd: currentCwd,
        model: record.modelSelector,
        maxTurns: this.config.maxTurns,
        prompt,
        nativeSessionId: record.nativeSessionId,
        effort: record.effort,
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
            syntheticMessagePrefix,
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
          await this.emit(sessionId, event, onEvent);
          if (event.type === 'agent_end') emittedTerminal = true;
        }
      } else {
        const synthetic = this.syntheticEnd(sessionId, result);
        await this.emit(sessionId, synthetic, onEvent);
        emittedTerminal = true;
      }
      completionError = classifyResult(result, adapted?.terminal);
      if (this.abortRequested.has(sessionId)) completionError = new CommandCodeRuntimeError('Command Code run was aborted', 'interrupted');
      const terminal = adapted?.terminal;
      const usageDelta = adapted?.tokenUsage;
      const cumulativeUsage = accumulateTokenUsage(record.tokenUsage, usageDelta);
      const runToolCalls = countToolCalls(adapted?.events ?? streamedEvents);
      const completedRecord = await this.store.update(sessionId, {
        state: result.terminationCause === 'abort' || this.abortRequested.has(sessionId) ? 'aborted' : completionError ? 'failed' : 'idle',
        activeRunId: undefined,
        ...(terminal ? { lastResult: { subtype: terminal.subtype, ...(terminal.stopReason ? { stopReason: terminal.stopReason } : {}), ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}) } } : {}),
        ...(adapted ? { lastFinalText: scrubDiagnostic(adapted.finalText) } : {}),
        assistantMessages: (record.assistantMessages ?? 0) + 1,
        toolCalls: (record.toolCalls ?? 0) + runToolCalls,
        ...(cumulativeUsage ? { tokenUsage: cumulativeUsage } : {}),
        ...(usageDelta ? { lastRunTokenUsage: { input: usageDelta.input, output: usageDelta.output, cacheRead: usageDelta.cacheRead ?? 0, cacheWrite: usageDelta.cacheWrite ?? 0, total: usageDelta.total } } : {}),
        diagnostics: {
          suppressedDuplicateCount: result.parsed?.suppressedDuplicateCount ?? 0,
          unknownEventTypes: result.parsed?.unknownEventTypes ?? [],
          ...(result.parsed?.droppedLineCount ? { droppedLineCount: result.parsed.droppedLineCount } : {}),
          ...(result.parsed?.droppedLineSamples?.length ? { droppedLineSamples: result.parsed.droppedLineSamples } : {}),
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
        await this.emit(sessionId, synthetic, onEvent).catch(() => undefined);
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
    // Replay projection: collapse per-token streaming deltas into whole
    // messages. The journal itself stays the exact append-only evidence
    // record; only reads are projected. Without this, one real session's
    // journal (7,423 per-token events) was pushed to the browser one delta at
    // a time, which dominated session-open time and starved the UI.
    const raw = await this.journal.read(sessionId);
    const projected = coalesceCommandCodeReplayEvents(raw);
    this.lastReplayProjection = {
      sessionId,
      at: new Date().toISOString(),
      ...describeCommandCodeReplayCoalesce(raw, projected),
    };
    return projected;
  }

  /** Most recent replay projection stats for this server process (diagnostics). */
  getLastReplayProjection(): CommandCodeReplayProjectionSnapshot | undefined {
    return this.lastReplayProjection;
  }

  /** Bounded journal statistics for observability without a full read. */
  async getJournalStats(sessionId: string): Promise<CommandCodeJournalStats | undefined> {
    await this.init();
    const record = await this.store.get(sessionId);
    if (!this.isSessionRecordAccessible(record)) return undefined;
    return this.journal.stats(sessionId);
  }

  /** Complete session statistics for the browser session-info view. */
  async getSessionStats(sessionId: string): Promise<CommandCodeSessionStats | undefined> {
    await this.init();
    const record = await this.store.get(sessionId);
    if (!this.isSessionRecordAccessible(record)) return undefined;
    const usage = record.tokenUsage;
    // Records created before counters were persisted (and any record whose
    // count fields are absent) get their counts derived from the journal so
    // legacy sessions show real message/tool totals. Token usage cannot be
    // recovered: older journals redacted usage evidence at write time.
    let assistantMessages = record.assistantMessages;
    let toolCalls = record.toolCalls;
    if (assistantMessages === undefined || toolCalls === undefined) {
      const events = await this.journal.read(sessionId).catch(() => []);
      let assistants = 0;
      let tools = 0;
      for (const event of events) {
        if (event.type === 'message_start' && (event.data as { role?: string } | undefined)?.role === 'assistant') assistants += 1;
        if (event.type === 'tool_execution_start') tools += 1;
      }
      if (assistantMessages === undefined) assistantMessages = assistants;
      if (toolCalls === undefined) toolCalls = tools;
    }
    return {
      sessionFile: path.join(this.config.stateDir, record.eventJournalRef),
      sessionId: record.sessionId,
      ...(record.nativeSessionId ? { nativeSessionId: record.nativeSessionId } : {}),
      cwd: record.cwd,
      userMessages: record.messageCount,
      assistantMessages,
      toolCalls,
      toolResults: toolCalls,
      totalMessages: record.messageCount + assistantMessages,
      tokens: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      model: record.modelSelector,
      ...(record.effort ? { effort: record.effort } : {}),
      ...(record.defaultEffort ? { defaultEffort: record.defaultEffort } : {}),
      lastActivityAt: Date.parse(record.updatedAt),
    };
  }

  async abort(sessionId: string): Promise<void> {
    if (!this.pendingSessions.has(sessionId) && !this.activeSessions.has(sessionId)) return;
    this.abortRequested.add(sessionId);
    await this.runner.abort(sessionId);
  }

  /**
   * Resolves when the session's in-flight turn (if any) has fully settled —
   * used by the steer hand-off so the interrupting prompt cannot collide with
   * the aborting run's journal/registry writes.
   */
  waitForTurnEnd(sessionId: string): Promise<void> | undefined {
    return this.inFlightTurns.get(sessionId);
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


  /** A turn or effort mutation needs the session idle and the service alive. */
  private assertTurnAvailable(sessionId: string): void {
    if (this.shuttingDown) throw new CommandCodeRuntimeError('Command Code service is shutting down', 'interrupted');
    if (this.deletedSessions.has(sessionId)) throw new CommandCodeRuntimeError('Command Code session was deleted', 'runtime_error');
    if (this.pendingSessions.has(sessionId) || this.activeSessions.has(sessionId) || this.effortMutations.has(sessionId)) {
      throw new CommandCodeRuntimeError('Command Code session is already running', 'runtime_error');
    }
  }

  /** Journal, publish to Internal API observers, and forward to the live sink. */
  private async emit(sessionId: string, event: NormalizedEvent, onEvent: (event: NormalizedEvent) => void): Promise<void> {
    await this.journal.append(sessionId, event);
    this.publishApiEvent(sessionId, event);
    onEvent(event);
  }

  private publishApiEvent(sessionId: string, event: NormalizedEvent): void {
    for (const observer of this.apiObservers.get(sessionId) ?? []) {
      try { observer(event); } catch { /* observer failures never affect runtime turns */ }
    }
  }

  isRunning(sessionId: string): boolean { return this.runner.isRunning(sessionId); }
  async hasSession(sessionId: string): Promise<boolean> {
    await this.init();
    return this.isSessionRecordAccessible(await this.store.get(sessionId));
  }
  isEnabled(): boolean { return this.config.enabled; }

  /** Runtime-wide availability; catalogue drift never changes it. */
  isAvailable(): boolean { return this.healthStatus === 'available'; }

  private isSessionRecordAccessible(record: CommandCodeInternalSessionRecord | undefined): record is CommandCodeInternalSessionRecord {
    if (!record || record.state === 'deleted') return false;
    if (this.config.allowedCwdRoots.length === 0 || !this.config.allowedCwdRoots.some((root) => isWithinRoot(root, record.cwd))) return false;
    return true;
  }

  getExecutionInstanceId(): 'commandcode-default' { return COMMAND_CODE_EXECUTION_INSTANCE_ID; }
  getModels(): Array<{
    id: CommandCodeRuntimeModel;
    displayName: string;
    provider: string;
    reasoning: boolean;
    effortLevels: CommandCodeEffort[];
    defaultEffort?: CommandCodeEffort;
  }> {
    const available = this.discoveryResult?.models ?? [];
    return available.filter(isCommandCodeEligible).map((id) => {
      const effortSpec = commandCodeEffortSpec(id);
      return {
        id,
        displayName: commandCodeDisplayName(id),
        provider: COMMAND_CODE_PROVIDER,
        reasoning: true,
        effortLevels: [...effortSpec.effortLevels],
        ...(effortSpec.defaultEffort && effortSpec.effortLevels.length > 0 ? { defaultEffort: effortSpec.defaultEffort } : {}),
      };
    });
  }
  getHealth(): CommandCodeHealth {
    return {
      enabled: this.isEnabled(),
      available: this.isAvailable(),
      status: this.healthStatus,
      ...(this.discoveryResult?.version ? { version: this.discoveryResult.version } : {}),
      advertisedModels: [...(this.discoveryResult?.models ?? [])],
      checkedAt: this.discoveryCheckedAt ?? new Date().toISOString(),
      ...(this.discoveryDiagnostic || this.registryProjectionError
        ? { diagnostic: [this.discoveryDiagnostic, this.registryProjectionError ? `registry projection: ${this.registryProjectionError}` : undefined].filter(Boolean).join('; ') || undefined }
        : {}),
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

  /** Resolve a requested effort against the committed effort table for the model. */
  private resolveEffort(model: CommandCodeRuntimeModel, requested: unknown): CommandCodeEffort | undefined {
    if (requested === undefined) return undefined;
    const levels = commandCodeEffortSpec(model).effortLevels;
    let effort: CommandCodeEffort;
    try { effort = assertCommandCodeEffort(model, requested) as CommandCodeEffort; }
    catch (error) { throw new CommandCodeRuntimeError(error instanceof Error ? error.message : String(error), 'effort_unsupported'); }
    if (!levels.includes(effort)) throw new CommandCodeRuntimeError(`Command Code effort '${effort}' is not advertised for model ${model}`, 'effort_unsupported');
    return effort;
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

  private async prepareNativeHomeRoot(): Promise<void> {
    await ensurePrivateDirectory(this.config.nativeHomeDir, 'Command Code native home root');
  }

  /** Copy the operator's CLI auth into the session-private native home. */
  private async prepareNativeHome(sessionId: string): Promise<void> {
    await this.prepareNativeHomeRoot();
    const sessionHome = path.join(this.config.nativeHomeDir, sessionId);
    const commandCodeHome = path.join(sessionHome, '.commandcode');
    await ensurePrivateDirectory(sessionHome, 'Command Code session home');
    await ensurePrivateDirectory(commandCodeHome, 'Command Code private auth directory');
    await this.prepareNativeHomeMods(commandCodeHome);
    await this.prepareNativeHomeSkills(sessionHome);
    await this.prepareNativeHomeUserMemory(commandCodeHome);
    const source = path.join(process.env.HOME || '/root', '.commandcode', 'auth.json');
    const target = path.join(commandCodeHome, 'auth.json');

    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    const temporary = `${target}.${process.pid}.${cryptoRandomId()}.tmp`;
    try {
      sourceHandle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) return;
      try {
        const targetStat = await lstat(target);
        if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error('Command Code private auth binding drift');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      temporaryHandle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o400);
      const contents = await sourceHandle.readFile();
      await temporaryHandle.writeFile(contents);
      await temporaryHandle.chmod(0o400);
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      await sourceHandle?.close().catch(() => undefined);
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Mirror the operator's user-scope mods into the session-private native
   * home. The harness auto-loads mods from $HOME/.commandcode/mods only, and
   * each web-UI session runs with its own HOME, so without this copy the
   * operator's installed mods are invisible to spawned sessions. Best-effort:
   * mods must never break session creation, and symlinks are never followed
   * into the session home (regular files only, flat directory by convention).
   */
  private async prepareNativeHomeMods(commandCodeHome: string): Promise<void> {
    const sourceDir = path.join(process.env.HOME || '/root', '.commandcode', 'mods');
    let entries: Dirent<string>[];
    try {
      entries = await readdir(sourceDir, { withFileTypes: true });
    } catch {
      return; // No user-scope mods installed.
    }
    const targetDir = path.join(commandCodeHome, 'mods');
    for (const entry of entries) {
      // Dirent is lstat-based: isFile() is false for symlinks, so escapes
      // like a mods/escape.ts -> /etc/passwd link are skipped outright.
      if (!entry.isFile()) continue;
      try {
        await ensurePrivateDirectory(targetDir, 'Command Code session mods directory');
        await copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
      } catch {
        // A single unreadable mod must not block the others or the session.
      }
    }
  }

  /**
   * Replicate the operator's skills symlinks into the session-private native
   * home. The harness discovers skills from HOME-scoped locations
   * (~/.agents/skills and ~/.commandcode/skills), and each web-UI session runs
   * with its own HOME, so the operator's shared-skills symlinks are otherwise
   * invisible to spawned sessions. Only explicit symlinks are replicated —
   * each is recreated pointing at the same resolved source, mirroring the
   * operator's own topology 1:1. Best-effort: this must never break session
   * creation.
   */
  private async prepareNativeHomeSkills(sessionHome: string): Promise<void> {
    const operatorHome = process.env.HOME || '/root';
    for (const relative of ['.agents/skills', '.commandcode/skills']) {
      try {
        const source = path.join(operatorHome, relative);
        if (!(await lstat(source)).isSymbolicLink()) continue;
        const target = path.resolve(path.dirname(source), await readlink(source));
        const destination = path.join(sessionHome, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await rm(destination, { force: true }).catch(() => undefined);
        await symlink(target, destination);
      } catch {
        // A missing or unreadable skills location must never block a session.
      }
    }
  }

  /**
   * Mirror the operator's user-scope AGENTS.md (harness user memory, itself
   * kept in sync by the operator's host automation) into the session-private
   * native home as a read-only file, mirroring the auth.json pattern. Regular
   * files only: a symlinked or missing source is skipped. Best-effort: this
   * must never break session creation.
   */
  private async prepareNativeHomeUserMemory(commandCodeHome: string): Promise<void> {
    const source = path.join(process.env.HOME || '/root', '.commandcode', 'AGENTS.md');
    const target = path.join(commandCodeHome, 'AGENTS.md');
    const temporary = `${target}.${process.pid}.${cryptoRandomId()}.tmp`;
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      sourceHandle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      if (!(await sourceHandle.stat()).isFile()) return;
      temporaryHandle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o400);
      await temporaryHandle.writeFile(await sourceHandle.readFile());
      await temporaryHandle.chmod(0o400);
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, target);
    } catch {
      // No user memory, or an unreadable one, must never block a session.
    } finally {
      await sourceHandle?.close().catch(() => undefined);
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
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

function normalizedEventKey(event: NormalizedEvent): string {
  return JSON.stringify({ type: event.type, data: event.data });
}

/** Add one validated run usage to the session's cumulative usage. */
function accumulateTokenUsage(
  current: CommandCodeSessionTokenUsage | undefined,
  delta: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } | undefined,
): CommandCodeSessionTokenUsage | undefined {
  if (!delta) return current;
  const base = current ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const input = base.input + delta.input;
  const output = base.output + delta.output;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return current;
  return {
    input,
    output,
    cacheRead: base.cacheRead + (delta.cacheRead ?? 0),
    cacheWrite: base.cacheWrite + (delta.cacheWrite ?? 0),
    total: input + output,
  };
}

function countToolCalls(events: NormalizedEvent[]): number {
  let count = 0;
  for (const event of events) if (event.type === 'tool_execution_start') count += 1;
  return count;
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

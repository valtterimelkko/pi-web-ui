import { randomUUID } from 'node:crypto';
import { sessionIdentityFromEntry } from '../session-env-identity.js';
import { spawn } from 'node:child_process';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { DevinSessionStore, type DevinStoredToolCall, type DevinStoredUsage, DEVIN_STORED_TOOL_LIMIT, DEVIN_STORED_TOOL_OUTPUT_LIMIT } from './devin-session-store.js';
import { turnsToReplayEvents } from './devin-history-replay.js';
import { DevinSessionSubscribers } from './devin-session-subscribers.js';
import { getSessionRegistry } from '../session-registry.js';
import type { RegistryEntry } from '../session-registry.js';
import { config } from '../config.js';
import { createLogger } from '../logging/logger.js';
import { parseDevinModelsJson, toDevinCatalogEntries, resolveDevinLevelSwap, type DevinModelEntry } from './devin-models.js';
import { DevinAcpClient } from './devin-acp-client.js';
import { AcpEventAdapter } from './devin-event-adapter.js';
import { devinSpawnEnv } from './devin-spawn-env.js';

const logger = createLogger('DevinService');

/** Structured outcome of an auxiliary `devin` subprocess run (`--version`,
 *  `models list`). Never throws for a non-zero exit or a timeout. */
export interface DevinResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  reason?: string;
}

/** Run a short auxiliary devin command (no turn execution) with the D2
 *  allow-listed environment. Turns go through {@link DevinAcpClient}. */
export function runDevin(args: string[], timeoutMs: number, devinHome?: string, executablePath?: string): Promise<DevinResult> {
  const binary = executablePath ?? config.devinExecutablePath;
  const env = devinSpawnEnv(devinHome ?? config.devinHome, process.env);
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const hardTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, ok: false, reason: 'timeout' });
    }, timeoutMs + 5000);
    proc.on('error', (err) => {
      clearTimeout(hardTimer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(hardTimer);
      if (code === 0 || stdout.trim()) {
        resolve({ stdout, stderr, ok: true });
      } else {
        resolve({ stdout, stderr, ok: false, reason: `exit ${code}` });
      }
    });
  });
}

interface ActiveSessionMeta {
  lastActivity: number;
  pinned: boolean;
  pinClaims: Set<string>;
  status: 'idle' | 'running' | 'error';
}

function blankMeta(now = Date.now()): ActiveSessionMeta {
  return { lastActivity: now, pinned: false, pinClaims: new Set(), status: 'idle' };
}

interface QueuedTurn {
  prompt: string;
  onEvent: (event: NormalizedEvent) => void;
  onComplete: (err?: Error) => void;
}

/** Latest finalized turn of a session, in the shape the devin goal sweeper
 *  consumes (contract 1.68.0; antigravity shape). `status: 'error'` marks a
 *  turn that ended in a provider/runtime error with no assistant answer — the
 *  goal manager counts it as an error strike, never as an unmet turn. */
export interface DevinCompletedTurn {
  completedAt: number;
  response: string;
  status: 'done' | 'error';
  /** The error the runtime recorded (present when status === 'error'). */
  error?: string;
}

export interface DevinServiceOptions {
  registryPath: string;
  sessionDir?: string;
  executablePath?: string;
  devinHome?: string;
  /** Injectable spawn for ACP clients (tests). */
  spawnFn?: typeof spawn;
  /** Injectable `devin models list --format json` output (tests). */
  modelsOutput?: string;
  /** Test seam: override the DEVIN_ENABLED gate (unit tests opt in; production
   *  is gated by config.devinEnabled alone). */
  enabledOverride?: boolean;
  processIdleShutdownMs?: number;
}

export class DevinService {
  private store: DevinSessionStore;
  private subscribers = new DevinSessionSubscribers();
  private registry;
  private sessionMeta: Map<string, ActiveSessionMeta> = new Map();
  private runningSessions = new Set<string>();
  private startingSessions = new Set<string>();
  /** Live ACP children, one per live session (plan D1). */
  private clients = new Map<string, DevinAcpClient>();
  /** Turn adapters bound to the live children. */
  private adapters = new Map<string, AcpEventAdapter>();
  /** FIFO follow-up queue while a turn runs (antigravity semantics). */
  private turnQueues = new Map<string, QueuedTurn[]>();
  private promptCallbacks = new Map<string, { onEvent: (e: NormalizedEvent) => void; onComplete: (err?: Error) => void }>();
  private apiObservers: Map<string, Set<(event: NormalizedEvent) => void>> = new Map();
  private sessionEventSinks = new Map<string, (event: NormalizedEvent) => void>();
  private readonly spawnFn: typeof spawn | undefined;
  private readonly executablePath: string;
  private readonly devinHome: string | undefined;
  private readonly modelsOutput: string | undefined;
  private readonly enabledOverride: boolean | undefined;
  private modelCache: { expiresAt: number; models: DevinModelEntry[] } | null = null;
  private modelRequest: Promise<DevinModelEntry[]> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly cleanupIntervalMs: number;
  private readonly promptTimeoutMs: number;
  private readonly processIdleShutdownMs: number;
  /** Per-client idle-shutdown timers (plan D1: lazy spawn, idle shutdown). */
  private processIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: DevinServiceOptions) {
    this.store = new DevinSessionStore(opts.sessionDir ?? config.devinSessionDir);
    this.registry = getSessionRegistry(opts.registryPath);
    this.spawnFn = opts.spawnFn;
    this.executablePath = opts.executablePath ?? config.devinExecutablePath;
    this.devinHome = opts.devinHome ?? config.devinHome;
    this.modelsOutput = opts.modelsOutput;
    this.enabledOverride = opts.enabledOverride;
    this.idleTimeoutMs = config.devinIdleTimeoutMs;
    this.maxSessions = config.devinMaxSessions;
    this.cleanupIntervalMs = config.devinCleanupIntervalMs;
    this.promptTimeoutMs = config.devinPromptTimeoutMs;
    this.processIdleShutdownMs = opts.processIdleShutdownMs ?? config.devinProcessIdleShutdownMs;
    this.startCleanupInterval();
  }

  private startCleanupInterval(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), this.cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, meta] of this.sessionMeta) {
      if (meta.pinned) continue;
      if (this.runningSessions.has(sessionId)) continue;
      if (this.subscribers.getSubscriberCount(sessionId) > 0) continue;
      if (now - meta.lastActivity > this.idleTimeoutMs) {
        this.sessionMeta.delete(sessionId);
      }
    }
  }

  private enabled(): boolean {
    return this.enabledOverride ?? config.devinEnabled;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.enabled()) return false;
    try {
      const result = await runDevin(['--version'], 5000, this.devinHome, this.executablePath);
      return result.ok && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  getBackendMode(): 'acp' {
    return 'acp';
  }

  async validateSetup(): Promise<{ ok: boolean; error?: string }> {
    if (!this.enabled()) return { ok: false, error: 'Devin runtime is disabled (DEVIN_ENABLED!=true)' };
    const available = await this.isAvailable();
    if (!available) return { ok: false, error: 'devin binary not found or not executable' };
    return { ok: true };
  }

  async createSession(cwd: string, model?: string): Promise<{ sessionId: string }> {
    if (!this.enabled()) throw new Error('Devin is disabled');
    if (this.sessionMeta.size >= this.maxSessions) {
      this.evictOldestIdleSession();
    }
    const sessionId = randomUUID();
    this.sessionMeta.set(sessionId, blankMeta());
    const chosenModel = model || config.devinDefaultModel;
    await this.registry.upsert({
      id: sessionId,
      sdkType: 'devin',
      path: sessionId,
      cwd,
      model: chosenModel,
      firstMessage: '',
      messageCount: 0,
      status: 'idle',
    });
    return { sessionId };
  }

  private evictOldestIdleSession(): void {
    const candidates = [...this.sessionMeta.entries()]
      .filter(([, m]) => m.status === 'idle' && !m.pinned)
      .sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    if (candidates.length > 0) {
      const [evictId] = candidates[0];
      this.sessionMeta.delete(evictId);
    }
  }

  /** Send a user turn. Busy sessions refuse with SESSION_BUSY (steer is
   *  refused; follow-ups queue through {@link followUp}). */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    if (!this.enabled()) throw new Error('Devin is disabled');
    if (this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error(`SESSION_BUSY: devin session is already running a turn: ${sessionId}`);
    }
    this.startingSessions.add(sessionId);
    try {
      const entry = await this.registry.get(sessionId);
      if (!entry) throw new Error(`Devin session not found: ${sessionId}`);
      let meta = this.sessionMeta.get(sessionId);
      if (!meta) {
        meta = blankMeta();
        this.sessionMeta.set(sessionId, meta);
      }
      meta.status = 'running';
      meta.lastActivity = Date.now();
      this.runningSessions.add(sessionId);
      this.sessionEventSinks.set(sessionId, onEvent);
      this.promptCallbacks.set(sessionId, { onEvent, onComplete });
      try {
        await this.registry.updateStatus(sessionId, 'running');
      } catch (error) {
        this.runningSessions.delete(sessionId);
        this.promptCallbacks.delete(sessionId);
        meta.status = 'error';
        throw error;
      }
      void this.runTurn(sessionId, entry, prompt, meta, onEvent, onComplete);
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  /**
   * Queue a follow-up on a BUSY session (plan: FIFO, runs as the next turn —
   * antigravity semantics). Returns false when the session is not running a
   * turn; the caller should send a normal prompt instead. Steer is NOT
   * supported (the service refuses busy prompts with SESSION_BUSY).
   */
  async followUp(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<boolean> {
    if (!this.enabled()) throw new Error('Devin is disabled');
    if (!this.runningSessions.has(sessionId)) return false;
    const queue = this.turnQueues.get(sessionId) ?? [];
    queue.push({ prompt, onEvent, onComplete });
    this.turnQueues.set(sessionId, queue);
    let meta = this.sessionMeta.get(sessionId);
    if (!meta) {
      meta = blankMeta();
      meta.status = 'running';
      this.sessionMeta.set(sessionId, meta);
    }
    meta.lastActivity = Date.now();
    this.sessionEventSinks.set(sessionId, onEvent);
    return true;
  }

  private drainQueue(sessionId: string): void {
    const queue = this.turnQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      this.turnQueues.delete(sessionId);
      return;
    }
    const next = queue.shift();
    if (!next) return;
    if (queue.length === 0) this.turnQueues.delete(sessionId);
    const entryPromise = this.registry.get(sessionId);
    void entryPromise.then((entry) => {
      if (!entry) {
        next.onComplete(new Error(`Devin session not found: ${sessionId}`));
        return;
      }
      let meta = this.sessionMeta.get(sessionId);
      if (!meta) {
        meta = blankMeta();
        meta.status = 'running';
        this.sessionMeta.set(sessionId, meta);
      }
      meta.status = 'running';
      this.runningSessions.add(sessionId);
      this.promptCallbacks.set(sessionId, { onEvent: next.onEvent, onComplete: next.onComplete });
      void this.registry.updateStatus(sessionId, 'running').catch(() => undefined);
      void this.runTurn(sessionId, entry, next.prompt, meta, next.onEvent, next.onComplete);
    }, () => next.onComplete(new Error(`Devin session registry unavailable: ${sessionId}`)));
  }

  /** Core turn runner: acquire (or respawn) the session's ACP client, run the
   *  prompt, stream adapter events, persist the turn, ALWAYS emit agent_end. */
  private async runTurn(
    sessionId: string,
    entry: RegistryEntry,
    prompt: string,
    meta: ActiveSessionMeta,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    const turnId = randomUUID();
    const ts = Date.now();
    const tlog = logger.child({ sessionId, turnId, runtime: 'devin' });

    const emit = (event: NormalizedEvent) => {
      try { onEvent(event); } catch { /* non-fatal */ }
      this.emitApiObserverEvent(sessionId, event);
    };

    const finalizeRunState = (error?: Error) => {
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      meta.lastActivity = Date.now();
      onComplete(error);
      // Drain any queued follow-ups as the next turn.
      this.drainQueue(sessionId);
    };

    const historyBefore = await this.store.loadHistory(sessionId);
    const isFirstMessage = historyBefore.length === 0;
    const storedModel = entry.model || config.devinDefaultModel;
    let storedNativeId = entry.devinNativeSessionId ?? entry.nativeSessionId ?? null;

    // RC1 durability: persist the prompt the instant it is accepted.
    await this.store.startTurn(sessionId, {
      turnId,
      prompt,
      model: storedModel,
      nativeSessionId: storedNativeId,
      timestamp: ts,
    });
    await this.registry.upsert({
      ...entry,
      id: sessionId,
      sdkType: 'devin',
      firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
      messageCount: entry.messageCount ?? 0,
      status: 'running',
    });
    tlog.info('turn start: model=%s nativeId=%s promptChars=%d', storedModel, storedNativeId ?? 'none', prompt.length);

    emit({ type: 'agent_start', sessionId, timestamp: ts, data: { sessionId } });
    const userId = randomUUID();
    emit({ type: 'message_start', sessionId, timestamp: ts, data: { id: userId, role: 'user' } });
    emit({ type: 'message_update', sessionId, timestamp: ts, data: { id: userId, assistantMessageEvent: { type: 'text_delta', delta: prompt } } });
    emit({ type: 'message_end', sessionId, timestamp: ts, data: { id: userId } });

    const startedAt = Date.now();
    try {
      // Acquire or respawn the session's ACP child. A respawn resumes the
      // native session (session/load replays history server-side; our store
      // holds the replayable turns). Review fix 1: the client itself drops
      // `session/update` notifications that arrive during session/load, and
      // the live turn adapter is created/reset immediately before
      // session/prompt below — a replay can never reach this turn's stream,
      // finalText or agent_end result.
      let client = this.clients.get(sessionId);
      if (!client || client.hasExited) {
        client = new DevinAcpClient({
          cwd: (entry.cwd && entry.cwd.trim()) ? entry.cwd : process.cwd(),
          devinHome: this.devinHome ?? config.devinHome,
          executablePath: this.executablePath,
          ...(storedNativeId ? { resumeNativeSessionId: storedNativeId } : {}),
          ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
          sessionIdentity: sessionIdentityFromEntry(entry),
        });
        const started = await client.start();
        if (started.nativeSessionId !== storedNativeId) {
          storedNativeId = started.nativeSessionId;
          entry.devinNativeSessionId = started.nativeSessionId;
          entry.nativeSessionId = started.nativeSessionId;
          void this.registry.upsert({
            id: sessionId,
            sdkType: 'devin',
            cwd: entry.cwd,
            devinNativeSessionId: started.nativeSessionId,
            nativeSessionId: started.nativeSessionId,
          }).catch((err) => tlog.warn('failed to persist native session id: %s', err instanceof Error ? err.message : String(err)));
        }
        this.clients.set(sessionId, client);
        this.armProcessIdleTimer(sessionId);
        // Ensure the session's model config option matches the registry (the
        // spawn flag LOSES to the config file — plan §2 — so the model travels
        // per session through session/set_config_option). Review fix 4: a
        // failed model set fails the turn with a clear error — never a silent
        // turn on the CLI's default model while the registry says otherwise.
        const desiredModel = entry.model || config.devinDefaultModel;
        if (desiredModel) {
          try {
            await client.setConfigOption('model', desiredModel);
          } catch (err) {
            // Closure N2: never keep a child that is on the wrong model — stop and
            // drop it, so the next turn respawns and re-applies the model.
            this.clients.delete(sessionId);
            client.stop();
            throw err;
          }
        }
      }

      // Review fix 1: the turn adapter is created/reset immediately before
      // session/prompt — nothing from the handshake or a session/load replay
      // can leak into this turn's stream or accumulated turn text.
      const adapter = new AcpEventAdapter(sessionId);
      this.adapters.set(sessionId, adapter);
      client.onSessionUpdate((update) => {
        for (const ev of adapter.onSessionUpdate(update, Date.now())) emit(ev);
      });

      // Turn watchdog: cancel a turn that outlives the prompt timeout; the
      // pending prompt then resolves cancelled and the turn finalizes.
      const activeClient = client;
      const watchdog = setTimeout(() => {
        tlog.warn('turn exceeded prompt timeout (%dms); cancelling', this.promptTimeoutMs);
        activeClient.cancel();
      }, this.promptTimeoutMs);
      if (watchdog.unref) watchdog.unref();

      const result = await client.prompt(prompt);
      clearTimeout(watchdog);
      const durationMs = Date.now() - startedAt;

      const usage: DevinStoredUsage = {
        input: result.usage.input ?? 0,
        output: result.usage.output ?? 0,
        cacheRead: result.usage.cachedRead ?? 0,
        total: result.usage.total ?? (result.usage.input ?? 0) + (result.usage.output ?? 0),
      };
      const tools: DevinStoredToolCall[] = adapter.tools.slice(0, DEVIN_STORED_TOOL_LIMIT).map((t) => ({
        toolName: t.toolName,
        ...(t.args !== undefined ? { args: t.args } : {}),
        ...(t.output !== undefined ? { output: t.output.length > DEVIN_STORED_TOOL_OUTPUT_LIMIT ? `${t.output.slice(0, DEVIN_STORED_TOOL_OUTPUT_LIMIT)}… [truncated]` : t.output } : {}),
        isError: t.isError,
        ...(t.output === undefined && t.isError ? { output: '' } : {}),
      }));

      const isCancelled = result.cancelled;
      const failed = !isCancelled && (result.stopReason === 'error' || result.error !== undefined);
      const response = adapter.turnText || (isCancelled ? '' : (failed ? `The Devin turn failed (${result.error ?? result.stopReason ?? 'error'}).` : ''));

      // Close the streamed assistant message, then ALWAYS agent_end (also on
      // cancel and error — brief design point 4).
      const closing = adapter.closeTurn({
        usage: { input: usage.input, output: usage.output, ...(usage.cacheRead ? { cachedRead: usage.cacheRead } : {}), ...(usage.total ? { total: usage.total } : {}) },
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        cancelled: isCancelled,
        ...(failed ? { error: result.error ?? result.stopReason ?? 'error' } : {}),
      }, Date.now());
      for (const ev of closing) emit(ev);

      await this.store.finalizeTurn(sessionId, turnId, {
        status: failed ? 'error' : 'done',
        response: response || (isCancelled ? '' : (failed ? `The Devin turn failed (${result.error ?? result.stopReason ?? 'error'}).` : '')),
        nativeSessionId: storedNativeId,
        turnDurationMs: durationMs,
        usage,
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        ...(isCancelled ? { cancelled: true } : {}),
        ...(failed ? { error: result.error ?? result.stopReason ?? 'error' } : {}),
        tools,
      });
      await this.registry.upsert({
        ...entry,
        id: sessionId,
        sdkType: 'devin',
        firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
        messageCount: (entry.messageCount || 0) + 1,
        status: failed ? 'error' : 'idle',
        ...(storedNativeId ? { devinNativeSessionId: storedNativeId, nativeSessionId: storedNativeId } : {}),
      });

      tlog.info('turn done in %dms: stopReason=%s responseChars=%d tools=%d', durationMs, result.stopReason ?? 'none', adapter.turnText.length, tools.length);

      meta.status = failed ? 'error' : 'idle';
      await this.registry.updateStatus(sessionId, meta.status);
      finalizeRunState(failed ? new Error(result.error ?? result.stopReason ?? 'devin turn failed') : undefined);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const reason = error.message || 'error';
      tlog.error('turn errored before completion: %s', reason);
      const body = `The Devin turn failed (${reason}).`;
      const closing = this.closeTurnForError(sessionId, body, Date.now());
      for (const ev of closing) emit(ev);
      await this.store.finalizeTurn(sessionId, turnId, {
        status: 'error',
        response: body,
        error: reason,
        nativeSessionId: storedNativeId,
        turnDurationMs: Date.now() - startedAt,
      }).catch(() => undefined);
      await this.registry.upsert({
        ...entry,
        id: sessionId,
        sdkType: 'devin',
        firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
        messageCount: (entry.messageCount || 0) + 1,
        status: 'error',
        ...(storedNativeId ? { devinNativeSessionId: storedNativeId, nativeSessionId: storedNativeId } : {}),
      }).catch(() => undefined);
      meta.status = 'error';
      finalizeRunState(error);
    }
  }

  /** adapter-less error close: emit an error-body assistant triple + agent_end. */
  private closeTurnForError(sessionId: string, body: string, ts: number): NormalizedEvent[] {
    const id = randomUUID();
    return [
      { type: 'message_start', sessionId, timestamp: ts, data: { id, role: 'assistant' } },
      { type: 'message_update', sessionId, timestamp: ts, data: { id, assistantMessageEvent: { type: 'text_delta', delta: body } } },
      { type: 'message_end', sessionId, timestamp: ts, data: { id } },
      { type: 'agent_end', sessionId, timestamp: ts, data: { result: null, usage: {}, error: body } },
    ];
  }

  /** Plan D1: shut an idle child down after this long with no turn. The next
   *  turn respawns with session/load. */
  private armProcessIdleTimer(sessionId: string): void {
    const existing = this.processIdleTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.processIdleTimers.delete(sessionId);
      if (this.runningSessions.has(sessionId)) return; // busy: keep the child
      this.shutdownProcess(sessionId);
    }, this.processIdleShutdownMs);
    if (timer.unref) timer.unref();
    this.processIdleTimers.set(sessionId, timer);
  }

  /** Stop and forget the session's ACP child (idle shutdown, abort, dispose). */
  shutdownProcess(sessionId: string): void {
    const client = this.clients.get(sessionId);
    if (client) {
      client.stop();
      this.clients.delete(sessionId);
      this.adapters.delete(sessionId);
    }
    const timer = this.processIdleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.processIdleTimers.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    const client = this.clients.get(sessionId);
    logger.info('abort: sessionId=%s hasClient=%s', sessionId, Boolean(client));
    if (client) {
      client.cancel();
    }
    // Review fix 5: abort stops everything pending for this session — queued
    // follow-ups are cleared with an abort error instead of draining as the
    // next turn after the cancellation lands.
    const queued = this.turnQueues.get(sessionId);
    if (queued) {
      for (const item of queued) item.onComplete(new Error('Devin session aborted; queued follow-up cancelled'));
      this.turnQueues.delete(sessionId);
    }
  }

  disposeSession(sessionId: string): void {
    this.shutdownProcess(sessionId);
    const queued = this.turnQueues.get(sessionId);
    if (queued) {
      for (const item of queued) item.onComplete(new Error('Devin session disposed'));
      this.turnQueues.delete(sessionId);
    }
    this.sessionMeta.delete(sessionId);
    this.runningSessions.delete(sessionId);
    this.startingSessions.delete(sessionId);
    this.promptCallbacks.delete(sessionId);
    this.sessionEventSinks.delete(sessionId);
    this.apiObservers.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMeta.has(sessionId);
  }

  async getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const history = await this.store.loadHistory(sessionId);
    return turnsToReplayEvents(history as unknown as Parameters<typeof turnsToReplayEvents>[0], sessionId);
  }

  async listSessions() {
    return this.registry.listBySdkType('devin');
  }

  async getSession(sessionId: string) {
    return this.registry.get(sessionId);
  }

  async ensureSession(sessionId: string): Promise<boolean> {
    if (this.sessionMeta.has(sessionId)) return true;
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'devin') return false;
    this.sessionMeta.set(sessionId, blankMeta());
    return true;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (meta) meta.lastActivity = Date.now();
  }

  async getSessionCwd(sessionId: string): Promise<string | undefined> {
    const entry = await this.registry.get(sessionId).catch(() => null);
    return entry && entry.sdkType === 'devin' ? entry.cwd : undefined;
  }

  /** The model id actually applied for this session's next run (contract
n  * 1.68.0 receipt truth). The registry stores a model only after a successful
n  * `session/set_config_option` (closure N1), so the registry binding — or the
n  * configured default when the session has none — is exactly what the child
n  * is served on. */
  async getServedModel(sessionId: string): Promise<string | undefined> {
    const entry = await this.registry.get(sessionId).catch(() => null);
    if (!entry || entry.sdkType !== 'devin') return undefined;
    return entry.model || config.devinDefaultModel;
  }

  /** Model switch: set the session's `model` config option (the spawn flag
   *  LOSES to the config file — plan §2). Busy → 409-style refusal (plan D4). */
  async setModel(sessionId: string, modelId: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    if (this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error(`SESSION_BUSY: model changes apply between turns`);
    }
    // Ruling 01 (2026-11-08): every catalogue model is allowed; no allow-list.
    // A live child applies it first; only a successful set is recorded, so the
    // registry never names a model the child is not using (closure N1). A
    // respawned child applies the registry model at spawn. A failed
    // set_config_option surfaces — the Internal API control maps it to 4xx.
    const client = this.clients.get(sessionId);
    if (client && !client.hasExited) {
      await client.setConfigOption('model', modelId);
    }
    await this.registry.upsert({ ...entry, id: entry.id, sdkType: 'devin', model: modelId });
    return modelId;
  }

  /** Thinking-level selection = sibling-model swap (plan D4). Busy → 409-style
   *  refusal; idle → sibling id becomes the session's model. */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    if (this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error(`SESSION_BUSY: thinking level changes apply between turns`);
    }
    const catalogue = await this.getAvailableModels();
    const current = catalogue.find((m) => m.id === (entry.model || config.devinDefaultModel));
    const resolution = resolveDevinLevelSwap(current, level, catalogue);
    if (!resolution.ok) throw new Error(resolution.reason);
    return this.setModel(sessionId, resolution.slug);
  }

  async pinSession(sessionId: string, claimId = 'web-ui'): Promise<boolean> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    if (meta.pinClaims.has(claimId)) return true;
    if (claimId === 'web-ui') {
      const humanPinned = [...this.sessionMeta.values()].filter((item) => item.pinClaims.has('web-ui')).length;
      const maxPinned = config.devinMaxSessions;
      if (humanPinned >= Math.min(5, maxPinned)) return false;
    }
    meta.pinClaims.add(claimId);
    meta.pinned = true;
    return true;
  }

  unpinSession(sessionId: string, claimId = 'web-ui'): boolean {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    meta.pinClaims.delete(claimId);
    meta.pinned = meta.pinClaims.size > 0;
    if (!meta.pinned) meta.lastActivity = Date.now();
    return true;
  }

  isSessionPinned(sessionId: string): boolean {
    return this.sessionMeta.get(sessionId)?.pinned ?? false;
  }

  getSubscriberTracker(): DevinSessionSubscribers {
    return this.subscribers;
  }

  async getSessionStats(sessionId: string): Promise<{
    sessionId: string;
    cwd: string;
    model: string | undefined;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    totalMessages: number;
    pinned: boolean;
    tokens: { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number; total: number };
    sessionFile: string;
    nativeSessionId?: string;
  } | null> {
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'devin') return null;
    const history = await this.store.loadHistory(sessionId);
    const finalized = history.filter((t) => t.status !== 'running');
    const finalizedCount = finalized.length;
    const toolCalls = finalized.reduce((acc, t) => acc + (t.tools?.length ?? 0), 0);
    const tokens = finalized.reduce(
      (acc, t) => ({
        input: acc.input + (t.usage?.input ?? 0),
        output: acc.output + (t.usage?.output ?? 0),
        thinking: 0,
        cacheRead: acc.cacheRead + (t.usage?.cacheRead ?? 0),
        cacheWrite: 0,
        total: acc.total + (t.usage?.total ?? 0),
      }),
      { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    );
    return {
      sessionId,
      cwd: entry.cwd,
      model: entry.model,
      userMessages: finalizedCount,
      assistantMessages: finalizedCount,
      toolCalls,
      toolResults: toolCalls,
      totalMessages: finalizedCount * 2,
      pinned: this.sessionMeta.get(sessionId)?.pinned ?? false,
      tokens,
      sessionFile: this.store.sessionFilePath(sessionId),
      ...(entry.devinNativeSessionId ? { nativeSessionId: entry.devinNativeSessionId } : {}),
    };
  }

  /** Model catalogue from `devin models list --format json`, cached 60s. */
  async getAvailableModels(): Promise<DevinModelEntry[]> {
    if (!this.enabled()) return [];
    if (this.modelsOutput !== undefined) {
      if (!this.modelCache || this.modelCache.expiresAt <= Date.now()) {
        this.modelCache = { expiresAt: Date.now() + 60_000, models: toDevinCatalogEntries(parseDevinModelsJson(this.modelsOutput).families) };
      }
      return this.modelCache.models;
    }
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;
    if (this.modelRequest) return this.modelRequest;
    this.modelRequest = (async () => {
      let models: DevinModelEntry[];
      try {
        const result = await runDevin(['models', 'list', '--format', 'json'], 20_000, this.devinHome, this.executablePath);
        if (!result.ok) throw new Error(`devin models list failed: ${result.reason ?? 'unknown'}`);
        models = toDevinCatalogEntries(parseDevinModelsJson(result.stdout).families);
      } catch {
        // Fail open with the last known cache when the CLI cannot run; an
        // empty list otherwise (callers show an empty picker).
        models = this.modelCache?.models ?? [];
      }
      this.modelCache = { expiresAt: Date.now() + 60_000, models };
      return models;
    })().finally(() => { this.modelRequest = null; });
    return this.modelRequest;
  }

  // ── API observers (origin-independent event fan-out) ─────────────────────

  addApiObserver(sessionId: string, observer: (event: NormalizedEvent) => void): void {
    let observers = this.apiObservers.get(sessionId);
    if (!observers) {
      observers = new Set();
      this.apiObservers.set(sessionId, observers);
    }
    observers.add(observer);
  }

  removeApiObserver(sessionId: string, observer: (event: NormalizedEvent) => void): void {
    const observers = this.apiObservers.get(sessionId);
    if (!observers) return;
    observers.delete(observer);
    if (observers.size === 0) this.apiObservers.delete(sessionId);
  }

  private emitApiObserverEvent(sessionId: string, event: NormalizedEvent): void {
    const observers = this.apiObservers.get(sessionId);
    if (!observers || observers.size === 0) return;
    for (const observer of observers) {
      try { observer(event); } catch { /* non-fatal */ }
    }
  }

  /** Last finalized turn summary (goal-manager parity, antigravity shape). */
  async getLastCompletedTurn(sessionId: string): Promise<DevinCompletedTurn | null> {
    const history = await this.store.loadHistory(sessionId);
    const finalized = history.filter((t) => t.status !== 'running');
    const last = finalized[finalized.length - 1];
    if (!last) return null;
    const derived = last.turnDurationMs !== undefined ? last.timestamp + last.turnDurationMs : last.timestamp;
    const summary: DevinCompletedTurn = { completedAt: derived, response: last.response ?? '', status: last.status === 'error' ? 'error' : 'done' };
    if (last.error !== undefined) summary.error = last.error;
    return summary;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const [sessionId] of this.clients) {
      this.shutdownProcess(sessionId);
    }
    this.clients.clear();
    this.processIdleTimers.clear();
  }

  /** Test seam: run an auxiliary devin command through the service's env. */
  async runAuxForTest(args: string[], timeoutMs = 5000): Promise<DevinResult> {
    return runDevin(args, timeoutMs, this.devinHome, this.executablePath);
  }
}

let instance: DevinService | null = null;

export function getDevinService(): DevinService {
  if (instance === null) {
    instance = new DevinService({ registryPath: config.sessionRegistryPath });
  }
  return instance;
}

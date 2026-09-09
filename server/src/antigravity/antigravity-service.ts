import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { AntigravitySessionStore } from './antigravity-session-store.js';
import { isTurnDone } from './antigravity-session-store.js';
import { turnsToReplayEvents } from './antigravity-history-replay.js';
import { AntigravitySessionSubscribers } from './antigravity-session-subscribers.js';
import { getSessionRegistry } from '../session-registry.js';
import type { RegistryEntry } from '../session-registry.js';
import { config } from '../config.js';
import { createLogger } from '../logging/logger.js';
import { parseAgyModelsOutput, toCatalogEntries, canonicalizeAgyModelId, resolveModelSlug, type AgyModelEntry, type ParsedAgyModel } from './agy-models.js';
import { AgyStreamProcess, type AgyTurnOutcome } from './agy-stream-process.js';
import { AgyEventNormalizer } from './agy-event-normalizer.js';
import type { AgyStoredToolCall, AgyStoredUsage } from './antigravity-session-store.js';
import { AGY_STORED_TOOL_LIMIT, AGY_STORED_TOOL_OUTPUT_LIMIT } from './antigravity-session-store.js';

const logger = createLogger('AntigravityService');


const AGY_BINARY = process.env.AGY_BINARY || '/root/.local/bin/agy';

// Rough character-to-token ratio. Gemini tokenisation is broadly similar to
// other LLMs for mixed English + code content (~4 chars per token on average).

// Maps agy model identifiers to their known context window sizes (in tokens).
// Both slug prefixes (canonical since the 1.1.27 stream integration) and
// legacy label prefixes (old sessions) are matched; best-effort mapping.
export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
  ['gemini-3.8-flash', 1_048_576],
  ['gemini-3.7-flash', 1_048_576],
  ['gemini-3.6-flash', 1_048_576],
  ['Gemini 3.5 Flash', 1_048_576],   // legacy label form
  ['gemini-3.1-pro',   2_097_152],
  ['Gemini 3.1 Pro',   2_097_152],   // legacy label form
  ['claude-sonnet',      200_000],
  ['Claude Sonnet',      200_000],
  ['claude-opus',        200_000],
  ['Claude Opus',        200_000],
  ['gpt-oss',            128_000],
  ['GPT-OSS',            128_000],
];

const DEFAULT_CONTEXT_WINDOW = 1_048_576; // Flash is the default model

/** Returns the context window (tokens) for an agy model id (slug or legacy
 *  label), falling back to the Flash window when unrecognised. */
export function getModelContextWindow(model: string): number {
  const normalized = canonicalizeAgyModelId(model);
  for (const [prefix, size] of ANTIGRAVITY_MODEL_CONTEXT_WINDOWS) {
    if (normalized.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Structured outcome of an auxiliary agy subprocess run (`--version`,
 *  `models`). Never throws for a non-zero exit or a timeout — those resolve
 *  with `ok:false` and a `reason`. Only a spawn-level failure rejects. */
export interface AgyResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  reason?: string;
}

/** Run a short auxiliary agy command (no turn execution). Turns go through
 *  {@link AgyStreamProcess}; this is only for catalog/version probes. */
export function runAgy(args: string[], cwd: string, timeoutMs: number, stallTimeoutMs?: number, logFilePath?: string, signal?: AbortSignal): Promise<AgyResult> {
  if (signal?.aborted) {
    return Promise.resolve({ stdout: '', stderr: '', ok: false, reason: 'aborted' });
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `/root/.local/bin:${process.env.PATH ?? ''}` };
    const proc = spawn(AGY_BINARY, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    let stallPoll: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => {
      proc.kill('SIGTERM');
      cleanup();
      resolve({ stdout, stderr, ok: false, reason: 'aborted' });
    };
    const cleanup = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (stallPoll) clearInterval(stallPoll);
      signal?.removeEventListener('abort', onAbort);
    };

    const hardTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      resolve({ stdout, stderr, ok: false, reason: 'timeout' });
    }, timeoutMs + 5000);

    let lastProgressAt = Date.now();
    let lastLogMtimeMs = -1;
    if (stallTimeoutMs !== undefined && logFilePath !== undefined) {
      const pollIntervalMs = Math.max(10, Math.min(5000, Math.floor(stallTimeoutMs / 4)));
      stallPoll = setInterval(() => {
        void stat(logFilePath)
          .then((info) => {
            if (info.mtimeMs > lastLogMtimeMs) {
              lastLogMtimeMs = info.mtimeMs;
              lastProgressAt = Date.now();
            }
          })
          .catch(() => { /* log file not created yet */ })
          .finally(() => {
            if (Date.now() - lastProgressAt >= stallTimeoutMs) {
              proc.kill('SIGTERM');
              cleanup();
              resolve({ stdout, stderr, ok: false, reason: 'stall' });
            }
          });
      }, pollIntervalMs);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });

    proc.on('close', (code) => {
      cleanup();
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

export class AntigravityService {
  private store: AntigravitySessionStore;
  private subscribers: AntigravitySessionSubscribers;
  private registry;
  private sessionMeta: Map<string, ActiveSessionMeta> = new Map();
  private runningSessions: Set<string> = new Set();
  private startingSessions: Set<string> = new Set();
  private promptAbortControllers = new Map<string, AbortController>();
  /** Persistent agy stream-json processes, one per live session (stream mode). */
  private streamProcesses = new Map<string, AgyStreamProcess>();
  /** Stream event normalizers, keyed with their process. */
  private streamNormalizers = new Map<string, AgyEventNormalizer>();
  /** Injectable spawn for stream processes (tests); production uses real spawn. */
  private readonly streamSpawnFn: typeof import('node:child_process').spawn | undefined;
  private promptCallbacks: Map<string, {
    onEvent: (e: NormalizedEvent) => void;
    onComplete: (err?: Error) => void;
  }> = new Map();
  /** API observers — receive every normalized event for a session, regardless of which client prompted. */
  private apiObservers: Map<string, Set<(event: NormalizedEvent) => void>> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly maxPinnedSessions: number;
  private readonly cleanupIntervalMs: number;
  private readonly promptTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly maxAttempts: number;
  private modelCache: { expiresAt: number; models: AgyModelEntry[] } | null = null;
  private modelRequest: Promise<AgyModelEntry[]> | null = null;

  constructor(cfg: { registryPath: string; streamSpawnFn?: typeof import('node:child_process').spawn }) {
    this.store = new AntigravitySessionStore(config.antigravitySessionDir);
    this.subscribers = new AntigravitySessionSubscribers();
    this.registry = getSessionRegistry(cfg.registryPath);
    this.streamSpawnFn = cfg.streamSpawnFn;

    this.idleTimeoutMs = config.antigravityIdleTimeoutMs;
    this.maxSessions = config.antigravityMaxSessions;
    this.maxPinnedSessions = config.antigravityMaxPinnedSessions;
    this.cleanupIntervalMs = config.antigravityCleanupIntervalMs;
    this.promptTimeoutMs = config.antigravityPromptTimeoutMs;
    this.stallTimeoutMs = config.antigravityStallTimeoutMs;
    this.maxAttempts = config.antigravityMaxAttempts;

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

  async isAvailable(): Promise<boolean> {
    if (!config.antigravityEnabled) return false;
    try {
      const result = await runAgy(['--version'], process.cwd(), 5000);
      return result.ok && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Backend projection for the capabilities route. */
  getBackendMode(): 'stream-json' {
    return 'stream-json';
  }

  async validateSetup(): Promise<{ ok: boolean; error?: string }> {
    const available = await this.isAvailable();
    if (!available) {
      return { ok: false, error: 'agy binary not found or not executable' };
    }
    return { ok: true };
  }

  async createSession(cwd: string, model?: string): Promise<{ sessionId: string }> {
    if (!config.antigravityEnabled) throw new Error('Antigravity is disabled');
    if (this.sessionMeta.size >= this.maxSessions) {
      this.evictOldestIdleSession();
    }

    const sessionId = randomUUID();
    this.sessionMeta.set(sessionId, { lastActivity: Date.now(), pinned: false, pinClaims: new Set(), status: 'idle' });

    const chosenModel = model || config.antigravityDefaultModel;
    await this.registry.upsert({
      id: sessionId,
      sdkType: 'antigravity',
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

  async sendPrompt(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    if (!config.antigravityEnabled) throw new Error('Antigravity is disabled');
    if (this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error(`Antigravity session is already running: ${sessionId}`);
    }
    this.startingSessions.add(sessionId);
    try {
      const entry = await this.registry.get(sessionId);
      if (!entry) throw new Error(`Antigravity session not found: ${sessionId}`);

      let meta = this.sessionMeta.get(sessionId);
      if (!meta) {
        meta = { lastActivity: Date.now(), pinned: false, pinClaims: new Set(), status: 'idle' };
        this.sessionMeta.set(sessionId, meta);
      }

      meta.status = 'running';
      meta.lastActivity = Date.now();
      this.runningSessions.add(sessionId);
      const abortController = new AbortController();
      this.promptAbortControllers.set(sessionId, abortController);
      this.promptCallbacks.set(sessionId, { onEvent, onComplete });
      try {
        await this.registry.updateStatus(sessionId, 'running');
      } catch (error) {
        this.runningSessions.delete(sessionId);
        this.promptAbortControllers.delete(sessionId);
        this.promptCallbacks.delete(sessionId);
        meta.status = 'error';
        throw error;
      }

      void this.runStreamTurn(sessionId, entry, prompt, meta, onEvent, onComplete, abortController);
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  /**
   * Queue a follow-up prompt on a BUSY stream-mode session (plan Phase 5).
   * The prompt is written through to the agy stdin stream; agy buffers it and
   * executes it as the next turn (live-validated queue semantics). Durable
   * like any turn: persisted as `running` immediately (RC1).
   *
   * Returns false when the session is not running a turn — the caller should
   * send a normal prompt instead.
   */
  async followUp(
    sessionId: string,
    prompt: string,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<boolean> {
    if (!config.antigravityEnabled) throw new Error('Antigravity is disabled');
    const proc = this.streamProcesses.get(sessionId);
    if (!proc || proc.hasExited || !proc.hasPendingTurns) return false;
    if (this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      // Busy is the expected state here, but a racing prompt path may have
      // flagged starting; refuse politely instead of double-writing.
    }
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`Antigravity session not found: ${sessionId}`);

    let meta = this.sessionMeta.get(sessionId);
    if (!meta) {
      meta = { lastActivity: Date.now(), pinned: false, pinClaims: new Set(), status: 'running' };
      this.sessionMeta.set(sessionId, meta);
    }
    meta.lastActivity = Date.now();
    void this.runStreamTurn(sessionId, entry, prompt, meta, onEvent, onComplete, null);
    return true;
  }

  /**
   * Stream-mode turn runner (plan Phase 4): reuses the persistent agy stream
   * process when alive, respawns with `--conversation` otherwise, and feeds
   * the normalizer's events straight through to subscribers + API observers.
   * Durable ordering invariant preserved from the legacy path: the turn is
   * persisted BEFORE the terminal `agent_end` is emitted.
   */
  private async runStreamTurn(
    sessionId: string,
    entry: RegistryEntry,
    prompt: string,
    meta: ActiveSessionMeta,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
    abortController: AbortController | null,
  ): Promise<void> {
    const turnId = randomUUID();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const ts = Date.now();
    const tlog = logger.child({ sessionId, turnId, runtime: 'antigravity' });

    const emit = (event: NormalizedEvent) => {
      try { onEvent(event); } catch { /* non-fatal */ }
      this.emitApiObserverEvent(sessionId, event);
    };

    const cleanupRunState = (error?: Error) => {
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      if (abortController) this.promptAbortControllers.delete(sessionId);
      onComplete(error);
    };

    const historyBefore = await this.store.loadHistory(sessionId);
    const isFirstMessage = historyBefore.length === 0;
    const storedModel = entry.model || config.antigravityDefaultModel;
    let storedConversationId = entry.antigravityConversationId ?? null;
    if (!storedConversationId) {
      for (let i = historyBefore.length - 1; i >= 0; i--) {
        if (isTurnDone(historyBefore[i]) && historyBefore[i].conversationId) {
          storedConversationId = historyBefore[i].conversationId;
          break;
        }
      }
    }

    // RC1 durability: persist the prompt the instant it is accepted.
    await this.store.startTurn(sessionId, {
      turnId,
      prompt,
      model: storedModel,
      conversationId: storedConversationId,
      timestamp: ts,
    });
    await this.registry.upsert({
      ...entry,
      id: sessionId,
      sdkType: 'antigravity',
      firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
      messageCount: entry.messageCount ?? 0,
      status: 'running',
    });
    tlog.info('stream turn start: model=%s conversationId=%s promptChars=%d', storedModel, storedConversationId ?? 'none', prompt.length);

    emit({ type: 'agent_start', sessionId, timestamp: ts, data: { sessionId } });
    emit({ type: 'message_start', sessionId, timestamp: ts, data: { id: userId, role: 'user' } });
    emit({
      type: 'message_update', sessionId, timestamp: ts,
      data: { id: userId, assistantMessageEvent: { type: 'text_delta', delta: prompt } },
    });
    emit({ type: 'message_end', sessionId, timestamp: ts, data: { id: userId } });

    const startedAt = Date.now();
    try {
      const modelSlug = canonicalizeAgyModelId(storedModel);
      let proc = this.streamProcesses.get(sessionId);
      let normalizer = this.streamNormalizers.get(sessionId);
      let norm = normalizer ?? new AgyEventNormalizer({ sessionId, suppressTerminalEvents: true });

      const spawnProcess = async (conversationId: string | null): Promise<AgyStreamProcess> => {
        norm = new AgyEventNormalizer({ sessionId, suppressTerminalEvents: true });
        const fresh = new AgyStreamProcess({
          sessionId,
          cwd: entry.cwd,
          model: modelSlug,
          conversationId,
          timeoutMs: this.promptTimeoutMs,
          stallTimeoutMs: this.stallTimeoutMs,
          idleTimeoutMs: this.idleTimeoutMs,
          onEvent: (parsed) => {
            for (const ev of norm.onParsed(parsed, Date.now())) emit(ev);
          },
          ...(this.streamSpawnFn ? { spawnFn: this.streamSpawnFn } : {}),
        });
        await fresh.start();
        this.streamProcesses.set(sessionId, fresh);
        this.streamNormalizers.set(sessionId, norm);
        return fresh;
      };
      if (!proc || proc.hasExited || !normalizer) {
        proc = await spawnProcess(storedConversationId);
        normalizer = norm;
      }

      // Bounded retry: stall/timeout die with the process (SIGTERM) → respawn
      // with the conversation the dead process reported; a plain agy ERROR or
      // SUCCESS never retries.
      let outcome: AgyTurnOutcome | null = null;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        if (abortController?.signal.aborted) { outcome = { reason: 'aborted' }; break; }
        try {
          outcome = await proc.writeTurn(prompt);
        } catch {
          // Process died between acquire and write (or rejected post-exit).
          const deadId = proc.conversationId ?? storedConversationId;
          if (attempt < this.maxAttempts) {
            tlog.warn('stream process exited before/during turn (attempt %d/%d); respawning', attempt, this.maxAttempts);
            proc = await spawnProcess(deadId);
            normalizer = norm;
            continue;
          }
          outcome = { reason: 'process-exited' };
          break;
        }
        if (outcome.reason === 'process-exited' && attempt < this.maxAttempts) {
          proc = await spawnProcess(outcome.conversationId ?? proc.conversationId ?? storedConversationId);
          normalizer = norm;
          continue;
        }
        break;
      }
      outcome = outcome ?? { reason: 'process-exited' };

      const durationMs = Date.now() - startedAt;
      const tools: AgyStoredToolCall[] = (normalizer.lastTurn?.tools ?? []).slice(0, AGY_STORED_TOOL_LIMIT)
        .map((t) => ({
          toolName: t.toolName,
          ...(t.args !== undefined ? { args: t.args } : {}),
          ...(t.output !== undefined ? { output: t.output.length > AGY_STORED_TOOL_OUTPUT_LIMIT ? `${t.output.slice(0, AGY_STORED_TOOL_OUTPUT_LIMIT)}… [truncated]` : t.output } : {}),
          isError: t.isError,
          ...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
        }));

      // Conversation ledger: prefer what the result reported. A mismatch means
      // agy silently started a new conversation (invalid stored id) — surface
      // a warning, then persist the ACTUAL id so the next resume stays coherent.
      const actualConversationId = outcome.conversationId ?? normalizer.lastTurn?.result.conversation_id ?? proc.conversationId ?? storedConversationId;
      if (storedConversationId && actualConversationId && storedConversationId !== actualConversationId) {
        tlog.warn('agy rebound conversation: stored=%s actual=%s (invalid id creates a fresh conversation — persisted actual)', storedConversationId, actualConversationId);
      }

      const success = !outcome.reason && outcome.status === 'SUCCESS';
      if (success) {
        const response = outcome.response ?? normalizer.lastTurn?.text ?? '';
        const usage: AgyStoredUsage | undefined = outcome.usage
          ? {
              input: outcome.usage.input ?? 0,
              output: outcome.usage.output ?? 0,
              thinking: outcome.usage.thinking ?? 0,
              cacheRead: outcome.usage.cacheRead ?? 0,
              total: outcome.usage.total ?? 0,
            }
          : undefined;
        tlog.info('stream turn done in %dms: responseChars=%d conversationId=%s tools=%d', durationMs, response.length, actualConversationId ?? 'none', tools.length);
        await this.finalizeStreamSuccess(sessionId, entry, turnId, prompt, isFirstMessage, response, actualConversationId, usage, outcome.numTurns, outcome.status, tools, durationMs, normalizer, assistantId, emit, meta);
        cleanupRunState();
        return;
      }

      const partial = outcome.response ?? '';
      const reason = outcome.reason ?? `agy ${outcome.status ?? 'ERROR'}`;
      const body = outcome.error
        ? `The agent run failed (${reason}): ${outcome.error}`
        : `The agent did not return a reply (${reason}).`;
      tlog.warn('stream turn failed in %dms: reason=%s agyError=%s', durationMs, reason, outcome.error?.slice(0, 120) ?? 'none');
      await this.finalizeStreamError(sessionId, entry, turnId, prompt, isFirstMessage, partial, reason, outcome.error ?? reason, actualConversationId, body, durationMs, normalizer, assistantId, emit, meta);
      cleanupRunState(new Error(reason));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const reason = error.message || 'error';
      tlog.error('stream turn errored before completion: %s', reason);
      const body = `The agent run failed (${reason}).`;
      await this.finalizeStreamError(sessionId, entry, turnId, prompt, isFirstMessage, '', reason, reason, storedConversationId, body, Date.now() - startedAt, this.streamNormalizers.get(sessionId) ?? null, assistantId, emit, meta)
        .catch(() => undefined);
      cleanupRunState(error);
    }
  }

  /**
   * Stream-mode success finalisation: persist (with real usage/tools), then
   * emit message_end for the streamed assistant message + agent_end.
   */
  private async finalizeStreamSuccess(
    sessionId: string,
    entry: RegistryEntry,
    turnId: string,
    prompt: string,
    isFirstMessage: boolean,
    response: string,
    conversationId: string | null,
    usage: AgyStoredUsage | undefined,
    numTurns: number | undefined,
    agyStatus: string | undefined,
    tools: AgyStoredToolCall[],
    durationMs: number,
    normalizer: AgyEventNormalizer,
    _assistantId: string,
    emit: (event: NormalizedEvent) => void,
    meta: ActiveSessionMeta,
  ): Promise<void> {
    const turnTs = Date.now();
    await this.store.finalizeTurn(sessionId, turnId, {
      status: 'done',
      response,
      conversationId,
      turnDurationMs: durationMs,
      ...(usage ? { usage } : {}),
      ...(numTurns !== undefined ? { numTurns } : {}),
      ...(agyStatus ? { agyStatus } : {}),
      tools,
    });
    await this.registry.upsert({
      ...entry,
      id: sessionId,
      sdkType: 'antigravity',
      firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
      messageCount: (entry.messageCount || 0) + 1,
      status: 'idle',
      antigravityConversationId: conversationId ?? undefined,
    });

    const streamedId = normalizer.state.assistantMessageId;
    if (normalizer.state.assistantMessageOpen && streamedId) {
      emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: streamedId } });
      normalizer.state.assistantMessageOpen = false;
    } else {
      // Nothing streamed (rare): emit the legacy single-shot assistant triple.
      emit({ type: 'message_start', sessionId, timestamp: turnTs, data: { id: _assistantId, role: 'assistant' } });
      emit({
        type: 'message_update', sessionId, timestamp: turnTs,
        data: { id: _assistantId, assistantMessageEvent: { type: 'text_delta', delta: response } },
      });
      emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: _assistantId } });
    }
    emit({ type: 'agent_end', sessionId, timestamp: turnTs, data: { result: null, usage: usage ?? {}, agyStatus, numTurns } });

    meta.status = 'idle';
    meta.lastActivity = Date.now();
    await this.registry.updateStatus(sessionId, 'idle');
  }

  /**
   * Stream-mode error finalisation: persist the error turn (response = the
   * streamed partial, if any), close any streamed message, emit a visible
   * error-body assistant message + agent_end (RC2: failures are never blank).
   */
  private async finalizeStreamError(
    sessionId: string,
    entry: RegistryEntry,
    turnId: string,
    prompt: string,
    isFirstMessage: boolean,
    partial: string,
    reason: string,
    errorText: string,
    conversationId: string | null,
    body: string,
    durationMs: number,
    normalizer: AgyEventNormalizer | null,
    assistantId: string,
    emit: (event: NormalizedEvent) => void,
    meta: ActiveSessionMeta,
  ): Promise<void> {
    const turnTs = Date.now();
    await this.store.finalizeTurn(sessionId, turnId, {
      status: 'error',
      response: partial || errorText || reason,
      error: errorText || reason,
      conversationId,
      turnDurationMs: durationMs,
      agyStatus: normalizer?.lastTurn?.result.status,
      tools: (normalizer?.lastTurn?.tools ?? []).slice(0, AGY_STORED_TOOL_LIMIT).map((t) => ({
        toolName: t.toolName,
        isError: t.isError,
        ...(t.output !== undefined ? { output: t.output.slice(0, AGY_STORED_TOOL_OUTPUT_LIMIT) } : {}),
        ...(t.errorMessage ? { errorMessage: t.errorMessage } : {}),
      })),
    });
    await this.registry.upsert({
      ...entry,
      id: sessionId,
      sdkType: 'antigravity',
      firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
      messageCount: (entry.messageCount || 0) + 1,
      status: 'error',
      antigravityConversationId: conversationId ?? undefined,
    });

    const streamedId = normalizer?.state.assistantMessageId;
    if (normalizer?.state.assistantMessageOpen && streamedId) {
      emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: streamedId } });
      normalizer.state.assistantMessageOpen = false;
    }
    emit({ type: 'message_start', sessionId, timestamp: turnTs, data: { id: assistantId, role: 'assistant' } });
    emit({
      type: 'message_update', sessionId, timestamp: turnTs,
      data: { id: assistantId, assistantMessageEvent: { type: 'text_delta', delta: body } },
    });
    emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: assistantId } });
    emit({ type: 'agent_end', sessionId, timestamp: turnTs, data: { result: null, usage: {}, error: errorText || reason } });

    meta.status = 'error';
    meta.lastActivity = Date.now();
    await this.registry.updateStatus(sessionId, 'error');
  }

  /**
   * Finalize an in-flight turn as done: emit the assistant reply + agent_end,
   * persist the finalized turn, and update the registry (turn counted, idle).
   */
  private async finalizeTurnSuccess(
    sessionId: string,
    entry: RegistryEntry,
    turnId: string,
    prompt: string,
    isFirstMessage: boolean,
    response: string,
    conversationId: string | null,
    rawStdout: string,
    durationMs: number,
    assistantId: string,
    emit: (event: NormalizedEvent) => void,
    meta: ActiveSessionMeta,
  ): Promise<void> {
    const turnTs = Date.now();

    emit({ type: 'message_start', sessionId, timestamp: turnTs, data: { id: assistantId, role: 'assistant' } });
    emit({
      type: 'message_update', sessionId, timestamp: turnTs,
      data: { id: assistantId, assistantMessageEvent: { type: 'text_delta', delta: response } },
    });
    emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: assistantId } });

    await this.store.finalizeTurn(sessionId, turnId, {
      status: 'done',
      response,
      conversationId,
      rawStdoutLength: rawStdout.trimEnd().length,
      turnDurationMs: durationMs,
    });

    await this.registry.upsert({
      ...entry,
      id: sessionId,
      sdkType: 'antigravity',
      firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
      messageCount: (entry.messageCount || 0) + 1,
      status: 'idle',
      antigravityConversationId: conversationId ?? undefined,
    });

    emit({ type: 'agent_end', sessionId, timestamp: turnTs, data: { result: null, usage: {} } });

    meta.status = 'idle';
    meta.lastActivity = Date.now();
    await this.registry.updateStatus(sessionId, 'idle');
  }

  /**
   * Finalize an in-flight turn as error: emit a non-empty assistant body +
   * agent_end (so the failure is visible on replay and to notifications),
   * persist the finalized error turn, and update the registry (turn still
   * counted + firstMessage set, status error).
   */
  private async finalizeTurnError(
    sessionId: string,
    entry: RegistryEntry,
    turnId: string,
    prompt: string,
    isFirstMessage: boolean,
    partial: string,
    reason: string,
    conversationId: string | null,
    body: string,
    durationMs: number | undefined,
    assistantId: string,
    emit: (event: NormalizedEvent) => void,
    meta: ActiveSessionMeta,
  ): Promise<void> {
    const turnTs = Date.now();

    emit({ type: 'message_start', sessionId, timestamp: turnTs, data: { id: assistantId, role: 'assistant' } });
    emit({
      type: 'message_update', sessionId, timestamp: turnTs,
      data: { id: assistantId, assistantMessageEvent: { type: 'text_delta', delta: body } },
    });
    emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: assistantId } });

    await this.store.finalizeTurn(sessionId, turnId, {
      status: 'error',
      // Per plan: response = partial text (if any) or the reason, so the stored
      // turn is self-describing and replay surfaces a non-empty body.
      response: partial || reason,
      error: reason,
      conversationId,
      ...(durationMs !== undefined ? { turnDurationMs: durationMs } : {}),
    });

    await this.registry.upsert({
      ...entry,
      id: sessionId,
      sdkType: 'antigravity',
      firstMessage: isFirstMessage ? prompt.slice(0, 200) : entry.firstMessage,
      messageCount: (entry.messageCount || 0) + 1,
      status: 'error',
      antigravityConversationId: conversationId ?? undefined,
    });

    emit({ type: 'agent_end', sessionId, timestamp: turnTs, data: { result: null, usage: {} } });

    meta.status = 'error';
    meta.lastActivity = Date.now();
    await this.registry.updateStatus(sessionId, 'error');
  }

  // ── API observers (origin-independent event fan-out) ──────────────────────

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

  abort(sessionId: string): void {
    // Legacy text path: keep the session marked running until the exact
    // in-flight invocation observes the abort and finalises.
    this.promptAbortControllers.get(sessionId)?.abort();
    // Stream path: SIGTERM the child; the closing result / exit resolves the
    // pending turn(s) with reason 'aborted'.
    this.streamProcesses.get(sessionId)?.abort();
  }

  disposeSession(sessionId: string): void {
    this.abort(sessionId);
    const proc = this.streamProcesses.get(sessionId);
    if (proc && !proc.hasExited) {
      try { proc.abort(); } catch { /* non-fatal on dispose */ }
    }
    this.streamProcesses.delete(sessionId);
    this.streamNormalizers.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.runningSessions.delete(sessionId);
    this.startingSessions.delete(sessionId);
    this.promptAbortControllers.delete(sessionId);
    this.promptCallbacks.delete(sessionId);
    this.apiObservers.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMeta.has(sessionId);
  }

  /** Contract 1.38.0 goal sweeper: latest finalized turn (null when none).
   *  Stream mode stores turn completion in `turnDurationMs` finalization order;
   *  `timestamp` is the turn start, which preserves ordering well enough for
   *  the sweeper's process-once bookkeeping. */
  async getLastCompletedTurn(sessionId: string): Promise<{ completedAt: number; response: string } | null> {
    const history = await this.store.loadHistory(sessionId);
    const finalized = history.filter((t) => t.status !== 'running');
    const last = finalized[finalized.length - 1];
    if (!last) return null;
    // Derived completion instant, guarded monotonically across finalized turns
    // so identical timestamps can never make the sweeper skip a newer turn.
    let prevDerived = -Infinity;
    for (const t of finalized) {
      const derived = t.turnDurationMs !== undefined ? t.timestamp + t.turnDurationMs : t.timestamp;
      prevDerived = derived > prevDerived ? derived : prevDerived + 1;
    }
    return { completedAt: prevDerived, response: last.response ?? '' };
  }

  /** Contract 1.38.0 goal sweeper: registry cwd for verifyCommand execution. */
  async getSessionCwd(sessionId: string): Promise<string | undefined> {
    const entry = await this.registry.get(sessionId).catch(() => null);
    return entry && entry.sdkType === 'antigravity' ? entry.cwd : undefined;
  }

  async ensureSession(sessionId: string): Promise<boolean> {
    if (this.sessionMeta.has(sessionId)) return true;
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'antigravity') return false;
    // Crash recovery (RC1/§4.3.5): a turn left `running` on disk by a crash
    // mid-flight is intentionally NOT reconciled here. replayAntigravityHistory
    // renders it as user-prompt-only (no agent_end) with isStreaming driving the
    // spinner, which is the cheapest correct behavior — no heavy reconciliation.
    this.sessionMeta.set(sessionId, { lastActivity: Date.now(), pinned: false, pinClaims: new Set(), status: 'idle' });
    return true;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (meta) meta.lastActivity = Date.now();
  }

  async getReplayEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const history = await this.store.loadHistory(sessionId);
    return turnsToReplayEvents(history, sessionId);
  }

  async listSessions() {
    return this.registry.listBySdkType('antigravity');
  }

  async getSession(sessionId: string) {
    return this.registry.get(sessionId);
  }

  async setModel(sessionId: string, modelId: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    // O3: a model change while a turn runs cannot take effect (the running
    // process pinned its --model at spawn) — refuse instead of drifting.
    const proc = this.streamProcesses.get(sessionId);
    if (proc && !proc.hasExited && proc.hasPendingTurns) {
      throw new Error('session is busy: model changes apply between turns');
    }
    // Canonicalise to the slug agy echoes in init.model (label / tab-string /
    // provider-prefixed forms all normalise here; unknown ids pass through and
    // loud-fail at the agy boundary on the next turn).
    let catalog: ParsedAgyModel[] = [];
    try {
      const result = await runAgy(['models'], process.cwd(), 10000);
      if (result.ok) catalog = parseAgyModelsOutput(result.stdout);
    } catch { /* catalogue unavailable — canonicalise without it */ }
    const slug = canonicalizeAgyModelId(modelId, catalog);
    await this.registry.upsert({ ...entry, id: entry.id, sdkType: 'antigravity', model: slug });
    // Drop the warm process so the next turn respawns with the new --model and
    // resumes the same conversation (resume-into-stdin live-validated).
    if (proc && !proc.hasExited) {
      this.streamProcesses.delete(sessionId);
      this.streamNormalizers.delete(sessionId);
      proc.stop();
    }
    return slug;
  }

  /**
   * Thinking-level selection (stream mode): swap to the level's sibling slug.
   * No --effort flag is ever passed (live-validated: effort conflicts with
   * baked-level slugs and is unsupported for claude/gpt-oss models).
   * Throws for unsupported axes so callers fail loudly instead of drifting.
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    const current = canonicalizeAgyModelId(entry.model || config.antigravityDefaultModel);
    let catalog: ParsedAgyModel[] = [];
    try {
      const result = await runAgy(['models'], process.cwd(), 10000);
      if (result.ok) catalog = parseAgyModelsOutput(result.stdout);
    } catch { /* catalogue unavailable — resolution without siblings fails below */ }
    const resolution = resolveModelSlug(current, level, catalog);
    if (!resolution.ok) throw new Error(resolution.reason);
    if (resolution.slug === current) return current; // level already baked in
    return this.setModel(sessionId, resolution.slug);
  }

  async pinSession(sessionId: string, claimId = 'web-ui'): Promise<boolean> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    if (meta.pinClaims.has(claimId)) return true;
    if (claimId === 'web-ui') {
      const humanPinned = [...this.sessionMeta.values()].filter((item) => item.pinClaims.has('web-ui')).length;
      if (humanPinned >= this.maxPinnedSessions) return false;
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

  getSubscriberTracker(): AntigravitySessionSubscribers {
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
    /** Cumulative token consumption summed over finalized turns (real agy
     *  usage; zeros when no turn reported usage). */
    tokens: { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number; total: number };
    /** Durable on-disk transcript path (session-info surfacing). */
    sessionFile: string;
    /** Native agy conversation id (undefined until the first finalised turn). */
    nativeSessionId?: string;
  } | null> {
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'antigravity') return null;
    const history = await this.store.loadHistory(sessionId);
    // Count finalized turns (done + error + legacy) only; a `running` turn is an
    // in-flight exchange with no assistant reply yet and must not inflate stats.
    const finalizedCount = history.filter((t) => t.status !== 'running').length;
    const finalized = history.filter((t) => t.status !== 'running');
    // Stream mode: real stored tool-call counts (legacy text turns store none).
    const toolCalls = finalized.reduce((acc, t) => acc + (t.tools?.length ?? 0), 0);
    // Cumulative consumption: each turn's usage block reports that turn's real
    // spend, so the session total is the sum (NOT the last turn's request size
    // — see getContextUsage for the context-window metric).
    const tokens = finalized.reduce(
      (acc, t) => ({
        input: acc.input + (t.usage?.input ?? 0),
        output: acc.output + (t.usage?.output ?? 0),
        thinking: acc.thinking + (t.usage?.thinking ?? 0),
        cacheRead: acc.cacheRead + (t.usage?.cacheRead ?? 0),
        // agy never reports cache writes; keep the wire shape uniform.
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
      ...(entry.antigravityConversationId ? { nativeSessionId: entry.antigravityConversationId } : {}),
    };
  }

  async getContextUsage(sessionId: string): Promise<{ contextWindow: number; tokens: number; percent: number } | null> {
    try {
      const entry = await this.registry.get(sessionId).catch(() => null);
      if (!entry || entry.sdkType !== 'antigravity') return null;
      const history = await this.store.loadHistory(sessionId);
      const finalized = history.filter((t) => t.status !== 'running');
      if (finalized.length === 0) return null;

      // Stream mode: the latest real cumulative usage from agy's result
      // envelope is the honest signal. Gemini request size = input + cacheRead
      // (live-validated 2026-09-09: turn1 input 42,445 + cacheRead 106,044 =
      // 148,489 = 14.2% of 1,048,576; agy's `total` is input+output ONLY and
      // understates the context ~2.6x). Turns predating stream-mode usage
      // (legacy text mode): no honest signal.
      for (let i = finalized.length - 1; i >= 0; i--) {
        const usage = finalized[i].usage;
        if (usage) {
          const contextWindow = getModelContextWindow(entry.model ?? config.antigravityDefaultModel);
          const tokens = usage.input + usage.cacheRead;
          return { contextWindow, tokens, percent: Math.min(Math.round((tokens / contextWindow) * 100), 100) };
        }
      }
      // Turns predating stream-mode usage (legacy text mode): no honest signal.
      return null;
    } catch {
      return null;
    }
  }

  async getAvailableModels(): Promise<AgyModelEntry[]> {
    if (!config.antigravityEnabled) return [];
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;
    if (this.modelRequest) return this.modelRequest;

    this.modelRequest = (async () => {
      let models: AgyModelEntry[];
      try {
        const result = await runAgy(['models'], process.cwd(), 10000);
        if (!result.ok) throw new Error('agy models failed');
        models = toCatalogEntries(parseAgyModelsOutput(result.stdout));
      } catch {
        // Conservative fallback when `agy models` cannot run: current-generation
        // entries with empty thinkingLevels (derivation needs real sibling data).
        models = toCatalogEntries(
          parseAgyModelsOutput(
            [
              'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
              'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
              'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
              'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
              'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
            ].join('\n'),
          ),
        );
      }
      this.modelCache = { expiresAt: Date.now() + 60_000, models };
      return models;
    })().finally(() => { this.modelRequest = null; });
    return this.modelRequest;
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

let instance: AntigravityService | null = null;

export function getAntigravityService(): AntigravityService {
  if (instance === null) {
    instance = new AntigravityService({ registryPath: config.sessionRegistryPath });
  }
  return instance;
}

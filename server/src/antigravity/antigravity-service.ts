import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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

const logger = createLogger('AntigravityService');


const AGY_CONVERSATION_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
const AGY_BINARY = process.env.AGY_BINARY || '/root/.local/bin/agy';

// Rough character-to-token ratio. Gemini tokenisation is broadly similar to
// other LLMs for mixed English + code content (~4 chars per token on average).
export const ANTIGRAVITY_CHARS_PER_TOKEN = 4;

// Maps agy model-name prefixes to their known context window sizes (in tokens).
// agy uses its own internal naming scheme; these are best-effort mappings.
export const ANTIGRAVITY_MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, tokens: number]> = [
  ['Gemini 3.5 Flash', 1_048_576],   // Gemini 2.5 Flash series → 1 M
  ['Gemini 3.1 Pro',   2_097_152],   // Gemini 1.5 Pro series  → 2 M
  ['Claude Sonnet',      200_000],
  ['Claude Opus',        200_000],
  ['GPT-OSS',            128_000],
];

const DEFAULT_CONTEXT_WINDOW = 1_048_576; // Flash is the default model

/**
 * Normalize a model id for the agy `--model` boundary.
 *
 * agy expects a bare label like "Gemini 3.5 Flash (High)". Some callers/model
 * pickers attach a provider prefix (e.g. "antigravity/…"); passing that makes
 * agy silently fall back to its default model (the user picks High, gets
 * Medium). Strip a single leading `provider/` segment so the chosen label runs
 * as chosen. The stored registry id is left untouched — normalize only here.
 */
export function normalizeAgyModel(model: string): string {
  const slash = model.indexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Returns the context window size (tokens) for the given agy model name.
 * Falls back to the Flash context window when the name is unrecognised.
 */
export function getModelContextWindow(model: string): number {
  const normalized = normalizeAgyModel(model);
  for (const [prefix, size] of ANTIGRAVITY_MODEL_CONTEXT_WINDOWS) {
    if (normalized.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export interface ConversationFileInfo {
  id: string;
  size: number;
  mtimeMs: number;
}

async function listConversationFiles(): Promise<Map<string, ConversationFileInfo>> {
  const conversations = new Map<string, ConversationFileInfo>();
  try {
    const files = await readdir(AGY_CONVERSATION_DIR);
    for (const file of files) {
      if (!file.endsWith('.db')) continue;
      const id = file.slice(0, -3);
      try {
        const fileStat = await stat(path.join(AGY_CONVERSATION_DIR, file));
        conversations.set(id, { id, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
      } catch {
        // Conversation files can disappear while agy is updating them; ignore unstable entries.
      }
    }
  } catch {
    return conversations;
  }
  return conversations;
}

export function pickNewConversationId(
  before: Map<string, ConversationFileInfo>,
  after: Map<string, ConversationFileInfo>,
): string | null {
  const candidates = [...after.values()].filter((info) => !before.has(info.id));
  if (candidates.length === 0) return null;

  // agy can create small transient DBs before the print-mode conversation that
  // actually receives the user message. Prefer the DB that grew the most, then
  // the most recently modified one, instead of relying on readdir() order.
  candidates.sort((a, b) =>
    b.size - a.size ||
    b.mtimeMs - a.mtimeMs ||
    a.id.localeCompare(b.id),
  );
  return candidates[0].id;
}

export function extractSentConversationIdFromAgyLog(logText: string): string | null {
  const re = /Print mode: conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}), sending message/g;
  let id: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(logText)) !== null) {
    id = match[1];
  }
  return id;
}

export function applySentConversationId(
  requestedConversationId: string | null,
  sentConversationId: string | null,
): string | null {
  if (!sentConversationId) return requestedConversationId;
  if (requestedConversationId && requestedConversationId !== sentConversationId) {
    throw new Error(`agy sent prompt to conversation ${sentConversationId} instead of requested ${requestedConversationId}; refusing to rebind this session implicitly`);
  }
  return sentConversationId;
}

async function createAgyRunLogPath(sessionId: string): Promise<string> {
  const logDir = path.join(config.antigravitySessionDir, 'agy-logs');
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await chmod(logDir, 0o700).catch(() => undefined);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(logDir, `${safeSessionId}-${Date.now()}-${randomUUID()}.log`);
}

/**
 * Structured outcome of an agy subprocess run. Never throws for a non-zero exit
 * or a timeout — those resolve with `ok:false` and a `reason` so the caller can
 * surface a real failure body instead of discarding partial output. Only a
 * spawn-level failure (binary missing) still rejects.
 */
export interface AgyResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  reason?: string; // e.g. 'timeout' | `exit ${code}`
}

function runAgy(args: string[], cwd: string, timeoutMs: number): Promise<AgyResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `/root/.local/bin:${process.env.PATH ?? ''}` };
    const proc = spawn(AGY_BINARY, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      // Watchdog: return partial output + a timeout reason instead of throwing,
      // so a 10-minute timeout becomes a visible, durable error turn.
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, ok: false, reason: 'timeout' });
    }, timeoutMs + 5000); // slightly longer than agy's own print-timeout

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err); // genuine spawn failure (binary missing, etc.)
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) {
        // code 0, or non-zero but we still got a usable reply (lenient, preserved).
        resolve({ stdout, stderr, ok: true });
      } else {
        resolve({ stdout, stderr, ok: false, reason: `exit ${code}` });
      }
    });
  });
}

/**
 * Extract only the newest reply from stdout.
 *
 * When --conversation <id> is used, agy prepends ALL prior assistant replies
 * before the newest one. We store the raw stdout length after each turn so
 * the next call can slice exactly at that offset.
 */
function extractNewReply(stdout: string, priorStdoutLength: number): string {
  const trimmed = stdout.trimEnd();
  if (priorStdoutLength === 0) return trimmed;
  const slice = trimmed.slice(priorStdoutLength).trimStart();
  return slice || trimmed;
}

interface ActiveSessionMeta {
  lastActivity: number;
  pinned: boolean;
  status: 'idle' | 'running' | 'error';
}

export class AntigravityService {
  private store: AntigravitySessionStore;
  private subscribers: AntigravitySessionSubscribers;
  private registry;
  private sessionMeta: Map<string, ActiveSessionMeta> = new Map();
  private runningSessions: Set<string> = new Set();
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

  constructor(cfg: { registryPath: string }) {
    this.store = new AntigravitySessionStore(config.antigravitySessionDir);
    this.subscribers = new AntigravitySessionSubscribers();
    this.registry = getSessionRegistry(cfg.registryPath);

    this.idleTimeoutMs = config.antigravityIdleTimeoutMs;
    this.maxSessions = config.antigravityMaxSessions;
    this.maxPinnedSessions = config.antigravityMaxPinnedSessions;
    this.cleanupIntervalMs = config.antigravityCleanupIntervalMs;
    this.promptTimeoutMs = config.antigravityPromptTimeoutMs;

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
    try {
      const result = await runAgy(['--version'], process.cwd(), 5000);
      return result.ok && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async validateSetup(): Promise<{ ok: boolean; error?: string }> {
    const available = await this.isAvailable();
    if (!available) {
      return { ok: false, error: 'agy binary not found or not executable' };
    }
    return { ok: true };
  }

  async createSession(cwd: string, model?: string): Promise<{ sessionId: string }> {
    if (this.sessionMeta.size >= this.maxSessions) {
      this.evictOldestIdleSession();
    }

    const sessionId = randomUUID();
    this.sessionMeta.set(sessionId, { lastActivity: Date.now(), pinned: false, status: 'idle' });

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
    const entry = await this.registry.get(sessionId);
    if (!entry) throw new Error(`Antigravity session not found: ${sessionId}`);

    let meta = this.sessionMeta.get(sessionId);
    if (!meta) {
      meta = { lastActivity: Date.now(), pinned: false, status: 'idle' };
      this.sessionMeta.set(sessionId, meta);
    }

    meta.status = 'running';
    meta.lastActivity = Date.now();
    this.runningSessions.add(sessionId);
    this.promptCallbacks.set(sessionId, { onEvent, onComplete });
    await this.registry.updateStatus(sessionId, 'running');

    void this.runPromptAsync(sessionId, entry, prompt, meta, onEvent, onComplete);
  }

  private async runPromptAsync(
    sessionId: string,
    entry: Awaited<ReturnType<typeof this.registry.get>>,
    prompt: string,
    meta: ActiveSessionMeta,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    if (!entry) return;

    const turnId = randomUUID();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const ts = Date.now();
    // Stored id is kept verbatim; normalization happens only at the agy boundary.
    const storedModel = entry.model || config.antigravityDefaultModel;
    const conversationIdHint = entry.antigravityConversationId ?? null;

    const emit = (event: NormalizedEvent) => {
      try { onEvent(event); } catch { /* non-fatal */ }
      this.emitApiObserverEvent(sessionId, event);
    };

    // ── Persist the prompt the instant it is accepted (RC1 durability). ──
    // A refresh mid-flight now reads a durable `running` turn instead of an
    // empty store. Reflect the in-flight turn in the registry too (firstMessage
    // + running status) so list views show it immediately.
    const historyBefore = await this.store.loadHistory(sessionId);
    const isFirstMessage = historyBefore.length === 0;
    await this.store.startTurn(sessionId, {
      turnId,
      prompt,
      model: storedModel,
      conversationId: conversationIdHint,
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

    emit({ type: 'agent_start', sessionId, timestamp: ts, data: { sessionId } });
    emit({ type: 'message_start', sessionId, timestamp: ts, data: { id: userId, role: 'user' } });
    emit({
      type: 'message_update', sessionId, timestamp: ts,
      data: { id: userId, assistantMessageEvent: { type: 'text_delta', delta: prompt } },
    });
    emit({ type: 'message_end', sessionId, timestamp: ts, data: { id: userId } });

    try {
      const history = await this.store.loadHistory(sessionId);
      const priorLen = this.store.priorStdoutLength(history);

      // Detect conversation ID from registry or the last DONE turn. A running
      // or error turn may carry a null/transient id, so skip those.
      let conversationId: string | null = entry.antigravityConversationId ?? null;
      if (!conversationId) {
        for (let i = history.length - 1; i >= 0; i--) {
          if (isTurnDone(history[i]) && history[i].conversationId) {
            conversationId = history[i].conversationId;
            break;
          }
        }
      }

      // Snapshot conversation dir before call (fallback for detecting new conv ID on first turn)
      const beforeConversations = conversationId ? new Map<string, ConversationFileInfo>() : await listConversationFiles();
      const agyLogFile = await createAgyRunLogPath(sessionId);

      // Build agy args. Normalize the model id so the chosen label runs as
      // chosen (RC3: an "antigravity/" prefix otherwise silently downgrades).
      const model = normalizeAgyModel(storedModel);
      const printTimeout = Math.ceil(this.promptTimeoutMs / 60000) + 'm';
      const args = ['--log-file', agyLogFile, '--dangerously-skip-permissions', '--print-timeout', printTimeout];

      if (model) args.push('--model', model);
      if (conversationId) {
        args.push('--conversation', conversationId);
      }
      args.push('-p', prompt);

      // TODO: antigravityPromptTimeoutMs is configurable via ANTIGRAVITY_PROMPT_TIMEOUT_MS;
      // the fix here makes a timeout visible/durable rather than changing the value.
      const result = await runAgy(args, entry.cwd, this.promptTimeoutMs);

      // agy may create transient conversations before the one that actually
      // receives the message. Its per-run log exposes the true target.
      await chmod(agyLogFile, 0o600).catch(() => undefined);
      const agyLog = await readFile(agyLogFile, 'utf-8').catch(() => '');
      const sentConversationId = extractSentConversationIdFromAgyLog(`${agyLog}\n${result.stderr}`);
      conversationId = applySentConversationId(conversationId, sentConversationId);
      if (!conversationId) {
        const afterConversations = await listConversationFiles();
        conversationId = pickNewConversationId(beforeConversations, afterConversations);
      }

      if (result.ok) {
        const response = extractNewReply(result.stdout, priorLen);
        await this.finalizeTurnSuccess(sessionId, entry, turnId, prompt, isFirstMessage, response, conversationId, result.stdout, assistantId, emit, meta);
        this.runningSessions.delete(sessionId);
        this.promptCallbacks.delete(sessionId);
        onComplete();
        return;
      }

      // Non-completing turn (timeout / non-zero exit with no stdout): surface a
      // real, non-empty body and persist as error (RC2 — no more blank screen).
      const reason = result.reason ?? 'error';
      const partial = result.stdout.trim();
      const body = partial || `The agent did not return a reply (${reason}).`;
      await this.finalizeTurnError(sessionId, entry, turnId, prompt, isFirstMessage, partial, reason, conversationId, body, assistantId, emit, meta);
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      onComplete(new Error(reason));
    } catch (err) {
      // Spawn-level failure or unexpected throw: same visible-failure treatment.
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`[AntigravityService] Prompt failed for ${sessionId}:`, error.message);

      const reason = error.message || 'error';
      const body = `The agent run failed (${reason}).`;
      await this.finalizeTurnError(sessionId, entry, turnId, prompt, isFirstMessage, '', reason, conversationIdHint, body, assistantId, emit, meta)
        .catch(() => undefined);
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      onComplete(error);
    }
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
    const meta = this.sessionMeta.get(sessionId);
    if (meta) meta.status = 'idle';
    this.runningSessions.delete(sessionId);
    const cb = this.promptCallbacks.get(sessionId);
    if (cb) {
      this.promptCallbacks.delete(sessionId);
      cb.onComplete(new Error('Aborted by user'));
    }
    void this.registry.updateStatus(sessionId, 'idle');
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMeta.has(sessionId);
  }

  async ensureSession(sessionId: string): Promise<boolean> {
    if (this.sessionMeta.has(sessionId)) return true;
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'antigravity') return false;
    this.sessionMeta.set(sessionId, { lastActivity: Date.now(), pinned: false, status: 'idle' });
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
    await this.registry.upsert({ ...entry, id: entry.id, sdkType: 'antigravity', model: modelId });
    return modelId;
  }

  async pinSession(sessionId: string): Promise<boolean> {
    await this.ensureSession(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    if (meta.pinned) return true;
    const pinnedCount = [...this.sessionMeta.values()].filter((m) => m.pinned).length;
    if (pinnedCount >= this.maxPinnedSessions) return false;
    meta.pinned = true;
    return true;
  }

  unpinSession(sessionId: string): boolean {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return false;
    meta.pinned = false;
    meta.lastActivity = Date.now();
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
  } | null> {
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'antigravity') return null;
    const history = await this.store.loadHistory(sessionId);
    // Count finalized turns (done + error + legacy) only; a `running` turn is an
    // in-flight exchange with no assistant reply yet and must not inflate stats.
    const finalized = history.filter((t) => t.status !== 'running').length;
    return {
      sessionId,
      cwd: entry.cwd,
      model: entry.model,
      userMessages: finalized,
      assistantMessages: finalized,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: finalized * 2,
      pinned: this.sessionMeta.get(sessionId)?.pinned ?? false,
    };
  }

  async getContextUsage(sessionId: string): Promise<{ contextWindow: number; tokens: number; percent: number } | null> {
    try {
      const entry = await this.registry.get(sessionId).catch(() => null);
      if (!entry || entry.sdkType !== 'antigravity') return null;
      const history = await this.store.loadHistory(sessionId);
      if (history.length === 0) return null;

      const totalChars = history.reduce(
        (acc, turn) => acc + turn.prompt.length + turn.response.length,
        0,
      );
      const tokens = Math.round(totalChars / ANTIGRAVITY_CHARS_PER_TOKEN);
      const contextWindow = getModelContextWindow(entry.model ?? config.antigravityDefaultModel);
      const percent = Math.min(Math.round((tokens / contextWindow) * 100), 100);
      return { contextWindow, tokens, percent };
    } catch {
      return null;
    }
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    try {
      const result = await runAgy(['models'], process.cwd(), 10000);
      if (!result.ok) throw new Error('agy models failed');
      return result.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((name) => ({ id: name, name, provider: 'antigravity' }));
    } catch {
      // Fallback to known models from skill documentation
      return [
        { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', provider: 'antigravity' },
        { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', provider: 'antigravity' },
        { id: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', provider: 'antigravity' },
        { id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', provider: 'antigravity' },
        { id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', provider: 'antigravity' },
      ];
    }
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

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
 * Build the user-facing body + storable partial text for a non-completing turn
 * (timeout / non-zero exit with no usable stdout).
 *
 * `stdout` is the raw agy stdout; with `--conversation` it replays ALL prior
 * assistant replies before the newest one, so we slice near `priorLen` (the
 * last done turn's cumulative offset, verified against `priorResponseText`
 * when supplied — see {@link sliceAfterPriorReply}) to isolate only the new
 * partial reply. The body is always the reason sentence, plus any partial
 * output captured, so a failed turn is never blank and the notification layer
 * always has a real body.
 */
export function buildAgyErrorBody(
  reason: string,
  stdout: string,
  priorLen: number,
  priorResponseText = '',
): { body: string; partial: string } {
  const partial = sliceAfterPriorReply(stdout, priorLen, priorResponseText);
  const body = partial
    ? `The agent did not return a reply (${reason}). Partial output:\n${partial}`
    : `The agent did not return a reply (${reason}).`;
  return { body, partial };
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

/**
 * Detect a silent model downgrade from the per-run agy log.
 *
 * When agy does not recognise the requested model it logs a "not recognized"
 * line and then propagates a *different* label to the backend — i.e. the user's
 * chosen model is silently swapped (the RC3 incident: High → Medium). We strip
 * the `antigravity/` prefix up front to prevent the common case, but agy can
 * still fall back for any genuinely unknown label, so this surfaces it as an
 * observable warning instead of letting it pass invisibly. Returns the label
 * agy actually used (`fellBackTo`) when a downgrade is detected, else null.
 */
export function extractAgyModelDowngrade(logText: string): { fellBackTo: string } | null {
  if (!/is not recognized as a known model/i.test(logText)) return null;
  const re = /Propagating selected model override to backend: label="([^"]+)"/g;
  let fellBackTo: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(logText)) !== null) {
    fellBackTo = match[1];
  }
  return fellBackTo ? { fellBackTo } : null;
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

/**
 * Run the agy subprocess with two independent watchdogs:
 *
 * 1. A **stall watchdog** polling `logFilePath`'s mtime. agy's `--log-file`
 *    is written incrementally throughout a real turn (unlike stdout, which is
 *    only flushed once at the end), so its mtime is a reliable liveness
 *    signal. If it stops advancing for `stallTimeoutMs`, the model is very
 *    likely stuck in a slow, self-inflicted local tool call rather than
 *    waiting on a live backend call — root-caused 2026-07-01: agy losing
 *    track of its own workspace root and falling back to a full-filesystem
 *    `find /` scan (see docs/ANTIGRAVITY-INTEGRATION.md) — so there's no
 *    reason to wait out the full print-timeout.
 * 2. The original hard ceiling (`timeoutMs + 5000`) as a backstop in case the
 *    log file keeps advancing (or can't be stat'd at all) yet the turn still
 *    never completes.
 *
 * `stallTimeoutMs`/`logFilePath` are optional: quick auxiliary calls that
 * don't pass `--log-file` (version check, model listing) skip the stall
 * watchdog entirely and rely on the hard ceiling alone, same as before.
 */
export function runAgy(args: string[], cwd: string, timeoutMs: number, stallTimeoutMs?: number, logFilePath?: string, signal?: AbortSignal): Promise<AgyResult> {
  // Defense in depth: never spawn a subprocess for a turn that is already
  // aborted (the retry loop also checks, but runAgy may be called directly).
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stallPoll: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => {
      proc.kill('SIGTERM');
      cleanup();
      resolve({ stdout, stderr, ok: false, reason: 'aborted' });
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (stallPoll) clearInterval(stallPoll);
      signal?.removeEventListener('abort', onAbort);
    };

    timer = setTimeout(() => {
      // Watchdog: return partial output + a timeout reason instead of throwing,
      // so a 10-minute timeout becomes a visible, durable error turn.
      proc.kill('SIGTERM');
      cleanup();
      resolve({ stdout, stderr, ok: false, reason: 'timeout' });
    }, timeoutMs + 5000); // slightly longer than agy's own print-timeout

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
          .catch(() => { /* log file not created yet — not progress, but not a stall signal either */ })
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
      reject(err); // genuine spawn failure (binary missing, etc.)
    });

    proc.on('close', (code) => {
      cleanup();
      if (code === 0 || stdout.trim()) {
        // code 0, or non-zero but we still got a usable reply (lenient, preserved).
        resolve({ stdout, stderr, ok: true });
      } else {
        resolve({ stdout, stderr, ok: false, reason: `exit ${code}` });
      }
    });
  });
}

/** Progressively shorter suffixes of the prior reply tried as an anchor, longest first. */
const ANCHOR_LENGTHS = [96, 48, 24, 12, 6];
/** How far (chars) the true boundary may drift from the recorded offset before we give up anchoring. */
const ANCHOR_SEARCH_TOLERANCE = 400;

/**
 * Find the occurrence of `needle` in `haystack` whose END position is closest
 * to `targetPos` (rather than just the first occurrence) — a short/common
 * anchor can appear more than once in a replayed transcript, and the
 * occurrence nearest the recorded offset is overwhelmingly the real boundary.
 */
function findClosestMatchEnd(haystack: string, needle: string, targetPos: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    const end = idx + needle.length;
    const dist = Math.abs(end - targetPos);
    if (dist < bestDist) {
      bestDist = dist;
      best = end;
    }
    from = idx + 1;
  }
  return best;
}

/**
 * Locate where new content begins in `stdout` after any replayed prior reply.
 *
 * `expectedOffset` is the previous done turn's recorded stdout length — a
 * byte-count heuristic that assumes agy replays prior turns byte-for-byte
 * identically on every invocation. In practice agy's replay occasionally
 * reflows by a handful of characters (observed in production: a run of blank
 * lines collapsed on replay, dropping a markdown heading's first 10 chars
 * from the new reply — "### Summary of Material Costs" became "y of Material
 * Costs"). When `priorResponseText` (the prior turn's actual stored response)
 * is available, verify/correct the offset by anchoring on a suffix of it near
 * the expected position instead of trusting the byte count blindly. Falls
 * back to the raw offset when no anchor matches within tolerance (agy
 * replayed nothing, or replayed content differs too much to verify) — never
 * worse than the byte-offset-only behavior this replaces.
 */
function sliceAfterPriorReply(stdout: string, expectedOffset: number, priorResponseText: string): string {
  const trimmed = stdout.trimEnd();
  if (expectedOffset === 0) return trimmed.trimStart();

  if (priorResponseText) {
    const searchStart = Math.max(0, expectedOffset - ANCHOR_SEARCH_TOLERANCE);
    const searchEnd = Math.min(trimmed.length, expectedOffset + ANCHOR_SEARCH_TOLERANCE);
    const window = trimmed.slice(searchStart, searchEnd);
    const targetPos = expectedOffset - searchStart;
    for (const len of ANCHOR_LENGTHS) {
      if (priorResponseText.length < len) continue;
      const anchor = priorResponseText.slice(-len);
      const matchEnd = findClosestMatchEnd(window, anchor, targetPos);
      if (matchEnd !== null) {
        return trimmed.slice(searchStart + matchEnd).trimStart();
      }
    }
  }

  // No verified anchor — fall back to the raw byte-offset heuristic.
  const naive = trimmed.slice(expectedOffset).trimStart();
  return naive || trimmed;
}

/**
 * Extract only the newest reply from stdout.
 *
 * When --conversation <id> is used, agy prepends ALL prior assistant replies
 * before the newest one. We store the raw stdout length after each turn so
 * the next call can slice near that offset, verified against `priorResponseText`
 * (see {@link sliceAfterPriorReply}) since agy's replay is not always
 * byte-stable across invocations.
 */
export function extractNewReply(stdout: string, priorStdoutLength: number, priorResponseText: string): string {
  return sliceAfterPriorReply(stdout, priorStdoutLength, priorResponseText);
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
  private startingSessions: Set<string> = new Set();
  private promptAbortControllers = new Map<string, AbortController>();
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
  private readonly heartbeatIntervalMs: number;
  private readonly stallTimeoutMs: number;
  private readonly maxAttempts: number;
  private modelCache: { expiresAt: number; models: Array<{ id: string; name: string; provider: string }> } | null = null;
  private modelRequest: Promise<Array<{ id: string; name: string; provider: string }>> | null = null;

  constructor(cfg: { registryPath: string }) {
    this.store = new AntigravitySessionStore(config.antigravitySessionDir);
    this.subscribers = new AntigravitySessionSubscribers();
    this.registry = getSessionRegistry(cfg.registryPath);

    this.idleTimeoutMs = config.antigravityIdleTimeoutMs;
    this.maxSessions = config.antigravityMaxSessions;
    this.maxPinnedSessions = config.antigravityMaxPinnedSessions;
    this.cleanupIntervalMs = config.antigravityCleanupIntervalMs;
    this.promptTimeoutMs = config.antigravityPromptTimeoutMs;
    this.heartbeatIntervalMs = config.antigravityHeartbeatIntervalMs;
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
        meta = { lastActivity: Date.now(), pinned: false, status: 'idle' };
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

      void this.runPromptAsync(sessionId, entry, prompt, meta, onEvent, onComplete, abortController);
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  private async runPromptAsync(
    sessionId: string,
    entry: Awaited<ReturnType<typeof this.registry.get>>,
    prompt: string,
    meta: ActiveSessionMeta,
    onEvent: (event: NormalizedEvent) => void,
    onComplete: (error?: Error) => void,
    abortController: AbortController,
  ): Promise<void> {
    if (!entry) return;

    const turnId = randomUUID();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const ts = Date.now();
    // Stored id is kept verbatim; normalization happens only at the agy boundary.
    const storedModel = entry.model || config.antigravityDefaultModel;
    const conversationIdHint = entry.antigravityConversationId ?? null;
    // Per-turn logger: sessionId/turnId/runtime are bound so every line is
    // correlatable and flows through the diagnostics ring buffer.
    const tlog = logger.child({ sessionId, turnId, runtime: 'antigravity' });

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
    tlog.info(
      'turn start: model=%s conversationId=%s promptChars=%d firstMessage=%s',
      storedModel, conversationIdHint ?? 'none', prompt.length, isFirstMessage,
    );

    emit({ type: 'agent_start', sessionId, timestamp: ts, data: { sessionId } });
    emit({ type: 'message_start', sessionId, timestamp: ts, data: { id: userId, role: 'user' } });
    emit({
      type: 'message_update', sessionId, timestamp: ts,
      data: { id: userId, assistantMessageEvent: { type: 'text_delta', delta: prompt } },
    });
    emit({ type: 'message_end', sessionId, timestamp: ts, data: { id: userId } });

    try {
      const history = await this.store.loadHistory(sessionId);
      const { offset: priorLen, text: priorText } = this.store.priorReplyAnchor(history);

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

      // Normalize the model id so the chosen label runs as chosen (RC3: an
      // "antigravity/" prefix otherwise silently downgrades).
      const model = normalizeAgyModel(storedModel);
      if (model !== storedModel) {
        tlog.warn('normalized model id for agy: "%s" -> "%s"', storedModel, model);
      }
      const printTimeout = Math.ceil(this.promptTimeoutMs / 60000) + 'm';

      // ── Liveness heartbeat ──────────────────────────────────────────────
      // agy is a batch subprocess with no native streaming, so emit a synthetic
      // stream_activity ping on an interval while the turn is in flight. This
      // keeps the UI heartbeat fresh during turns that can run for minutes,
      // spanning every attempt below (elapsedMs is measured from the very
      // first attempt, not reset per retry). Live-only (never persisted);
      // always cleared in the finally below.
      const subprocessStartedAt = Date.now();
      const heartbeat = setInterval(() => {
        emit({
          type: 'stream_activity',
          sessionId,
          timestamp: Date.now(),
          data: { turnId, elapsedMs: Date.now() - subprocessStartedAt },
        });
      }, this.heartbeatIntervalMs);
      if (heartbeat.unref) heartbeat.unref();

      // ── Bounded retry loop ───────────────────────────────────────────────
      // A turn that stalls (agy stuck in a slow local tool call — see
      // runAgy's stall watchdog) or hits the hard timeout is retried up to
      // antigravityMaxAttempts times. Each attempt gets its own --log-file and
      // conversation-id resolution; conversationId carries forward into the
      // next attempt's args exactly as agy resolved it (a first turn stays
      // fresh unless agy already registered one, a follow-up turn keeps
      // resuming the same conversation) — no special-casing needed since the
      // existing anchor logic already ignores non-done turns.
      let result: AgyResult;
      let agyLog = '';
      try {
        let attempt = 1;
        for (;;) {
          // Abort cancels pending retries: if the operator aborted this turn
          // (often landing in the same tick as a watchdog 'timeout'/'stall'
          // resolve), do not spawn another agy subprocess.
          if (abortController.signal.aborted) {
            result = { stdout: '', stderr: '', ok: false, reason: 'aborted' };
            break;
          }
          const beforeConversations = conversationId ? new Map<string, ConversationFileInfo>() : await listConversationFiles();
          const agyLogFile = await createAgyRunLogPath(sessionId);
          const args = ['--log-file', agyLogFile, '--dangerously-skip-permissions', '--print-timeout', printTimeout];
          if (model) args.push('--model', model);
          if (conversationId) args.push('--conversation', conversationId);
          args.push('-p', prompt);

          tlog.debug('spawning agy: model=%s conversation=%s printTimeout=%s attempt=%d/%d', model, conversationId ?? 'new', printTimeout, attempt, this.maxAttempts);

          result = await runAgy(args, entry.cwd, this.promptTimeoutMs, this.stallTimeoutMs, agyLogFile, abortController.signal);

          // agy may create transient conversations before the one that
          // actually receives the message. Its per-run log exposes the true
          // target.
          await chmod(agyLogFile, 0o600).catch(() => undefined);
          agyLog = await readFile(agyLogFile, 'utf-8').catch(() => '');
          const sentConversationId = extractSentConversationIdFromAgyLog(`${agyLog}\n${result.stderr}`);
          conversationId = applySentConversationId(conversationId, sentConversationId);
          if (!conversationId) {
            const afterConversations = await listConversationFiles();
            conversationId = pickNewConversationId(beforeConversations, afterConversations);
          }

          // Surface a silent agy model downgrade (RC3 residual: any unknown
          // label, not just the prefixed case we now prevent) as an
          // observable warning.
          const downgrade = extractAgyModelDowngrade(`${agyLog}\n${result.stderr}`);
          if (downgrade) {
            tlog.warn('agy silently downgraded model: requested "%s", agy used "%s"', model, downgrade.fellBackTo);
          }

          if (result.ok) break;

          const retryable = result.reason === 'timeout' || result.reason === 'stall';
          if (!retryable || attempt >= this.maxAttempts) break;

          tlog.warn('turn %s on attempt %d/%d, retrying: sessionId=%s', result.reason, attempt, this.maxAttempts, sessionId);
          attempt++;
        }
      } finally {
        clearInterval(heartbeat);
      }
      const durationMs = Date.now() - subprocessStartedAt;

      if (result.ok) {
        const response = extractNewReply(result.stdout, priorLen, priorText);
        tlog.info('turn done in %dms: responseChars=%d conversationId=%s', durationMs, response.length, conversationId ?? 'none');
        await this.finalizeTurnSuccess(sessionId, entry, turnId, prompt, isFirstMessage, response, conversationId, result.stdout, durationMs, assistantId, emit, meta);
        this.runningSessions.delete(sessionId);
        this.promptCallbacks.delete(sessionId);
        this.promptAbortControllers.delete(sessionId);
        onComplete();
        return;
      }

      // Non-completing turn (timeout / non-zero exit with no stdout): surface a
      // real, non-empty body and persist as error (RC2 — no more blank screen).
      const reason = result.reason ?? 'error';
      tlog.warn('turn failed in %dms: reason=%s', durationMs, reason);
      const { body, partial } = buildAgyErrorBody(reason, result.stdout, priorLen, priorText);
      await this.finalizeTurnError(sessionId, entry, turnId, prompt, isFirstMessage, partial, reason, conversationId, body, durationMs, assistantId, emit, meta);
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      this.promptAbortControllers.delete(sessionId);
      onComplete(new Error(reason));
    } catch (err) {
      // Spawn-level failure or unexpected throw: same visible-failure treatment.
      const error = err instanceof Error ? err : new Error(String(err));
      const reason = error.message || 'error';
      tlog.error('turn errored before completion: %s', reason);

      const body = `The agent run failed (${reason}).`;
      await this.finalizeTurnError(sessionId, entry, turnId, prompt, isFirstMessage, '', reason, conversationIdHint, body, undefined, assistantId, emit, meta)
        .catch(() => undefined);
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      this.promptAbortControllers.delete(sessionId);
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
    // Keep the session marked running until the exact in-flight invocation
    // observes the abort and finalises; this prevents a replacement turn from
    // racing with a still-live agy subprocess.
    this.promptAbortControllers.get(sessionId)?.abort();
  }

  isRunning(sessionId: string): boolean {
    return this.runningSessions.has(sessionId) || this.startingSessions.has(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionMeta.has(sessionId);
  }

  async ensureSession(sessionId: string): Promise<boolean> {
    if (this.sessionMeta.has(sessionId)) return true;
    const entry = await this.registry.get(sessionId);
    if (!entry || entry.sdkType !== 'antigravity') return false;
    // Crash recovery (RC1/§4.3.5): a turn left `running` on disk by a crash
    // mid-flight is intentionally NOT reconciled here. replayAntigravityHistory
    // renders it as user-prompt-only (no agent_end) with isStreaming driving the
    // spinner, which is the cheapest correct behavior — no heavy reconciliation.
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
      // Consistent with getSessionStats: ignore an in-flight `running` turn. It
      // has no assistant reply yet, and if orphaned by a crash it may not be in
      // agy's conversation view, so it must not skew the context estimate.
      const finalized = history.filter((t) => t.status !== 'running');
      if (finalized.length === 0) return null;

      const totalChars = finalized.reduce(
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
    if (!config.antigravityEnabled) return [];
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) return this.modelCache.models;
    if (this.modelRequest) return this.modelRequest;

    this.modelRequest = (async () => {
      let models: Array<{ id: string; name: string; provider: string }>;
      try {
        const result = await runAgy(['models'], process.cwd(), 10000);
        if (!result.ok) throw new Error('agy models failed');
        models = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((name) => ({ id: name, name, provider: 'antigravity' }));
      } catch {
        models = [
          { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', provider: 'antigravity' },
          { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', provider: 'antigravity' },
          { id: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', provider: 'antigravity' },
          { id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', provider: 'antigravity' },
          { id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', provider: 'antigravity' },
        ];
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

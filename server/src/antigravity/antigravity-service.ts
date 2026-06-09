import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { AntigravitySessionStore } from './antigravity-session-store.js';
import { turnsToReplayEvents } from './antigravity-history-replay.js';
import { AntigravitySessionSubscribers } from './antigravity-session-subscribers.js';
import { getSessionRegistry } from '../session-registry.js';
import { config } from '../config.js';

const AGY_CONVERSATION_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
const AGY_BINARY = process.env.AGY_BINARY || '/root/.local/bin/agy';

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

function runAgy(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `/root/.local/bin:${process.env.PATH ?? ''}` };
    const proc = spawn(AGY_BINARY, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`agy subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs + 5000); // slightly longer than agy's own print-timeout

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`agy exited with code ${code}\nSTDERR: ${stderr.slice(0, 500)}`));
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
      const { stdout } = await runAgy(['--version'], process.cwd(), 5000);
      return stdout.trim().length > 0;
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

    const userId = randomUUID();
    const assistantId = randomUUID();
    const ts = Date.now();

    const emit = (event: NormalizedEvent) => {
      try { onEvent(event); } catch { /* non-fatal */ }
    };

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

      // Detect conversation ID from registry or prior history
      let conversationId: string | null = entry.antigravityConversationId ?? null;
      if (!conversationId && history.length > 0) {
        conversationId = history[history.length - 1].conversationId;
      }

      // Snapshot conversation dir before call (fallback for detecting new conv ID on first turn)
      const beforeConversations = conversationId ? new Map<string, ConversationFileInfo>() : await listConversationFiles();
      const agyLogFile = await createAgyRunLogPath(sessionId);

      // Build agy args
      const model = entry.model || config.antigravityDefaultModel;
      const printTimeout = Math.ceil(this.promptTimeoutMs / 60000) + 'm';
      const args = ['--log-file', agyLogFile, '--dangerously-skip-permissions', '--print-timeout', printTimeout];

      if (model) args.push('--model', model);
      if (conversationId) {
        args.push('--conversation', conversationId);
      }
      args.push('-p', prompt);

      const { stdout, stderr } = await runAgy(args, entry.cwd, this.promptTimeoutMs);

      // agy may create transient conversations before the one that actually
      // receives the message. Its per-run log exposes the true target.
      await chmod(agyLogFile, 0o600).catch(() => undefined);
      const agyLog = await readFile(agyLogFile, 'utf-8').catch(() => '');
      const sentConversationId = extractSentConversationIdFromAgyLog(`${agyLog}\n${stderr}`);
      conversationId = applySentConversationId(conversationId, sentConversationId);
      if (!conversationId) {
        const afterConversations = await listConversationFiles();
        conversationId = pickNewConversationId(beforeConversations, afterConversations);
      }

      const response = extractNewReply(stdout, priorLen);
      const turnTs = Date.now();

      emit({ type: 'message_start', sessionId, timestamp: turnTs, data: { id: assistantId, role: 'assistant' } });
      emit({
        type: 'message_update', sessionId, timestamp: turnTs,
        data: {
          id: assistantId,
          assistantMessageEvent: { type: 'text_delta', delta: response },
        },
      });
      emit({ type: 'message_end', sessionId, timestamp: turnTs, data: { id: assistantId } });

      // Persist to store; rawStdoutLength is the cumulative offset for the next turn's extraction
      const isFirstMessage = history.length === 0;
      await this.store.appendTurn(sessionId, { prompt, response, model, conversationId, timestamp: turnTs, rawStdoutLength: stdout.trimEnd().length });

      // Update registry
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
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      await this.registry.updateStatus(sessionId, 'idle');
      onComplete();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[AntigravityService] Prompt failed for ${sessionId}:`, error.message);

      emit({ type: 'agent_end', sessionId, timestamp: Date.now(), data: { result: null, usage: {} } });

      meta.status = 'error';
      meta.lastActivity = Date.now();
      this.runningSessions.delete(sessionId);
      this.promptCallbacks.delete(sessionId);
      await this.registry.updateStatus(sessionId, 'error');
      onComplete(error);
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
    return {
      sessionId,
      cwd: entry.cwd,
      model: entry.model,
      userMessages: history.length,
      assistantMessages: history.length,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: history.length * 2,
      pinned: this.sessionMeta.get(sessionId)?.pinned ?? false,
    };
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    try {
      const { stdout } = await runAgy(['models'], process.cwd(), 10000);
      return stdout
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

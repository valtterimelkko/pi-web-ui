/**
 * Phase 3 (H6) integration: talker-session lifecycle and wiring for the
 * running server (Drive Mode Two-Lane plan; brief H6).
 *
 * The talker library (talker.ts and friends) is transport-agnostic and
 * verified. This module is the piece the running server holds:
 *
 *   - ONE TalkerSessionRegistry per server, constructed by the owner of the
 *     real MultiSessionManager (WebSocketConnectionManager) and handed THAT
 *     instance — never a second manager, which would target sessions the
 *     server does not manage.
 *   - ONE TalkerSession per worker session, created on demand at the first
 *     operator turn, retained (LRU-bounded), never re-created per turn.
 *   - The operator's utterance passes the SAME prompt-injection gate as every
 *     other operator input path (connection.ts `blockIfPromptInjection`
 *     semantics: block when detectPromptInjection recommends 'block') BEFORE
 *     anything reaches the model or the worker. A blocked utterance leaves
 *     nothing behind: no session, no candidate, no history entry.
 *   - Capability is honest: an unconfigured model, an unavailable delivery
 *     set, or a refused delivery reaches the operator as the acknowledgement
 *     (fixed strings here / REFUSED_ACK from the library) — never swallowed.
 *
 * THE GATE IS UNCHANGED. This module never delivers anything: it calls
 * TalkerSession.handleOperatorTurn (the only entry point) whose release path
 * is reachable only from the confirm branch. There is deliberately no method
 * here that can hand text to a worker.
 *
 * Transport binding (which WebSocket message or Internal API route calls
 * handleOperatorTurn) is explicitly out of scope for this phase; the owner
 * exposes the registry through a narrow accessor for that future work.
 */

import { TalkerSession } from './talker.js';
import { createDefaultDeliveries, type DefaultDeliveries } from './delivery.js';
import { createObservedDelivery, createVoiceTurnRecorder, type VoiceTurnRecorder } from './observability.js';
import { OpenRouterTalkerClient, resolveTalkerModelConfig } from './model-client.js';
import { detectPromptInjection } from '../security/prompt-injection.js';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';
import type { TalkerModelClient, TalkerTurnResult, WorkerStateSnapshot } from './types.js';
/** Spoken when the operator's utterance is blocked by the injection gate. */
export const TALKER_INJECTION_BLOCKED_ACK =
  "I can't pass that on — it looked like a prompt-injection attempt, so I dropped it before it reached anything.";

/** Spoken when the talker's model is not configured on this server. */
export const TALKER_MODEL_UNCONFIGURED_ACK =
  "The talker model isn't configured on this server yet, so I can't answer just now.";

/** Spoken when the delivery set itself could not be built (never hides a failure). */
const DELIVERIES_UNAVAILABLE_ACK =
  "I couldn't reach the worker connection from here just now — nothing was sent.";

/** Which runtime adapter relays for a worker session. Defaults to 'pi'. */
export type TalkerRuntime = 'pi' | 'claude' | 'antigravity';

/**
 * Read-only view of Claude worker state for the talker's status view
 * (P11, closing finding F3). Kept minimal and strictly observational: every
 * method only reads what ClaudeService already holds; nothing here can drive,
 * steer, or alter a worker. ClaudeService satisfies this structurally, so the
 * production wiring needs no adapter.
 */
export interface TalkerClaudeWorkerState {
  /** True when the server knows this Claude session at all (memory, disk, or registry). */
  hasSession(sessionId: string): boolean;
  /** True when a prompt is currently running for the session (live observation). */
  isRunning(sessionId: string): boolean;
  /** The session's registry entry (for its status field), when known. */
  getSession(sessionId: string): Promise<{ status?: string } | null | undefined>;
  /** Persisted history entries; read only for the last assistant text. */
  loadSessionHistory(sessionId: string): Promise<Array<{ type: string; content?: string }>>;
}

/** Spoken in the state view when the worker's runtime has no snapshot provider here. */
function honestUnavailableActivity(runtime: TalkerRuntime): string {
  return `worker state for ${runtime} workers is not available on this server yet`;
}

export interface TalkerOperatorTurnInput {
  /** The worker session this talker relays to (Pi: the session path). */
  workerSessionId: string;
  /** The operator's verbatim utterance. */
  utterance: string;
  runtime?: TalkerRuntime;
}

export interface TalkerOperatorTurnResult {
  /** What the operator hears. */
  reply: string;
  /** Set when the utterance never reached the talker (honest, surfaced). */
  refused?: 'prompt_injection' | 'model_unconfigured' | 'deliveries_unavailable';
  /** Present when the talker session processed the turn. */
  turn?: TalkerTurnResult;
}

export interface TalkerSessionRegistryDeps {
  /** The manager the server already owns — supplied by the owner, never created here. */
  multiSessionManager: MultiSessionManager;
  /** Injectable delivery set (tests). Default: createDefaultDeliveries({ multiSessionManager }). */
  deliveries?: DefaultDeliveries;
  /** Injectable model client, or a factory returning null when unconfigured. Default: OpenRouter from env. */
  modelClient?: TalkerModelClient | (() => TalkerModelClient | null);
  /** Env used by the default model factory (tests inject {} to prove the unconfigured path). */
  modelEnv?: NodeJS.ProcessEnv;
  /** Cap on retained talker sessions; the least recently used is evicted beyond it. */
  maxSessions?: number;
  /**
   * Read-only Claude worker state (P11/F3). Default: the server's ClaudeService
   * singleton, resolved lazily at the first claude snapshot build.
   */
  claudeWorkerState?: TalkerClaudeWorkerState;
  /** P10 voice observability recorder. Default: the shared global VoiceMode recorder. */
  voiceRecorder?: VoiceTurnRecorder;
}

const DEFAULT_MAX_SESSIONS = 32;

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(p => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
          return (p as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  return undefined;
}

export class TalkerSessionRegistry {
  private readonly manager: MultiSessionManager;
  private readonly deps: TalkerSessionRegistryDeps;
  /** key: `${runtime}:${workerSessionId}` — insertion order is the LRU order. */
  private readonly sessions = new Map<string, TalkerSession>();
  private readonly maxSessions: number;
  private deliveriesPromise?: Promise<DefaultDeliveries>;
  private resolvedModel?: TalkerModelClient | null;
  /** Tri-state: undefined = not yet resolved; null = resolution failed (stays honest per build). */
  private claudeWorkerState?: TalkerClaudeWorkerState | null;
  /**
   * P10 voice observability. Emits the correlated VoiceMode records and counts
   * the voice_* metrics for pre-talk refusals and (via the talker sessions it
   * creates) every operator turn. Observation only — it can never alter a
   * refusal, a turn, or a delivery.
   */
  readonly voiceRecorder: VoiceTurnRecorder;

  constructor(deps: TalkerSessionRegistryDeps) {
    this.deps = deps;
    this.voiceRecorder = deps.voiceRecorder ?? createVoiceTurnRecorder();
    this.manager = deps.multiSessionManager;
    this.maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** The manager this registry is wired to (wiring pin for tests and the owner). */
  getMultiSessionManager(): MultiSessionManager {
    return this.manager;
  }

  get(workerSessionId: string, runtime: TalkerRuntime = 'pi'): TalkerSession | undefined {
    return this.sessions.get(this.key(workerSessionId, runtime));
  }

  has(workerSessionId: string, runtime: TalkerRuntime = 'pi'): boolean {
    return this.sessions.has(this.key(workerSessionId, runtime));
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(workerSessionId: string, runtime: TalkerRuntime = 'pi'): void {
    this.sessions.delete(this.key(workerSessionId, runtime));
  }

  disposeAll(): void {
    this.sessions.clear();
  }

  /**
   * The operator-turn entry point. Applies the prompt-injection gate first,
   * then hands the utterance to the worker session's talker (creating it on
   * first use). This module has no other public way to reach the worker.
   */
  async handleOperatorTurn(input: TalkerOperatorTurnInput): Promise<TalkerOperatorTurnResult> {
    const runtime: TalkerRuntime = input.runtime ?? 'pi';
    if (!input.utterance || !input.utterance.trim()) {
      throw new Error('operator utterance must be non-empty');
    }

    // Unified prompt-boundary check, matching connection.ts blockIfPromptInjection
    // semantics (block only on 'block'): the utterance must clear the gate
    // BEFORE it can reach the model (and, later, a confirmed release path).
    const injection = detectPromptInjection(input.utterance);
    if (injection.recommendation === 'block') {
      // P10: blocked attack text is recorded without an excerpt (pre-talk
      // refusal — no talker turn exists, hence no voiceTurnId).
      this.voiceRecorder.observeRegistryRefusal({
        runtime,
        workerSessionId: input.workerSessionId,
        utterance: input.utterance,
        refused: 'prompt_injection',
      });
      return { reply: TALKER_INJECTION_BLOCKED_ACK, refused: 'prompt_injection' };
    }

    let deliveries: DefaultDeliveries;
    try {
      deliveries = await this.resolveDeliveries();
    } catch (error) {
      this.voiceRecorder.observeRegistryRefusal({
        runtime,
        workerSessionId: input.workerSessionId,
        utterance: input.utterance,
        refused: 'deliveries_unavailable',
      });
      return {
        reply: `${DELIVERIES_UNAVAILABLE_ACK} (${error instanceof Error ? error.message : String(error)})`,
        refused: 'deliveries_unavailable',
      };
    }
    const delivery = deliveries[runtime];
    if (!delivery) {
      this.voiceRecorder.observeRegistryRefusal({
        runtime,
        workerSessionId: input.workerSessionId,
        utterance: input.utterance,
        refused: 'deliveries_unavailable',
      });
      return {
        reply: `${DELIVERIES_UNAVAILABLE_ACK} (no delivery adapter for runtime '${runtime}')`,
        refused: 'deliveries_unavailable',
      };
    }

    const model = this.resolveModel();
    if (!model) {
      this.voiceRecorder.observeRegistryRefusal({
        runtime,
        workerSessionId: input.workerSessionId,
        utterance: input.utterance,
        refused: 'model_unconfigured',
      });
      return { reply: TALKER_MODEL_UNCONFIGURED_ACK, refused: 'model_unconfigured' };
    }

    const talker = this.getOrCreate(input.workerSessionId, runtime, delivery, model);
    const turn = await talker.handleOperatorTurn(input.utterance);
    return { reply: turn.reply, turn };
  }

  private key(workerSessionId: string, runtime: TalkerRuntime): string {
    return `${runtime}:${workerSessionId}`;
  }

  private async resolveDeliveries(): Promise<DefaultDeliveries> {
    if (this.deps.deliveries) return this.deps.deliveries;
    // Lazily built once per registry from the supplied manager — the pi
    // adapter is real only because the owner handed us its manager instance.
    this.deliveriesPromise ??= createDefaultDeliveries({ multiSessionManager: this.manager });
    return this.deliveriesPromise;
  }

  private resolveModel(): TalkerModelClient | null {
    if (this.resolvedModel !== undefined) return this.resolvedModel;
    const supplied = this.deps.modelClient;
    if (supplied) {
      if (typeof supplied === 'object' && typeof (supplied as TalkerModelClient).completeTurn === 'function') {
        this.resolvedModel = supplied as TalkerModelClient;
      } else {
        // Factory form: null means "not configured", which stays honest per turn.
        this.resolvedModel = (supplied as () => TalkerModelClient | null)();
      }
    } else {
      try {
        this.resolvedModel = new OpenRouterTalkerClient(resolveTalkerModelConfig(this.deps.modelEnv ?? process.env));
      } catch {
        this.resolvedModel = null;
      }
    }
    return this.resolvedModel;
  }

  private getOrCreate(workerSessionId: string, runtime: TalkerRuntime, delivery: DefaultDeliveries[TalkerRuntime], model: TalkerModelClient): TalkerSession {
    const key = this.key(workerSessionId, runtime);
    const existing = this.sessions.get(key);
    if (existing) {
      // Touch for LRU ordering.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    const created = new TalkerSession({
      model,
      // P10: the adapter boundary is timed transparently (mechanism-labelled
      // latency only) — outcomes and texts pass through byte-identical.
      delivery: createObservedDelivery(delivery, { metrics: this.voiceRecorder.metrics }),
      workerSessionId,
      runtime,
      observability: this.voiceRecorder,
      snapshotProvider: () => this.buildSnapshotFor(runtime, workerSessionId),
    });
    this.sessions.set(key, created);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return created;
  }

  /**
   * Per-runtime snapshot dispatch (P11, closing F3). Pi keeps the original
   * Pi-manager read unchanged; Claude reads its own service through the
   * read-only seam; every other runtime gets an explicit honest cannot-tell
   * fallback — never an accidental read of the wrong manager, never an
   * invented status.
   */
  private buildSnapshotFor(runtime: TalkerRuntime, workerSessionId: string): WorkerStateSnapshot | Promise<WorkerStateSnapshot> {
    if (runtime === 'claude') return this.buildClaudeSnapshot(workerSessionId);
    if (runtime === 'pi') return this.buildSnapshot(workerSessionId);
    return { activity: honestUnavailableActivity(runtime) };
  }

  /** The registry's Claude state source: the injected one, or the server singleton (lazy, cached). */
  private async resolveClaudeWorkerState(): Promise<TalkerClaudeWorkerState | null> {
    if (this.deps.claudeWorkerState) return this.deps.claudeWorkerState;
    if (this.claudeWorkerState === undefined) {
      try {
        // Lazy dynamic import: importing this module must not drag the runtime
        // services into every test or harness runner (same rule as delivery.ts).
        const { getClaudeService } = await import('../claude/index.js');
        this.claudeWorkerState = getClaudeService();
      } catch {
        this.claudeWorkerState = null; // resolution failed: the honest cannot-observe line stays.
      }
    }
    return this.claudeWorkerState;
  }

  /**
   * Real Claude worker state for the status view (P11/F3). Reads only what the
   * Claude service already observes. Live running-state wins over the (possibly
   * stale) registry status; a stale 'running' registry entry is never reported
   * as running once the live observation says otherwise. Every failure degrades
   * to a plainer, weaker view — never to an invented one.
   */
  private async buildClaudeSnapshot(workerSessionId: string): Promise<WorkerStateSnapshot> {
    let source: TalkerClaudeWorkerState | null = null;
    try {
      source = await this.resolveClaudeWorkerState();
    } catch {
      source = null;
    }
    if (!source) return { activity: honestUnavailableActivity('claude') };

    let known: boolean;
    try {
      known = source.hasSession(workerSessionId);
    } catch {
      return { activity: honestUnavailableActivity('claude') };
    }
    if (!known) {
      return { activity: 'worker session is not loaded on this server' };
    }

    let running = false;
    try {
      running = source.isRunning(workerSessionId);
    } catch {
      running = false;
    }

    let registryStatus: string | undefined;
    if (!running) {
      try {
        const entry = await source.getSession(workerSessionId);
        registryStatus = typeof entry?.status === 'string' ? entry.status : undefined;
      } catch {
        registryStatus = undefined;
      }
    }
    // Live observation outranks the persisted status; a persisted non-running
    // status ('idle' | 'error') is itself an observation and is kept.
    const status = running ? 'running' : (registryStatus === 'error' ? 'error' : 'idle');

    let lastAssistantText: string | undefined;
    try {
      const history = await source.loadSessionHistory(workerSessionId);
      for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        if (entry?.type === 'assistant' && typeof entry.content === 'string' && entry.content.trim()) {
          lastAssistantText = entry.content;
          break;
        }
      }
    } catch {
      // History unreadable: the status-derived view is still honest.
    }

    return {
      activity: `worker status: ${status}`,
      ...(lastAssistantText ? { lastAssistantText } : {}),
    };
  }

  /**
   * Fresh worker-state material, rebuilt on every conversational turn (plan
   * §10.9 state-view freshness). Reads only what the manager already holds in
   * memory; an unloaded session yields an honest minimal view.
   */
  private buildSnapshot(workerSessionId: string): WorkerStateSnapshot {
    const status = this.manager.getSessionStatus(workerSessionId);
    let lastAssistantText: string | undefined;
    try {
      const messages = this.manager.getAgentSession(workerSessionId)?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; content?: unknown };
        if (m?.role === 'assistant') {
          lastAssistantText = extractTextContent(m.content);
          break;
        }
      }
    } catch {
      // Unloaded/disposed session: the status-derived view is still honest.
    }
    if (!status) {
      return { activity: 'worker session is not loaded on this server', ...(lastAssistantText ? { lastAssistantText } : {}) };
    }
    const stepSuffix = typeof status.currentStep === 'number' && status.currentStep > 0 ? `, step ${status.currentStep}` : '';
    return {
      activity: `worker status: ${status.status}${stepSuffix}`,
      ...(lastAssistantText ? { lastAssistantText } : {}),
    };
  }
}

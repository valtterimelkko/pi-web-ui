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
import type { ReleaseVariant } from './proposal-store.js';
import { digestTurn, type DigestKind } from './digest.js';
import { createDefaultDeliveries, type DefaultDeliveries } from './delivery.js';
import { createObservedDelivery, createVoiceTurnRecorder, noteVoiceLaneBound, noteVoiceLaneDisposed, type VoiceTurnRecorder } from './observability.js';
import { OpenRouterTalkerClient, resolveTalkerModelConfig } from './model-client.js';
import { detectPromptInjection } from '../security/prompt-injection.js';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';
import type { TalkerModelClient, TalkerTurnResult, WorkerHistoryEntry, WorkerStateSnapshot } from './types.js';
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
  /** The worker session this talker relays to. Either identifier works (P12): the session path (the pi manager's key) or the session id the server issued in `session_created` — resolved against the manager's own index. */
  workerSessionId: string;
  /** The operator's verbatim utterance. */
  utterance: string;
  runtime?: TalkerRuntime;
  /**
   * The operator's focus/hold control, when it is on (P18 package C).
   * Projection input only: it tells the talker that worker answers are not
   * being spoken, so it can suggest leaving focus. It cannot switch anything
   * and it is never an input to the gate.
   */
  operatorFocus?: boolean;
  /**
   * D2 (card-contract brief): which bytes a confirmation releases —
   * 'tidied' (default) the relay text, 'original' the operator's raw words.
   * Passed straight through to the talker's single release path, which
   * honours it ONLY on the confirm branch; this registry adds no capability
   * and has no release path of its own.
   */
  releaseVariant?: ReleaseVariant;
  /**
   * D-card (contract 1.44.0): the proposal identity the confirming card
   * displayed, echoed back for the release gate. Passed straight through to
   * the talker's confirm branch, which refuses mechanically when it no longer
   * describes the current draft; this registry adds no capability and has no
   * release path of its own.
   */
  proposalRef?: { version: number; hash: string };
}

export interface TalkerOperatorTurnResult {
  /** What the operator hears. */
  reply: string;
  /** Set when the utterance never reached the talker (honest, surfaced). */
  refused?: 'prompt_injection' | 'model_unconfigured' | 'deliveries_unavailable';
  /** Present when the talker session processed the turn. */
  turn?: TalkerTurnResult;
}

/**
 * Why a digest could not be produced (P17). Every one of these means the caller
 * falls back to reading the turn in full — an unavailable digest costs speech
 * quality, never words.
 */
export type TalkerDigestRefusal = 'model_unconfigured' | 'unsafe_input' | 'empty_text';

export interface TalkerDigestInput {
  /** The worker session the digest belongs to (correlation only: the digest
   *  reads the text it is given, not the session's state). */
  workerSessionId: string;
  kind: DigestKind;
  /** The worker's output to digest (the unplayed remainder after a flip). */
  text: string;
  /** What the operator has already heard — never repeated by the digest. */
  spokenPrefix?: string;
  runtime?: TalkerRuntime;
}

export interface TalkerDigestResult {
  /** The words to speak; absent whenever `refused`/`error` is set. */
  digest?: string;
  refused?: TalkerDigestRefusal;
  error?: string;
}

/**
 * Phase 8 (plan): the fixed host announcement spoken once by the cascade after
 * a live-engine fallback. Host-written — never model output — so the operator
 * always hears that the live engine stopped and that the cascade is serving
 * them. No reason text or provider error is read aloud.
 */
export const TALKER_LIVE_ENGINE_FALLBACK_ANNOUNCEMENT =
  'The live voice engine stopped, so I am on the standard talker now. Nothing you had pending was lost.';

/** Phase 8: a live-engine fallback note for one worker lane. */
export interface TalkerEngineFallbackInput {
  /** Worker session the live lane was attached to (id or path; resolved canonically). */
  workerSessionId: string;
  runtime?: TalkerRuntime;
  /** The voice lane that degraded (observation only). */
  laneId?: string;
  /** Short cause, e.g. `voice_provider_unavailable: reason`. Never spoken. */
  reason: string;
  atMs?: number;
}

export interface TalkerEngineFallbackRecord {
  workerSessionId: string;
  runtime: TalkerRuntime;
  laneId?: string;
  reason: string;
  atMs: number;
  /** True once the one-time announcement rode a cascade reply. */
  announced: boolean;
}

export interface TalkerSessionRegistryDeps {
  /** The manager the server already owns — supplied by the owner, never created here. */
  multiSessionManager: MultiSessionManager;
  /**
   * Resolve a wire session id to its on-disk session, for the relay's
   * load-on-demand step (the server's session registry). Sessions are loaded
   * lazily, so a relay to an idle — or post-restart — worker has to be able to
   * find and load it; without this the delivery refuses loudly instead of
   * delivering (operator incident 2026-09-16).
   */
  resolveWorkerSession?: (sessionId: string) => Promise<{ path: string; cwd?: string } | undefined>;
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
/** Bound on remembered engine-fallback notes (low-cardinality diagnostic state). */
const MAX_ENGINE_FALLBACKS = 64;

/** Split a `${runtime}:${workerSessionId}` key — refs are paths and may contain colons. */
function splitLaneKey(key: string): [TalkerRuntime, string] {
  const sep = key.indexOf(':');
  return [key.slice(0, sep) as TalkerRuntime, key.slice(sep + 1)];
}

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

/**
 * P20: how many conversation messages a provider passes to the projection at
 * most (references to strings the session already holds — cheap). The full
 * count travels separately as `historyTotal`, so the view's truncation
 * disclosure stays true even when the tail is capped.
 */
const HISTORY_PROVIDER_TAIL = 200;

/**
 * P20: the session's earlier conversation for the projection — user and
 * assistant messages only (tool results are harness noise, never spoken
 * material), non-empty text only, oldest first. The renderer bounds and
 * clips; the provider's job is only to be truthful about the total.
 */
function toHistoryEntries(
  list: Array<{ role?: unknown; content?: unknown }>,
  tail: number = HISTORY_PROVIDER_TAIL
): {
  entries: WorkerHistoryEntry[];
  total: number;
} {
  const entries: WorkerHistoryEntry[] = [];
  for (const m of list) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = extractTextContent(m.content)?.trim();
    if (!text) continue;
    entries.push({ role: m.role, text });
  }
  const total = entries.length;
  return { entries: entries.slice(-Math.max(1, tail)), total };
}

export class TalkerSessionRegistry {
  private readonly manager: MultiSessionManager;
  private readonly deps: TalkerSessionRegistryDeps;
  /** key: `${runtime}:${workerSessionId}` — insertion order is the LRU order. */
  private readonly sessions = new Map<string, TalkerSession>();
  /**
   * Phase 8: worker lanes whose live engine failed and are now served by this
   * cascade. Observation only (the announcement + diagnostics); it carries no
   * delivery capability and never touches the gate.
   */
  private readonly engineFallbacks = new Map<string, TalkerEngineFallbackRecord>();
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
  /**
   * The worker state projection for a session, for consumers that are not a
   * talker turn — the native voice lane, whose live talker must answer questions
   * about the same worker and therefore needs the same world (2026-09-18 field
   * report: it held a status line and could only refuse).
   *
   * Read-only and bounded by the same renderer; never an authority.
   */
  async workerStateSnapshot(
    workerSessionId: string,
    runtime: TalkerRuntime = 'pi',
    options: { historyTail?: number } = {}
  ): Promise<WorkerStateSnapshot> {
    try {
      return await this.buildSnapshotFor(runtime, workerSessionId, options.historyTail ?? HISTORY_PROVIDER_TAIL);
    } catch {
      return { activity: honestUnavailableActivity(runtime) };
    }
  }

  getMultiSessionManager(): MultiSessionManager {
    return this.manager;
  }

  get(workerSessionId: string, runtime: TalkerRuntime = 'pi'): TalkerSession | undefined {
    return this.sessions.get(this.key(this.canonicalWorkerRef(workerSessionId, runtime), runtime));
  }

  has(workerSessionId: string, runtime: TalkerRuntime = 'pi'): boolean {
    return this.sessions.has(this.key(this.canonicalWorkerRef(workerSessionId, runtime), runtime));
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(workerSessionId: string, runtime: TalkerRuntime = 'pi'): void {
    const key = this.key(this.canonicalWorkerRef(workerSessionId, runtime), runtime);
    this.sessions.delete(key);
    // Phase 8: the lane is gone, so a fallback note for it is stale; a future
    // attachment must not be greeted by an old announcement.
    this.engineFallbacks.delete(key);
    // P24: the lane is no longer live — the binding query must not name it.
    noteVoiceLaneDisposed(...splitLaneKey(key));
  }

  disposeAll(): void {
    for (const key of this.sessions.keys()) noteVoiceLaneDisposed(...splitLaneKey(key));
    this.sessions.clear();
  }

  /**
   * The operator-turn entry point. Applies the prompt-injection gate first,
   * then hands the utterance to the worker session's talker (creating it on
   * first use). This module has no other public way to reach the worker.
   */
  async handleOperatorTurn(input: TalkerOperatorTurnInput): Promise<TalkerOperatorTurnResult> {
    const runtime: TalkerRuntime = input.runtime ?? 'pi';
    // P12: resolve the caller's reference ONCE, up front, so the talker state
    // key, the stored delivery target and the snapshot read all use the same
    // canonical value. Callers may supply the session id (the value the server
    // itself issues in `session_created`) or the session path (the manager's
    // key); an unresolvable reference passes through unchanged and fails
    // closed downstream with the loud "Session <ref> does not exist" refusal.
    const workerRef = this.canonicalWorkerRef(input.workerSessionId, runtime);
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
        workerSessionId: workerRef,
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
        workerSessionId: workerRef,
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
        workerSessionId: workerRef,
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
        workerSessionId: workerRef,
        utterance: input.utterance,
        refused: 'model_unconfigured',
      });
      return { reply: TALKER_MODEL_UNCONFIGURED_ACK, refused: 'model_unconfigured' };
    }

    const talker = this.getOrCreate(workerRef, runtime, delivery, model);
    const turn = await talker.handleOperatorTurn(input.utterance, {
      ...(input.operatorFocus !== undefined ? { operatorFocus: input.operatorFocus } : {}),
      ...(input.releaseVariant !== undefined ? { releaseVariant: input.releaseVariant } : {}),
      ...(input.proposalRef !== undefined ? { proposalRef: input.proposalRef } : {}),
    });
    // Phase 8: the first successful cascade reply after a live-engine fallback
    // carries the host announcement exactly once. Consumed only after a turn
    // actually happened, so a pre-model refusal cannot swallow it.
    const fallbackAnnouncement = this.consumeEngineFallbackAnnouncement(workerRef, runtime);
    return {
      reply: fallbackAnnouncement ? `${fallbackAnnouncement} ${turn.reply}` : turn.reply,
      turn,
    };
  }

  /**
   * Phase 8: record that a lane's live engine failed and the Gemma cascade now
   * serves this worker. The next successful cascade reply speaks the fixed
   * announcement once. Observation only — this method cannot deliver anything
   * and is not an input to the gate (N1/N8).
   */
  noteEngineFallback(input: TalkerEngineFallbackInput): TalkerEngineFallbackRecord {
    const runtime = input.runtime ?? 'pi';
    const workerSessionId = this.canonicalWorkerRef(input.workerSessionId, runtime);
    const record: TalkerEngineFallbackRecord = {
      workerSessionId,
      runtime,
      ...(input.laneId !== undefined ? { laneId: input.laneId } : {}),
      reason: input.reason.slice(0, 200),
      atMs: input.atMs ?? Date.now(),
      announced: false,
    };
    const key = this.key(workerSessionId, runtime);
    this.engineFallbacks.delete(key);
    this.engineFallbacks.set(key, record);
    while (this.engineFallbacks.size > MAX_ENGINE_FALLBACKS) {
      const oldest = this.engineFallbacks.keys().next().value;
      if (oldest === undefined) break;
      this.engineFallbacks.delete(oldest);
    }
    return record;
  }

  /** The recorded live→cascade fallback for a worker lane, if any. */
  getEngineFallback(workerSessionId: string, runtime: TalkerRuntime = 'pi'): TalkerEngineFallbackRecord | null {
    return this.engineFallbacks.get(this.key(this.canonicalWorkerRef(workerSessionId, runtime), runtime)) ?? null;
  }

  /** All live→cascade fallback notes (bounded, newest last); diagnostics only. */
  listEngineFallbacks(): TalkerEngineFallbackRecord[] {
    return [...this.engineFallbacks.values()].map((record) => ({ ...record }));
  }

  private consumeEngineFallbackAnnouncement(workerSessionId: string, runtime: TalkerRuntime): string | null {
    const record = this.getEngineFallback(workerSessionId, runtime);
    if (!record || record.announced) return null;
    record.announced = true;
    return TALKER_LIVE_ENGINE_FALLBACK_ANNOUNCEMENT;
  }

  /**
   * The digest entry point (P17 reading levels).
   *
   * This is deliberately NOT an operator turn. It carries the WORKER's output to
   * the talker's model and returns words for the OPERATOR — summarising runs in
   * one direction only. It creates no talker session, records no utterance,
   * touches no draft, and has no delivery adapter at all, so no reading-level
   * convenience can reach the confirm-gated relay path.
   */
  async handleDigest(input: TalkerDigestInput): Promise<TalkerDigestResult> {
    const text = input.text?.trim() ?? '';
    if (!text) {
      return { refused: 'empty_text' };
    }

    // The worker's own output is material to read, never instructions to obey.
    // Text that trips the block-severity injection detector is refused rather
    // than digested; the caller reads the turn in full instead, so nothing the
    // operator needed is lost.
    if (detectPromptInjection(text).recommendation === 'block') {
      return { refused: 'unsafe_input' };
    }

    const model = this.resolveModel();
    if (!model) {
      return { refused: 'model_unconfigured' };
    }

    try {
      const outcome = await digestTurn(model, {
        kind: input.kind,
        text,
        ...(input.spokenPrefix ? { spokenPrefix: input.spokenPrefix } : {}),
      });
      return { digest: outcome.digest };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private key(workerSessionId: string, runtime: TalkerRuntime): string {
    return `${runtime}:${workerSessionId}`;
  }

  /**
   * P12: resolve a caller-supplied worker reference to the manager's canonical
   * session key before it may key talker state or reach a delivery adapter.
   *
   * Pi's MultiSessionManager keys sessions by session PATH while the server
   * issues session IDS on the wire (session_created) — the UI correctly uses
   * the id, the server-side relay validations correctly used the path, and
   * both must land on the same talker session and the same delivery target.
   * Resolution is explicit, against the manager's own index (resolveSessionRef)
   * — never a guess. An unresolved reference is passed through unchanged so the
   * delivery fails closed with the loud "Session <ref> does not exist"
   * refusal (unchanged behaviour). Claude and Antigravity key their services by
   * the server-issued id already, so their references are canonical as given.
   * Managers without the resolver (older test doubles) keep today's
   * passthrough semantics.
   */
  private canonicalWorkerRef(workerSessionId: string, runtime: TalkerRuntime): string {
    if (runtime !== 'pi') return workerSessionId;
    return this.manager.resolveSessionRef?.(workerSessionId) ?? workerSessionId;
  }

  private async resolveDeliveries(): Promise<DefaultDeliveries> {
    if (this.deps.deliveries) return this.deps.deliveries;
    // Lazily built once per registry from the supplied manager — the pi
    // adapter is real only because the owner handed us its manager instance.
    this.deliveriesPromise ??= createDefaultDeliveries({
      multiSessionManager: this.manager,
      ...(this.deps.resolveWorkerSession ? { resolveWorkerSession: this.deps.resolveWorkerSession } : {}),
    });
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
    // P24: a talker session now exists for this lane — record the binding so
    // "which worker session is the talker attached to?" is one query.
    noteVoiceLaneBound(runtime, workerSessionId);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      noteVoiceLaneDisposed(...splitLaneKey(oldest));
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
  private buildSnapshotFor(
    runtime: TalkerRuntime,
    workerSessionId: string,
    historyTail: number = HISTORY_PROVIDER_TAIL
  ): WorkerStateSnapshot | Promise<WorkerStateSnapshot> {
    // Only the Pi source can read a deeper tail; the Claude snapshot carries no
    // history in this path, so it is not given a bound it would ignore.
    if (runtime === 'claude') return this.buildClaudeSnapshot(workerSessionId);
    if (runtime === 'pi') return this.buildSnapshot(workerSessionId, historyTail);
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

    let claudeHistory: { entries: WorkerHistoryEntry[]; total: number } | undefined;
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
      // P20: the session's earlier conversation, mapped to the projection's
      // entry shape. meta/tool/tool_result/error entries are harness noise,
      // never spoken material.
      const built = toHistoryEntries(
        history.map(e => ({ role: e.type, content: e.content }))
      );
      if (built.total > 0) claudeHistory = built;
    } catch {
      // History unreadable: the status-derived view is still honest.
    }
    const historyFields = claudeHistory
      ? { recentHistory: claudeHistory.entries, historyTotal: claudeHistory.total }
      : {};

    return {
      activity: `worker status: ${status}`,
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...historyFields,
    };
  }

  /**
   * Fresh worker-state material, rebuilt on every conversational turn (plan
   * §10.9 state-view freshness). Reads only what the manager already holds in
   * memory; an unloaded session yields an honest minimal view. P20: the
   * session's earlier conversation joins the view, bounded by the renderer,
   * with a truthful total so truncation is disclosed, never hidden.
   */
  private buildSnapshot(workerSessionId: string, historyTail: number = HISTORY_PROVIDER_TAIL): WorkerStateSnapshot {
    const status = this.manager.getSessionStatus(workerSessionId);
    let lastAssistantText: string | undefined;
    let history: { entries: WorkerHistoryEntry[]; total: number } | undefined;
    try {
      const messages = this.manager.getAgentSession(workerSessionId)?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; content?: unknown };
        if (m?.role === 'assistant') {
          lastAssistantText = extractTextContent(m.content);
          break;
        }
      }
      const built = toHistoryEntries(messages as Array<{ role?: unknown; content?: unknown }>, historyTail);
      if (built.total > 0) history = built;
    } catch {
      // Unloaded/disposed session: the status-derived view is still honest.
    }
    const historyFields = history
      ? { recentHistory: history.entries, historyTotal: history.total }
      : {};
    if (!status) {
      return { activity: 'worker session is not loaded on this server', ...(lastAssistantText ? { lastAssistantText } : {}), ...historyFields };
    }
    const stepSuffix = typeof status.currentStep === 'number' && status.currentStep > 0 ? `, step ${status.currentStep}` : '';
    return {
      activity: `worker status: ${status.status}${stepSuffix}`,
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...historyFields,
    };
  }
}

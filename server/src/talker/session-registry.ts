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

  constructor(deps: TalkerSessionRegistryDeps) {
    this.deps = deps;
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
      return { reply: TALKER_INJECTION_BLOCKED_ACK, refused: 'prompt_injection' };
    }

    let deliveries: DefaultDeliveries;
    try {
      deliveries = await this.resolveDeliveries();
    } catch (error) {
      return {
        reply: `${DELIVERIES_UNAVAILABLE_ACK} (${error instanceof Error ? error.message : String(error)})`,
        refused: 'deliveries_unavailable',
      };
    }
    const delivery = deliveries[runtime];
    if (!delivery) {
      return {
        reply: `${DELIVERIES_UNAVAILABLE_ACK} (no delivery adapter for runtime '${runtime}')`,
        refused: 'deliveries_unavailable',
      };
    }

    const model = this.resolveModel();
    if (!model) {
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
      delivery,
      workerSessionId,
      snapshotProvider: () => this.buildSnapshot(workerSessionId),
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

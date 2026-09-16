/**
 * Voice Mode observability (P10 — docs/plans/VOICE-MODE-OBSERVABILITY-DESIGN.md).
 *
 * OBSERVATION ONLY. This module records what the talker already decided; it
 * has no send path, no gate input, and no state the talker reads. Every
 * emission is wrapped so a failure here can never alter a turn. It extends
 * the central doctrine (docs/OBSERVABILITY.md): records flow through the one
 * central logger into the one scrubbed diagnostics ring, counters through the
 * one operational-metrics registry. No second buffer, no new endpoint.
 *
 * What it emits, per the design:
 *   D1  one `voice turn` info record per operator turn (VoiceMode component),
 *       correlated by `voiceTurnId` = `${runtime}:${workerSessionId}:${turn}`.
 *   D2  a `voice release` record (bytes, digest, excerpt, the delivery
 *       adapter's own outcome/mechanism) and a `voice gate denied` record
 *       (mechanical reason: nothing_pending | lapsed | ambiguous |
 *       cancel_classified) — plus `voice turn refused` for pre-talk registry
 *       refusals (injection-blocked / model unconfigured / deliveries
 *       unavailable), which have no talker-session turn and therefore no
 *       voiceTurnId.
 *   D3  the voice_* metrics in the shared operational-metrics registry.
 *
 * Honesty rules (design): unknown fields are OMITTED, never invented; the
 * classifier emits no reason today, so `classifierReason` is not emitted at
 * all; excerpts are bounded (≤120 chars); full utterance or reply bodies are
 * never logged.
 *
 * P24 diagnosability: the correlation fields are also carried IN the log
 * message itself (`voice turn pi:<workerSessionId>:<turn>`), so the worker
 * session a lane is bound to is greppable from journalctl without a JSON
 * formatter. And because info records age out of the shared diagnostics ring
 * on a busy server, this module also keeps TWO small process-local stores of
 * its own, written on the same observation path and read by the existing
 * diagnostics route (GET /api/v1/diagnostics):
 *   - `getVoiceLaneBindings()` — one record per LIVE talker session (runtime,
 *     worker session id, boundAt, lastTurnAt, turnCount); the one-query answer
 *     to "which worker session is the talker attached to?".
 *   - `getRecentVoiceTurns(n)` — the last n turns as bounded excerpts of the
 *     operator's utterance and the talker's reply, truncation-disclosed and
 *     scrubbed on the same path as every record, so a recent voice
 *     conversation can be reviewed without log capture.
 *
 * PRIVACY GOVERNANCE (P24, a decision the operator can veto): the conversation
 * store holds the operator's own speech and the talker's replies — bounded,
 * local runtime state, never persisted, never committed. It is WRITE-ONLY
 * observation: nothing in the talker reads it back, it feeds no draft and no
 * release path, and the gate below is untouched. The default diagnostics
 * response carries lane METADATA only; utterance text is returned only behind
 * the explicit `?voiceConversation=<n>` opt-in (see routes/diagnostics.ts), so
 * ordinary agent-facing diagnostics traffic never carries operator speech.
 * Text that the prompt-injection gate blocked is never excerpted anywhere.
 */

import { createHash } from 'node:crypto';
import { createLogger, type Logger } from '../logging/logger.js';
import { safeLogValue } from '../logging/safe-record.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';
import type { DraftSelection, DraftSnapshot } from './pending-proposal.js';
import type { DeliveryOutcome, TalkerTurnResult, WorkerDelivery } from './types.js';

/** Same three-runtime union as the registry's TalkerRuntime (kept local so this module stays cycle-free). */
export type VoiceRuntime = 'pi' | 'claude' | 'antigravity';

export const VOICE_LOG_COMPONENT = 'VoiceMode';

export const UTTERANCE_EXCERPT_MAX_CHARS = 120;

/** P24: the conversation ring holds turns (not transcripts); this is its cap. */
export const VOICE_CONVERSATION_MAX_TURNS = 50;

/** P24: per-field excerpt cap in the conversation ring (larger than the log excerpt cap). */
export const VOICE_CONVERSATION_EXCERPT_MAX_CHARS = 500;

/** P24: cap on the lane-binding table (independent of the registry's own LRU cap). */
export const VOICE_LANES_MAX = 64;

export type VoiceGateDenialReason = 'nothing_pending' | 'lapsed' | 'ambiguous' | 'cancel_classified';

export type VoiceTurnPhase = 'answered' | 'proposed' | 'released' | 'refused' | 'cancelled' | 'error';

export type VoiceDraftAction = 'accumulated' | 'superseded' | 'cleared' | 'none';

export type VoiceRegistryRefusal = 'prompt_injection' | 'model_unconfigured' | 'deliveries_unavailable';

/**
 * P24: one bounded conversation record — what the operator said and what the
 * talker replied, for one turn. Excerpts are length-capped with the true
 * lengths kept alongside, so truncation is disclosed, never hidden. Stored
 * scrubbed (the same safeLogValue projection the central logger applies).
 */
export interface VoiceConversationTurn {
  /** null for pre-talk registry refusals — no talker turn existed. */
  voiceTurnId: string | null;
  ts: string;
  runtime: VoiceRuntime;
  workerSessionId: string;
  turnIndex: number | null;
  phase: VoiceTurnPhase;
  utteranceClass?: string;
  /** Why the registry refused before any talker turn (refusal records only). */
  refused?: VoiceRegistryRefusal;
  utteranceExcerpt?: string;
  utteranceTruncated?: boolean;
  utteranceChars?: number;
  /** What the operator heard back (crash turns have none). */
  replyExcerpt?: string;
  replyTruncated?: boolean;
  replyChars?: number;
  released: boolean;
  deliveryOutcome?: string;
  /**
   * WHY a relay was refused (operator incident 2026-09-16). The outcome alone
   * ("refused") cannot be acted on, and the ring is in-memory — it dies with
   * the process — so the reason must be recorded here AND in the journal line.
   */
  deliveryError?: string;
  error?: string;
}

/** P24: one live talker-session binding, as returned by the diagnostics route. */
export interface VoiceLaneBinding {
  runtime: VoiceRuntime;
  workerSessionId: string;
  /** When the talker session was created for this lane (first operator turn). */
  boundAt: string;
  lastTurnAt?: string;
  turnCount: number;
}

// ─── P24: the process-local stores (written by the recorder, read by the diagnostics route) ────

const conversationTurns: VoiceConversationTurn[] = [];
const lanes = new Map<string, {
  runtime: VoiceRuntime;
  workerSessionId: string;
  boundAt: string;
  lastTurnAt?: string;
  turnCount: number;
}>();

function laneKey(runtime: VoiceRuntime, workerSessionId: string): string {
  return `${runtime}:${workerSessionId}`;
}

/** Written by the recorder per observed turn; scrubbed and bounded like every record. */
function recordConversationTurn(turn: VoiceConversationTurn): void {
  try {
    conversationTurns.push(safeLogValue(turn) as VoiceConversationTurn);
    if (conversationTurns.length > VOICE_CONVERSATION_MAX_TURNS) {
      conversationTurns.splice(0, conversationTurns.length - VOICE_CONVERSATION_MAX_TURNS);
    }
    // Lane counts track real talker turns; pre-talk refusals (no voiceTurnId)
    // are visible in the conversation ring but never create or count a lane.
    if (turn.voiceTurnId !== null) {
      const lane = lanes.get(laneKey(turn.runtime, turn.workerSessionId));
      if (lane) {
        lane.lastTurnAt = turn.ts;
        lane.turnCount += 1;
      }
    }
  } catch {
    // Observation must never alter the turn.
  }
}

/** Called by the session registry when a talker session is created for a lane. */
export function noteVoiceLaneBound(runtime: VoiceRuntime, workerSessionId: string, boundAt: string = new Date().toISOString()): void {
  try {
    const key = laneKey(runtime, workerSessionId);
    if (!lanes.has(key) && lanes.size >= VOICE_LANES_MAX) {
      const oldest = lanes.keys().next().value;
      if (oldest !== undefined) lanes.delete(oldest);
    }
    lanes.set(key, { runtime, workerSessionId, boundAt, turnCount: 0 });
  } catch {
    // Observation must never alter the turn.
  }
}

/** Called by the session registry when a talker session leaves (dispose or LRU eviction). */
export function noteVoiceLaneDisposed(runtime: VoiceRuntime, workerSessionId: string): void {
  try {
    lanes.delete(laneKey(runtime, workerSessionId));
  } catch {
    // Observation must never alter the turn.
  }
}

/** The live lane bindings, oldest-bound first. Cloned; safe to hand to a route. */
export function getVoiceLaneBindings(): VoiceLaneBinding[] {
  return Array.from(lanes.values(), (lane) => ({
    runtime: lane.runtime,
    workerSessionId: lane.workerSessionId,
    boundAt: lane.boundAt,
    ...(lane.lastTurnAt ? { lastTurnAt: lane.lastTurnAt } : {}),
    turnCount: lane.turnCount,
  }));
}

/** The last `limit` conversation turns, oldest first. Cloned; safe to hand to a route. */
export function getRecentVoiceTurns(limit: number = 10): VoiceConversationTurn[] {
  const n = Number.isFinite(limit) ? Math.max(0, Math.min(VOICE_CONVERSATION_MAX_TURNS, Math.floor(limit))) : 10;
  return conversationTurns.slice(-n).map((turn) => ({ ...turn }));
}

/** Test helper: clear both P24 stores. */
export function resetVoiceObservabilityStoreForTests(): void {
  conversationTurns.length = 0;
  lanes.clear();
}

/** Length-cap + truncation disclosure for the conversation ring. */
function conversationExcerpt(text: string): { excerpt: string; truncated: boolean } {
  return text.length <= VOICE_CONVERSATION_EXCERPT_MAX_CHARS
    ? { excerpt: text, truncated: false }
    : { excerpt: text.slice(0, VOICE_CONVERSATION_EXCERPT_MAX_CHARS), truncated: true };
}

/** Pure pre/post-state reads the talker wrapper performs around one turn. */
export interface VoiceTurnObservation {
  runtime: VoiceRuntime;
  workerSessionId: string;
  turn: number;
  utterance: string;
  /** Draft snapshot before the turn (null when the operator was not composing). */
  draftBefore: DraftSnapshot | null;
  /** Draft snapshot after the turn. */
  draftAfter: DraftSnapshot | null;
  /** Was the confirmation window lapsed at decision time (mechanical recomputation). */
  lapsedBefore: boolean;
  /** Ordinal selection parsed from the utterance, if any. */
  selection: DraftSelection | null;
  /** Whether that selection would resolve against the draft (null when no selection). */
  selectionResolvable: boolean | null;
}

export interface VoiceTurnRecorder {
  /** The metrics instance this recorder counts into (so wiring keeps one coherent instance). */
  readonly metrics: OperationalMetrics;
  /** D1 (+ D2/metrics). Never throws. */
  observeTurn(observation: VoiceTurnObservation, result: TalkerTurnResult, durationMs: number): void;
  /** D1 for a turn that crashed before producing a result. Never throws. */
  observeCrash(observation: VoiceTurnObservation, error: unknown, durationMs: number): void;
  /** Pre-talk registry refusal: no talker-session turn exists, hence no voiceTurnId. Never throws. */
  observeRegistryRefusal(input: {
    runtime: VoiceRuntime;
    workerSessionId: string;
    utterance: string;
    refused: VoiceRegistryRefusal;
  }): void;
}

/** Bounded excerpt: the operator's own words are the point, the buffer's size budget is the limit. */
export function voiceExcerpt(text: string): string {
  return text.length <= UTTERANCE_EXCERPT_MAX_CHARS ? text : text.slice(0, UTTERANCE_EXCERPT_MAX_CHARS);
}

/** Short content digest so a released text can be verified against the worker transcript without logging it whole. */
export function voiceDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export interface VoiceTurnRecorderOptions {
  logger?: Logger;
  metrics?: OperationalMetrics;
}

export function createVoiceTurnRecorder(options: VoiceTurnRecorderOptions = {}): VoiceTurnRecorder {
  const logger = options.logger ?? createLogger(VOICE_LOG_COMPONENT);
  const metrics = options.metrics ?? getOperationalMetrics();

  function correlation(obs: { runtime: VoiceRuntime; workerSessionId: string; turn: number }): Record<string, unknown> {
    return {
      runtime: obs.runtime,
      workerSessionId: obs.workerSessionId,
      turnIndex: obs.turn,
      voiceTurnId: voiceTurnId(obs),
    };
  }

  function voiceTurnId(obs: { runtime: VoiceRuntime; workerSessionId: string; turn: number }): string {
    return `${obs.runtime}:${obs.workerSessionId}:${obs.turn}`;
  }

  /** P24 conversation-ring projection of the operator's utterance. */
  function conversationExcerptFields(text: string, prefix: 'utterance'): Record<string, unknown> {
    const capped = conversationExcerpt(text);
    return {
      [`${prefix}Excerpt`]: capped.excerpt,
      [`${prefix}Truncated`]: capped.truncated,
      [`${prefix}Chars`]: text.length,
    };
  }

  /** P24 conversation-ring projection of what the operator heard back. */
  function conversationReplyFields(reply: string | undefined): Record<string, unknown> {
    if (typeof reply !== 'string') return {};
    const capped = conversationExcerpt(reply);
    return { replyExcerpt: capped.excerpt, replyTruncated: capped.truncated, replyChars: reply.length };
  }

  /**
   * The mechanical gate outcome of a confirm-classified turn that released
   * nothing — derived from the same pure reads the talker's branches used,
   * in the same order, so the reason is the branch the talker took.
   */
  function gateDenialReason(obs: VoiceTurnObservation, result: TalkerTurnResult): VoiceGateDenialReason | null {
    if (result.released) return null;
    if (result.utteranceClass === 'confirm') {
      if (!obs.draftBefore) return 'nothing_pending';
      if (obs.lapsedBefore) return 'lapsed';
      if (obs.selection !== null && obs.selectionResolvable === false) return 'ambiguous';
      return null;
    }
    // A cancel-CLASSIFIED utterance is the one non-confirm way the gate stays
    // shut: the held draft died unrelayed (the operator withdrew it).
    if (result.cancelled && obs.draftBefore) return 'cancel_classified';
    return null;
  }

  function derivePhase(obs: VoiceTurnObservation, result: TalkerTurnResult, denial: VoiceGateDenialReason | null): VoiceTurnPhase {
    if (result.error !== undefined) return 'error';
    if (result.released) return 'released';
    if (result.cancelled && obs.draftBefore) return 'cancelled';
    if (denial) return 'refused';
    if (obs.draftAfter) return 'proposed';
    return 'answered';
  }

  function deriveDraftAction(obs: VoiceTurnObservation, result: TalkerTurnResult): VoiceDraftAction {
    if (result.released) return 'superseded';
    if (result.cancelled && obs.draftBefore) return 'cleared';
    const after = obs.draftAfter?.utterances.length;
    const before = obs.draftBefore?.utterances.length;
    if (after !== undefined && (before === undefined || after > before)) return 'accumulated';
    return 'none';
  }

  function deliveryFields(delivery: DeliveryOutcome): Record<string, unknown> {
    const fields: Record<string, unknown> = { deliveryOutcome: delivery.outcome };
    if ('mechanism' in delivery) fields.releaseMechanism = delivery.mechanism;
    if ('disclosure' in delivery && delivery.disclosure !== undefined) fields.deliveryDisclosure = delivery.disclosure;
    if (delivery.outcome === 'refused') fields.deliveryError = delivery.reason;
    return fields;
  }

  return {
    metrics,

    observeTurn(observation, result, durationMs): void {
      try {
        const denial = gateDenialReason(observation, result);
        const phase = derivePhase(observation, result, denial);
        const receiptAckEmitted = result.receiptAck !== undefined;

        const turnFields: Record<string, unknown> = {
          ...correlation(observation),
          phase,
          utteranceClass: result.utteranceClass,
          utteranceChars: observation.utterance.length,
          utteranceExcerpt: voiceExcerpt(observation.utterance),
          draftAction: deriveDraftAction(observation, result),
          gatePending: observation.draftBefore !== null && !observation.lapsedBefore,
          receiptAckEmitted,
          // P18/1: an honoured ask-the-worker offer (observation only).
          askWorkerOfferEmitted: result.askWorkerOffer === true,
          modelCalled: result.modelCalled,
          durationMs,
        };
        if (observation.draftBefore) turnFields.draftSizeBefore = observation.draftBefore.utterances.length;
        if (observation.draftAfter) turnFields.draftSizeAfter = observation.draftAfter.utterances.length;
        if (result.modelCalled && result.latency) {
          turnFields.modelTtftMs = result.latency.ttftMs;
          turnFields.modelLatencyMs = result.latency.totalMs;
        }
        if (result.modelCalled && result.error === undefined) turnFields.outputChars = result.reply.length;
        if (result.error !== undefined) turnFields.error = result.error;

        // P24: the message itself carries the correlation triple, so the worker
        // session is greppable from journalctl without a JSON formatter.
        logger.child(turnFields).info(`voice turn ${voiceTurnId(observation)}`);
        recordConversationTurn({
          voiceTurnId: voiceTurnId(observation),
          ts: new Date().toISOString(),
          runtime: observation.runtime,
          workerSessionId: observation.workerSessionId,
          turnIndex: observation.turn,
          phase,
          utteranceClass: result.utteranceClass,
          ...conversationExcerptFields(observation.utterance, 'utterance'),
          ...conversationReplyFields(result.reply),
          released: result.released != null,
          ...(result.released ? { deliveryOutcome: result.released.delivery.outcome } : {}),
          ...(result.released && result.released.delivery.outcome === 'refused'
            ? { deliveryError: String(safeLogValue(result.released.delivery.reason)) }
            : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        metrics.recordVoiceTurn(phase);
        metrics.recordVoiceTurnDuration(durationMs);
        if (result.modelCalled && result.latency) metrics.recordVoiceModelLatency(result.latency.totalMs);
        if (receiptAckEmitted) metrics.recordVoiceReceiptAck();

        if (result.released) {
          const delivery = result.released.delivery;
          logger.child({
            ...correlation(observation),
            phase: 'released' as const,
            releasedUtteranceId: result.released.utteranceId,
            releasedBytes: Buffer.byteLength(result.released.text, 'utf8'),
            releasedSha256: voiceDigest(result.released.text),
            releasedExcerpt: voiceExcerpt(result.released.text),
            ...deliveryFields(delivery),
          }).info(
            // The pretty renderer prints the message plus the correlation
            // suffix only, so a reason kept in a bound field is INVISIBLE in
            // production (measured: `deliveryError` never appeared once in the
            // journal). The outcome — and, when refused, the reason — therefore
            // go IN the line, scrubbed like every other logged value.
            `voice release ${voiceTurnId(observation)} — ${delivery.outcome}`
              + (delivery.outcome === 'refused' ? `: ${String(safeLogValue(delivery.reason))}` : '')
          );
          const mechanism = 'mechanism' in delivery ? delivery.mechanism : 'none';
          metrics.recordVoiceRelease(mechanism, delivery.outcome);
        } else if (denial) {
          logger.child({
            ...correlation(observation),
            phase: 'refused' as const,
            gateDenialReason: denial,
            gatePending: observation.draftBefore !== null && !observation.lapsedBefore,
            utteranceClass: result.utteranceClass,
          }).info(`voice gate denied ${voiceTurnId(observation)}`);
          metrics.recordVoiceGateDenied(denial);
        }
      } catch {
        // Observation must never alter the turn.
      }
    },

    observeCrash(observation, error, durationMs): void {
      try {
        logger.child({
          ...correlation(observation),
          phase: 'error' as const,
          utteranceChars: observation.utterance.length,
          utteranceExcerpt: voiceExcerpt(observation.utterance),
          durationMs,
          error: error instanceof Error ? error.message : String(error),
        }).info(`voice turn ${voiceTurnId(observation)}`);
        recordConversationTurn({
          voiceTurnId: voiceTurnId(observation),
          ts: new Date().toISOString(),
          runtime: observation.runtime,
          workerSessionId: observation.workerSessionId,
          turnIndex: observation.turn,
          phase: 'error',
          ...conversationExcerptFields(observation.utterance, 'utterance'),
          released: false,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.recordVoiceTurn('error');
      } catch {
        // Observation must never alter the turn.
      }
    },

    observeRegistryRefusal(input): void {
      try {
        logger.child({
          phase: 'refused' as const,
          refused: input.refused,
          runtime: input.runtime,
          workerSessionId: input.workerSessionId,
          utteranceChars: input.utterance.length,
          // Blocked attack text is never excerpted; everything else is.
          ...(input.refused !== 'prompt_injection' ? { utteranceExcerpt: voiceExcerpt(input.utterance) } : {}),
          gatePending: false,
        }).info(`voice turn refused runtime=${input.runtime} worker=${input.workerSessionId}`);
        recordConversationTurn({
          voiceTurnId: null,
          ts: new Date().toISOString(),
          runtime: input.runtime,
          workerSessionId: input.workerSessionId,
          turnIndex: null,
          phase: 'refused',
          refused: input.refused,
          // Blocked attack text is never excerpted anywhere.
          ...(input.refused !== 'prompt_injection' ? conversationExcerptFields(input.utterance, 'utterance') : {}),
          released: false,
        });
        metrics.recordVoiceTurn('refused');
      } catch {
        // Observation must never alter the turn.
      }
    },
  };
}

/**
 * Time the delivery adapter boundary WITHOUT touching it: outcomes, texts and
 * refusals pass through byte-identical; only the wall time of the call is
 * observed into `voice_delivery_latency_ms{mechanism}`. A refused outcome has
 * no mechanism and records no latency — nothing is invented.
 */
export function createObservedDelivery(delivery: WorkerDelivery, deps: { metrics?: OperationalMetrics } = {}): WorkerDelivery {
  const metrics = deps.metrics ?? getOperationalMetrics();
  return {
    describe: () => delivery.describe(),
    async deliver(input): Promise<DeliveryOutcome> {
      const startedAt = Date.now();
      let outcome: DeliveryOutcome | undefined;
      try {
        outcome = await delivery.deliver(input);
        return outcome;
      } finally {
        try {
          if (outcome && 'mechanism' in outcome) {
            metrics.recordVoiceDeliveryLatency(outcome.mechanism, Date.now() - startedAt);
          }
        } catch {
          // Observation must never alter the delivery.
        }
      }
    },
  };
}

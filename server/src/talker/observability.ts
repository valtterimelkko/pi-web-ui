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
 */

import { createHash } from 'node:crypto';
import { createLogger, type Logger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';
import type { DraftSelection, DraftSnapshot } from './pending-proposal.js';
import type { DeliveryOutcome, TalkerTurnResult, WorkerDelivery } from './types.js';

/** Same three-runtime union as the registry's TalkerRuntime (kept local so this module stays cycle-free). */
export type VoiceRuntime = 'pi' | 'claude' | 'antigravity';

export const VOICE_LOG_COMPONENT = 'VoiceMode';

export const UTTERANCE_EXCERPT_MAX_CHARS = 120;

export type VoiceGateDenialReason = 'nothing_pending' | 'lapsed' | 'ambiguous' | 'cancel_classified';

export type VoiceTurnPhase = 'answered' | 'proposed' | 'released' | 'refused' | 'cancelled' | 'error';

export type VoiceDraftAction = 'accumulated' | 'superseded' | 'cleared' | 'none';

export type VoiceRegistryRefusal = 'prompt_injection' | 'model_unconfigured' | 'deliveries_unavailable';

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

        logger.child(turnFields).info('voice turn');
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
          }).info('voice release');
          const mechanism = 'mechanism' in delivery ? delivery.mechanism : 'none';
          metrics.recordVoiceRelease(mechanism, delivery.outcome);
        } else if (denial) {
          logger.child({
            ...correlation(observation),
            phase: 'refused' as const,
            gateDenialReason: denial,
            gatePending: observation.draftBefore !== null && !observation.lapsedBefore,
            utteranceClass: result.utteranceClass,
          }).info('voice gate denied');
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
        }).info('voice turn');
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
        }).info('voice turn refused');
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

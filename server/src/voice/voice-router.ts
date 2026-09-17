/**
 * Voice router (Track B, plan Phase 3; contract §6.4).
 *
 * The thin handler Phase 5 registers in `routeMessage`: one case per
 * client→server voice type, each delegating here. It:
 *   1. runs the CONTRACT's own `checkVoiceEnvelope` and returns the refusal
 *      code on failure (nothing acted on);
 *   2. resolves the lane and attachment generation from `getState`, refusing
 *      `voice_lane_unknown` / `voice_generation_stale` / `voice_not_started`;
 *   3. routes audio, activity, lifecycle and the reading-level operation to the
 *      bridge service, and the kernel-owned frames (promotion, confirmation,
 *      cancel, presentation, parking list) to a bound kernel delegate;
 *   4. adds no capability of its own: it never releases, never composes text and
 *      never widens the gate (N8).
 *
 * `mapBridgeEventToServerMessage` is the other half of the seam: the pure
 * translation from the service's emitted events to wire messages, so Phase 5
 * only has to bind a lane to a socket and call it.
 */

import {
  checkVoiceEnvelope,
  VOICE_WIRE_VERSION,
  type VoiceBridgeEmittedEvent,
  type VoiceBridgeLaneState,
  type VoiceBridgeService,
  type VoiceClientMessage,
  type VoiceClientMessageType,
  type VoiceErrorCode,
  type VoiceRouteContext,
  type VoiceRouter,
  type VoiceServerMessage,
} from './contract.js';

/** Client→server types the bridge service owns. */
export const BRIDGE_OWNED_CLIENT_MESSAGE_TYPES = [
  'voice_session_start',
  'voice_session_stop',
  'voice_audio_chunk',
  'voice_activity_state',
  'voice_reading_level',
] as const satisfies readonly VoiceClientMessageType[];

/** Client→server types the kernel owns (never touched by this service). */
export const KERNEL_OWNED_CLIENT_MESSAGE_TYPES = [
  'proposal_confirm',
  'proposal_cancel',
  'proposal_presentation',
  'parking_promote',
  'parking_list',
] as const satisfies readonly VoiceClientMessageType[];

/**
 * Phase 5 binds the kernel here. The router never implements a kernel decision;
 * without a delegate, a kernel-owned frame is refused with `voice_internal_error`
 * (surfaced, never silently accepted).
 */
export interface VoiceKernelDelegate {
  handle(context: VoiceRouteContext, message: VoiceClientMessage): Promise<VoiceErrorCode | null>;
}

export interface VoiceSessionRouterOptions {
  service: VoiceBridgeService;
  kernel?: VoiceKernelDelegate | null;
}

type LaneResolution =
  | { ok: true; state: VoiceBridgeLaneState }
  | { ok: false; code: VoiceErrorCode };

export class VoiceSessionRouter implements VoiceRouter {
  private readonly service: VoiceBridgeService;
  private readonly kernel: VoiceKernelDelegate | null;

  constructor(options: VoiceSessionRouterOptions) {
    this.service = options.service;
    this.kernel = options.kernel ?? null;
  }

  async handle(context: VoiceRouteContext, message: VoiceClientMessage): Promise<VoiceErrorCode | null> {
    const check = checkVoiceEnvelope(message, 'client-to-server');
    if (!check.ok) return check.code;

    switch (message.type) {
      case 'voice_session_start':
        await this.service.start({
          laneId: message.laneId,
          attachmentGeneration: message.attachmentGeneration,
          workerSessionId: message.workerSessionId,
          runtime: message.runtime ?? 'pi',
          captureMode: message.captureMode ?? 'open-mic',
          readingLevel: message.readingLevel ?? 'verbatim',
          resume: message.resume ?? false,
          callbacks: {},
        });
        return null;

      case 'voice_session_stop':
        await this.service.stop(message.laneId, message.reason);
        return null;

      case 'voice_audio_chunk': {
        const resolved = this.resolveLane(message.laneId, message.attachmentGeneration);
        if (!resolved.ok) return resolved.code;
        if (resolved.state.state !== 'live') return 'voice_not_started';
        this.service.feedAudio({
          laneId: message.laneId,
          attachmentGeneration: message.attachmentGeneration,
          seq: message.seq,
          mimeType: message.mimeType,
          data: message.data,
          durationMs: message.durationMs,
          capturedAtMs: message.capturedAtMs,
        });
        return null;
      }

      case 'voice_activity_state': {
        const resolved = this.resolveLane(message.laneId, message.attachmentGeneration);
        if (!resolved.ok) return resolved.code;
        this.service.noteActivity({
          laneId: message.laneId,
          attachmentGeneration: message.attachmentGeneration,
          state: message.state,
          atMs: message.atMs,
        });
        return null;
      }

      case 'voice_reading_level': {
        const resolved = this.resolveLane(message.laneId, message.attachmentGeneration);
        if (!resolved.ok) return resolved.code;
        this.service.setReadingLevel(message.laneId, message.level);
        return null;
      }

      default: {
        // Kernel-owned: promotion, confirmation, cancel, presentation, parking.
        if (!this.kernel) return 'voice_internal_error';
        return this.kernel.handle(context, message);
      }
    }
  }

  private resolveLane(laneId: string, attachmentGeneration: number): LaneResolution {
    const state = this.service.getState(laneId);
    if (!state) return { ok: false, code: 'voice_lane_unknown' };
    if (state.attachmentGeneration !== attachmentGeneration) return { ok: false, code: 'voice_generation_stale' };
    return { ok: true, state };
  }
}

// ── Event → wire mapping (the pure half of the seam) ────────────────────────

/**
 * Translate one emitted service event into the wire message Phase 5 sends, or
 * null when the event has no wire form.
 *
 * Deliberate omissions:
 *   - `tool_call` is how the KERNEL is driven (suppress / create a candidate);
 *     it never becomes a wire message and cannot release anything;
 *   - `turn_complete` has no dedicated message;
 *   - a resumption HANDLE never crosses to the client; only `resumable` does.
 */
export function mapBridgeEventToServerMessage(
  event: VoiceBridgeEmittedEvent,
  laneState?: VoiceBridgeLaneState | null
): VoiceServerMessage | null {
  const envelope = {
    version: VOICE_WIRE_VERSION,
    laneId: event.laneId,
    attachmentGeneration: event.attachmentGeneration,
  } as const;

  switch (event.kind) {
    case 'audio_out':
      return {
        ...envelope,
        type: 'voice_audio_chunk',
        seq: event.seq,
        mimeType: event.mimeType,
        data: event.data,
        durationMs: event.durationMs,
        atMs: event.atMs,
      };
    case 'transcript':
      return {
        ...envelope,
        type: 'transcript_delta',
        speaker: event.speaker,
        source: event.source,
        text: event.text,
        final: event.final,
        ...(event.utteranceId !== undefined ? { utteranceId: event.utteranceId } : {}),
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        atMs: event.atMs,
      };
    case 'interrupted':
      return { ...envelope, type: 'voice_state', state: 'live', detail: 'provider interrupted playback' };
    case 'resumption':
      return { ...envelope, type: 'voice_state', state: 'live', resumption: { resumable: event.resumable } };
    case 'go_away':
      return {
        ...envelope,
        type: 'voice_state',
        state: 'reconnecting',
        detail: event.timeLeft ? `provider goAway: ${event.timeLeft}` : 'provider goAway',
      };
    case 'state':
      return {
        ...envelope,
        type: 'voice_state',
        state: event.state,
        ...(event.detail ? { detail: event.detail } : {}),
        // The wire message carries the structured lane facts the surface
        // renders (contract §4.4). The event itself is deliberately minimal.
        ...(laneState
          ? {
              workerActivity: laneState.workerActivity,
              readingLevel: laneState.readingLevel,
              captureMode: laneState.captureMode,
              resumption: { resumable: laneState.resumable },
            }
          : {}),
      };
    case 'error':
      return { ...envelope, type: 'voice_error', code: event.code, message: event.message, fatal: event.fatal };
    case 'turn_complete':
    case 'tool_call':
      return null;
  }
}

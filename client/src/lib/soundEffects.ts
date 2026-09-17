/**
 * soundEffects — the host-owned delivery chime.
 *
 * N6 and contract §8.1: the operator learns whether an instruction actually
 * reached the worker from a sound the HOST owns, produced after the outcome is
 * known. The model never produces it, and it is never fetched: the chime is
 * synthesised locally from oscillator specs in this file. That is the whole
 * point — a free-streaming voice can say "sent it" before it is true, so the
 * one thing that must not come from the model is the confirmation sound.
 *
 * The gate is not re-implemented here: this module asks `messages.ts` for the
 * verdict (`isDeliveredReceipt`, `notDeliveredReceiptTone`), so the delivered
 * chime can only fire on `receipt_event { receipt.outcome: "delivered" }`.
 * `proposal_resolved { outcome: "released" }` is a lifecycle fact, not delivery
 * evidence, and produces no sound at all.
 *
 * Distinct sounds, deliberately:
 *   - delivered  — a bright rising two-tone: unmistakably "it landed".
 *   - refused / queued / unknown — a lower, flatter, clearly different figure,
 *     so an honest bad outcome is never mistaken for a good one.
 */

import type { VoiceReceiptOutcome, VoiceServerMessage } from '@pi-web-ui/shared';
import { isDeliveredReceipt, notDeliveredReceiptTone } from './voiceLive/messages';

/** The chime variants this module can play. */
export type ChimeVariant = 'delivered' | 'refused' | 'queued' | 'unknown';

export interface ChimeTone {
  frequencyHz: number;
  /** Offset from the chime's start, in ms. */
  startOffsetMs: number;
  durationMs: number;
  /** Peak gain of this tone (0–1). */
  gain: number;
  type: OscillatorType;
}

export interface ChimeSpec {
  variant: ChimeVariant;
  tones: readonly ChimeTone[];
  /** Total length in ms (the scheduler uses it to place the end marker). */
  totalMs: number;
}

/** Quiet but distinct: audible over speech without masking it. */
export const CHIME_PEAK_GAIN = 0.16;

/** The delivered chime: rising fifth, short, unmistakable. */
export const DELIVERY_CHIME: ChimeSpec = {
  variant: 'delivered',
  tones: [
    { frequencyHz: 880, startOffsetMs: 0, durationMs: 120, gain: CHIME_PEAK_GAIN, type: 'sine' },
    { frequencyHz: 1320, startOffsetMs: 90, durationMs: 190, gain: CHIME_PEAK_GAIN, type: 'sine' },
  ],
  totalMs: 280,
};

/** Honest non-delivery figures — lower, flatter, and NOT the delivered figure. */
export const NOT_DELIVERED_CHIMES: Record<'refused' | 'queued' | 'unknown', ChimeSpec> = {
  refused: {
    variant: 'refused',
    tones: [
      { frequencyHz: 420, startOffsetMs: 0, durationMs: 130, gain: CHIME_PEAK_GAIN, type: 'triangle' },
      { frequencyHz: 300, startOffsetMs: 110, durationMs: 220, gain: CHIME_PEAK_GAIN, type: 'triangle' },
    ],
    totalMs: 330,
  },
  queued: {
    variant: 'queued',
    tones: [
      { frequencyHz: 520, startOffsetMs: 0, durationMs: 150, gain: CHIME_PEAK_GAIN, type: 'sine' },
      { frequencyHz: 520, startOffsetMs: 170, durationMs: 150, gain: CHIME_PEAK_GAIN, type: 'sine' },
    ],
    totalMs: 320,
  },
  unknown: {
    variant: 'unknown',
    tones: [
      { frequencyHz: 460, startOffsetMs: 0, durationMs: 160, gain: CHIME_PEAK_GAIN, type: 'triangle' },
      { frequencyHz: 392, startOffsetMs: 150, durationMs: 210, gain: CHIME_PEAK_GAIN, type: 'triangle' },
    ],
    totalMs: 360,
  },
};

/** The spec for one receipt outcome. Delivered maps only to the delivered spec. */
export function chimeSpecFor(outcome: VoiceReceiptOutcome): ChimeSpec {
  if (outcome === 'delivered') return DELIVERY_CHIME;
  if (outcome === 'refused') return NOT_DELIVERED_CHIMES.refused;
  if (outcome === 'queued') return NOT_DELIVERED_CHIMES.queued;
  return NOT_DELIVERED_CHIMES.unknown;
}

/**
 * The one chime gate for a wire message. Returns the variant to play, or null
 * when this message must be silent.
 */
export function chimeVariantForMessage(message: VoiceServerMessage): ChimeVariant | null {
  if (isDeliveredReceipt(message)) return 'delivered';
  return notDeliveredReceiptTone(message);
}

// ── Scheduling ──────────────────────────────────────────────────────────────

/** The audio graph the chime needs. Tiny, so tests can be exact. */
export interface ChimeBackend {
  currentTime(): number;
  /** Book one tone to begin at the absolute backend time `startAt` (seconds). */
  play(tone: ChimeTone, startAt: number): void;
}

/**
 * Book every tone of `spec` on the backend, starting at `atTime` (defaults to
 * now). Returns the time the chime finishes, so a caller can avoid overlapping
 * two chimes.
 */
export function playChime(
  spec: ChimeSpec,
  backend: ChimeBackend,
  atTime?: number,
): { startedAt: number; endsAt: number } {
  const startedAt = atTime ?? backend.currentTime();
  for (const tone of spec.tones) {
    backend.play(tone, startedAt + tone.startOffsetMs / 1000);
  }
  return { startedAt, endsAt: startedAt + spec.totalMs / 1000 };
}

export interface DeliveryChimeOptions {
  backend: ChimeBackend;
  /** Minimum gap between two chimes, so a burst cannot become a racket. */
  minimumGapMs?: number;
}

/**
 * The surface-facing chime player. `playForMessage` implements the protocol
 * rule directly: it plays only what `chimeVariantForMessage` returns, and never
 * invents a variant.
 */
export function createDeliveryChime(options: DeliveryChimeOptions) {
  const { backend } = options;
  const minimumGapMs = options.minimumGapMs ?? 400;
  let lastPlayedAtMs = Number.NEGATIVE_INFINITY;
  const played: ChimeVariant[] = [];

  return {
    /** Play for one wire message. Returns the variant played, or null. */
    playForMessage(message: VoiceServerMessage): ChimeVariant | null {
      const variant = chimeVariantForMessage(message);
      if (!variant) return null;
      return this.play(variant);
    },
    play(variant: ChimeVariant): ChimeVariant {
      const nowMs = backend.currentTime() * 1000;
      if (nowMs - lastPlayedAtMs < minimumGapMs) {
        // Suppressed, but still recorded: the surface can say it happened.
        played.push(variant);
        return variant;
      }
      lastPlayedAtMs = nowMs;
      playChime(chimeSpecFor(variant), backend);
      played.push(variant);
      return variant;
    },
    history(): ChimeVariant[] {
      return [...played];
    },
  };
}

// ── Web Audio backend ───────────────────────────────────────────────────────

export interface WebAudioChimeBackend extends ChimeBackend {
  readonly context: BaseAudioContext;
  readonly masterGain: GainNode;
}

/**
 * The real backend. Tones are generated by local oscillators — there is no
 * asset, no network request, and nothing that could be supplied by the model.
 */
export function createWebAudioChimeBackend(
  context: BaseAudioContext,
  destination: AudioNode = context.destination,
): WebAudioChimeBackend {
  const masterGain = context.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(destination);

  return {
    context,
    masterGain,
    currentTime: () => context.currentTime,
    play(tone: ChimeTone, startAt: number): void {
      const when = Math.max(startAt, context.currentTime);
      const gain = context.createGain();
      const start = when;
      const end = when + tone.durationMs / 1000;
      // A click-free envelope: fast attack, exponential-ish release.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(tone.gain, start + Math.min(0.008, tone.durationMs / 4000));
      gain.gain.linearRampToValueAtTime(0.0001, end);
      gain.connect(masterGain);

      const oscillator = context.createOscillator();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequencyHz, start);
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(end + 0.01);
    },
  };
}

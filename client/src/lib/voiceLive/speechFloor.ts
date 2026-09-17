/**
 * voiceLive/speechFloor — the read-only seam onto the shared speech arbiter.
 *
 * The arbiter owns the priority ladder and the "the operator holds the floor"
 * decision (`client/src/lib/speechArbiter.ts`). Native voice playback needs to
 * READ that decision to duck to 15% while the operator speaks, and must never
 * write it: here the arbiter is published as a `SpeechFloorSource` whose only
 * methods are `getState()` and `subscribe()`.
 *
 * This module is deliberately a re-export plus a structural type, not a second
 * arbiter: `NORMAL_VOLUME` / `DUCKED_VOLUME` have exactly one definition, in the
 * arbiter, so ducking can never drift between the TTS path and the native PCM
 * path. Nothing here adds capture authority to the arbiter (N5) — the pipeline
 * does not call `setOperatorSpeaking`; the capture VAD does, and only the VAD.
 */

export { DUCKED_VOLUME, NORMAL_VOLUME } from '../speechArbiter';
import type { SpeechArbiter } from '../speechArbiter';

/** The slice of arbiter state the playback scheduler reacts to. */
export interface SpeechTierState {
  operatorSpeaking: boolean;
  ducked: boolean;
  playing: boolean;
  paused: boolean;
}

/**
 * The read-only view of the speech floor. `speechArbiter` satisfies it
 * structurally; tests use a small fake.
 */
export interface SpeechFloorSource {
  getState(): SpeechTierState;
  subscribe(fn: () => void): () => void;
}

/** Publish an arbiter as the read-only floor (no writer is exposed). */
export function asSpeechFloorSource(arbiter: SpeechArbiter): SpeechFloorSource {
  return {
    getState: () => arbiter.getState(),
    subscribe: (fn) => arbiter.subscribe(fn),
  };
}

/**
 * voiceFloor — derives "who currently has the floor" for the Voice Mode
 * surface, from state the surface already receives.
 *
 * Spec: docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md §4.1 (the speech priority
 * ladder). The four states the operator asked to tell apart at a glance:
 *
 *   - you-have-the-floor  the operator is speaking (rule 1 — never interrupted;
 *                         in-flight speech is ducked, never stopped)
 *   - talker-speaking     playback is in flight and the floor is free
 *   - working-silently    the worker runs and nothing is speaking
 *   - answer-ready-held   speech is ready but deferred (queued behind the
 *                         floor, or paused) — deferral is visibly deliberate
 *
 * Pure derivation only: this module reads nothing, sends nothing, and has no
 * side effects. The speech arbiter remains the sole playback scheduler; this
 * module only projects its `getState()` (plus capture/worker flags) into a
 * display state.
 */
import type { ArbiterState } from '../../lib/speechArbiter';

export type VoiceFloorState =
  | 'you-have-the-floor'
  | 'talker-speaking'
  | 'working-silently'
  | 'answer-ready-held'
  | 'idle';

/** User-facing label per state — distinct strings, distinct at a glance. */
export const FLOOR_STATE_LABEL: Record<VoiceFloorState, string> = {
  'you-have-the-floor': 'You have the floor',
  'talker-speaking': 'Talker speaking',
  'working-silently': 'Working silently',
  'answer-ready-held': 'Answer ready — held',
  idle: 'Ready — tap to speak',
};

/** The three arbiter signals the floor derivation needs. */
export interface ArbiterFloorSignals {
  /** A chunk is in flight and not paused. */
  playing: boolean;
  /** Speech is ready but waiting: queued intents, or paused mid-intent. */
  holding: boolean;
  /** In-flight speech is ducked because the operator holds the floor. */
  ducked: boolean;
}

export interface FloorInput {
  operatorSpeaking: boolean;
  arbiter: ArbiterFloorSignals;
  workerStreaming: boolean;
}

export interface FloorView {
  state: VoiceFloorState;
  /** True when an answer/speech is ready but deliberately waiting. */
  speechHeld: boolean;
  /** True when in-flight speech is ducked under the operator's floor. */
  ducked: boolean;
}

/**
 * Precedence mirrors the ladder: the operator's floor outranks playback;
 * playback outranks held speech; a held answer outranks the worker's silent
 * running (the held state is the more specific, more actionable one).
 */
export function deriveFloorState(input: FloorInput): FloorView {
  const { operatorSpeaking, arbiter, workerStreaming } = input;

  if (operatorSpeaking) {
    // §4.1 rule 1 — the operator's floor. Speech may be playing underneath
    // (ducked, never stopped) and answers may queue (held); both surface as
    // badges on the floor state, never as a competing state.
    return {
      state: 'you-have-the-floor',
      speechHeld: arbiter.holding,
      ducked: arbiter.ducked,
    };
  }
  if (arbiter.playing) {
    return { state: 'talker-speaking', speechHeld: false, ducked: false };
  }
  if (arbiter.holding) {
    return { state: 'answer-ready-held', speechHeld: true, ducked: false };
  }
  if (workerStreaming) {
    return { state: 'working-silently', speechHeld: false, ducked: false };
  }
  return { state: 'idle', speechHeld: false, ducked: false };
}

/** Project the frozen arbiter's getState() into the three floor signals. */
export function arbiterFloorSignals(st: ArbiterState): ArbiterFloorSignals {
  return {
    playing: st.current !== null && !st.paused,
    holding: st.queued.length > 0 || (st.paused === true && st.current !== null),
    ducked: st.ducked,
  };
}

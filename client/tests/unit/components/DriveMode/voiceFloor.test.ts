import { describe, it, expect } from 'vitest';
import {
  deriveFloorState,
  arbiterFloorSignals,
  FLOOR_STATE_LABEL,
  type VoiceFloorState,
} from '../../../../src/components/DriveMode/voiceFloor';
import type { ArbiterState } from '../../../../src/lib/speechArbiter';

/** Build a minimal ArbiterState-like object for the mapping helper. */
function arbiterState(over: Partial<ArbiterState>): ArbiterState {
  return {
    playing: false,
    paused: false,
    ducked: false,
    operatorSpeaking: false,
    current: null,
    queued: [],
    ...over,
  } as ArbiterState;
}

describe('voiceFloor — the four states, visually unmistakable (plan §4.1)', () => {
  it('operator holding the floor → "you-have-the-floor", even while speech is playing', () => {
    // Barge-in combination: the operator taps the mic while the talker is
    // mid-sentence. The FLOOR is the operator's; the speech ducks.
    const view = deriveFloorState({
      operatorSpeaking: true,
      arbiter: { playing: true, holding: false, ducked: true },
      workerStreaming: true,
    });
    expect(view.state).toBe('you-have-the-floor');
    expect(view.ducked).toBe(true);
  });

  it('arbiter playing and floor free → "talker-speaking"', () => {
    const view = deriveFloorState({
      operatorSpeaking: false,
      arbiter: { playing: true, holding: false, ducked: false },
      workerStreaming: false,
    });
    expect(view.state).toBe('talker-speaking');
  });

  it('worker streaming with nothing speaking → "working-silently"', () => {
    const view = deriveFloorState({
      operatorSpeaking: false,
      arbiter: { playing: false, holding: false, ducked: false },
      workerStreaming: true,
    });
    expect(view.state).toBe('working-silently');
  });

  it('speech deferred (queued) → "answer-ready-held", flagged speechHeld', () => {
    const view = deriveFloorState({
      operatorSpeaking: false,
      arbiter: { playing: false, holding: true, ducked: false },
      workerStreaming: false,
    });
    expect(view.state).toBe('answer-ready-held');
    expect(view.speechHeld).toBe(true);
  });

  it('held beats working-silently: a queued answer while the worker runs shows the held state', () => {
    const view = deriveFloorState({
      operatorSpeaking: false,
      arbiter: { playing: false, holding: true, ducked: false },
      workerStreaming: true,
    });
    expect(view.state).toBe('answer-ready-held');
  });

  it('nothing happening → "idle"', () => {
    const view = deriveFloorState({
      operatorSpeaking: false,
      arbiter: { playing: false, holding: false, ducked: false },
      workerStreaming: false,
    });
    expect(view.state).toBe('idle');
  });

  it('the four required states are mutually distinguishable and labelled distinctly', () => {
    // Each state derives from a different input combination, and every state
    // carries a distinct user-facing label — the operator can tell AT A
    // GLANCE who currently has the floor.
    const states: VoiceFloorState[] = [
      'you-have-the-floor',
      'talker-speaking',
      'working-silently',
      'answer-ready-held',
    ];
    expect(new Set(states).size).toBe(4);
    const labels = states.map((s) => FLOOR_STATE_LABEL[s]);
    expect(new Set(labels).size).toBe(4);
    expect(FLOOR_STATE_LABEL['you-have-the-floor']).toContain('floor');
  });

  describe('arbiterFloorSignals — mapping the frozen arbiter\'s getState()', () => {
    it('playing = current chunk in flight and not paused', () => {
      const s = arbiterFloorSignals(
        arbiterState({ current: { id: 'x', tier: 3, chunkIndex: 0, totalChunks: 2 } })
      );
      expect(s.playing).toBe(true);
      expect(s.holding).toBe(false);
    });

    it('holding = queued intents waiting, or paused mid-intent', () => {
      const queuedOnly = arbiterFloorSignals(
        arbiterState({ queued: [{ id: 'a', tier: 3 }] })
      );
      expect(queuedOnly.holding).toBe(true);
      expect(queuedOnly.playing).toBe(false);

      const pausedMid = arbiterFloorSignals(
        arbiterState({
          paused: true,
          current: { id: 'x', tier: 3, chunkIndex: 1, totalChunks: 2 },
        })
      );
      expect(pausedMid.holding).toBe(true);
      expect(pausedMid.playing).toBe(false);
    });

    it('ducked passes through for the barge-in badge', () => {
      const s = arbiterFloorSignals(arbiterState({ ducked: true }));
      expect(s.ducked).toBe(true);
    });
  });
});

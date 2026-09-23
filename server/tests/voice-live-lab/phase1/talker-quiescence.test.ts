import { describe, expect, it } from 'vitest';
import { talkerActivityCount } from '../../../../scripts/voice-lane-lab/lib/talker-quiescence.js';

/**
 * W4 campaign, conductor: the confirm turns must wait for the TALKER'S TURN to
 * settle, not only for its audio. The et-high model emits whole text turns with
 * no audio (C01-et-high/attempt-04), so an audio-only quiescence counter
 * reported "quiet" while the model was still mid-turn and the confirm was
 * dropped as echo.
 */
describe('talkerActivityCount — quiescence sees the talker’s text, not only its audio', () => {
  it('counts egress audio even with no wire frames', () => {
    expect(talkerActivityCount({ egressCount: 7, wireFrames: [] })).toBe(7);
  });

  it('counts the talker’s inbound transcript deltas (the text-only turn the egress counter misses)', () => {
    const frames = [
      { direction: 'inbound', type: 'transcript_delta', frame: { speaker: 'talker' } },
      { direction: 'inbound', type: 'transcript_delta', frame: { speaker: 'operator' } },
      { direction: 'inbound', type: 'transcript_delta', frame: { speaker: 'talker' } },
    ];
    expect(talkerActivityCount({ egressCount: 2, wireFrames: frames })).toBe(4);
  });

  it('counts the talker’s inbound audio frames and ignores outbound frames', () => {
    const frames = [
      { direction: 'inbound', type: 'voice_audio_chunk', frame: {} },
      { direction: 'outbound', type: 'voice_audio_chunk', frame: {} },
      { direction: 'outbound', type: 'voice_session_start', frame: {} },
    ];
    expect(talkerActivityCount({ egressCount: 1, wireFrames: frames })).toBe(2);
  });

  it('is monotonic as the model keeps talking: text-only turns move the count', () => {
    const before = talkerActivityCount({
      egressCount: 5,
      wireFrames: [{ direction: 'inbound', type: 'transcript_delta', frame: { speaker: 'talker' } }],
    });
    const after = talkerActivityCount({
      egressCount: 5,
      wireFrames: [
        { direction: 'inbound', type: 'transcript_delta', frame: { speaker: 'talker' } },
        { direction: 'inbound', type: 'transcript_delta', frame: { speaker: 'talker' } },
      ],
    });
    expect(after).toBeGreaterThan(before);
  });
});

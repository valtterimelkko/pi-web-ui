import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSpeechArbiter,
  chunkIntoSentences,
  TIER_RECEIPT_ACK,
  TIER_ANSWER,
  TIER_CHATTER,
  NORMAL_VOLUME,
  DUCKED_VOLUME,
  type ArbiterPlayer,
} from './speechArbiter';

/**
 * Spec: docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md §4.1 (decided 2026-09-13).
 *
 * The invariant under everything: capture is unconditional; only playback is
 * scheduled. The arbiter may delay or drop speech; it may never gate capture.
 */

/** Flush microtasks so the arbiter's drive loop reaches its first await. */
const tick = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

type PlayerCall =
  | { kind: 'play'; chunk: string; volume: number; rate: number }
  | { kind: 'volume'; volume: number }
  | { kind: 'stop' };

/** Fake player: records every call; playChunk stays pending until finished. */
class FakePlayer implements ArbiterPlayer {
  calls: PlayerCall[] = [];
  private pending: Array<() => void> = [];

  playChunk(chunk: string, volume: number, rate: number): Promise<void> {
    this.calls.push({ kind: 'play', chunk, volume, rate });
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  setVolume(volume: number): void {
    this.calls.push({ kind: 'volume', volume });
  }

  stopCurrent(): void {
    this.calls.push({ kind: 'stop' });
    this.finishChunk();
  }

  /** Resolve the oldest in-flight chunk(s) — the chunk boundary. */
  finishChunk(n = 1): void {
    for (let i = 0; i < n; i++) {
      const resolve = this.pending.shift();
      if (resolve) resolve();
    }
  }

  playCalls(): Array<{ chunk: string; volume: number; rate: number }> {
    return this.calls
      .filter((c) => c.kind === 'play')
      .map(({ kind: _kind, ...rest }) => rest);
  }

  stopCallCount(): number {
    return this.calls.filter((c) => c.kind === 'stop').length;
  }
}

function makeArbiter() {
  const player = new FakePlayer();
  const arbiter = createSpeechArbiter();
  arbiter.attachPlayer(player);
  return { player, arbiter };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chunkIntoSentences', () => {
  it('splits on sentence terminators and keeps the punctuation', () => {
    expect(chunkIntoSentences('First sentence. Second one! Third?')).toEqual([
      'First sentence.',
      'Second one!',
      'Third?',
    ]);
  });

  it('keeps text without a trailing terminator as the final chunk', () => {
    expect(chunkIntoSentences('One. Two')).toEqual(['One.', 'Two']);
  });

  it('returns an empty array for empty or whitespace text', () => {
    expect(chunkIntoSentences('')).toEqual([]);
    expect(chunkIntoSentences('   \n  ')).toEqual([]);
  });

  it('does not split decimals or abbreviations mid-number', () => {
    expect(chunkIntoSentences('It costs 3.5 dollars. Done.')).toEqual([
      'It costs 3.5 dollars.',
      'Done.',
    ]);
  });

  it('splits an overlong sentence at whitespace', () => {
    const longSentence = `${'word '.repeat(80)}.`.trim();
    const chunks = chunkIntoSentences(longSentence, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    expect(chunks.join(' ')).toBe(longSentence);
  });
});

describe('speechArbiter — §4.1 the speech priority ladder', () => {
  it('plays a submitted intent chunk by chunk, in order, at normal volume', async () => {
    const { player, arbiter } = makeArbiter();
    expect(
      arbiter.submit({ id: 'a', tier: TIER_ANSWER, chunks: ['one.', 'two.', 'three.'] })
    ).toBe('queued');
    await tick();
    expect(player.playCalls()).toEqual([
      { chunk: 'one.', volume: NORMAL_VOLUME, rate: 1 },
    ]);
    player.finishChunk();
    await tick();
    expect(player.playCalls()).toEqual([
      { chunk: 'one.', volume: NORMAL_VOLUME, rate: 1 },
      { chunk: 'two.', volume: NORMAL_VOLUME, rate: 1 },
    ]);
    player.finishChunk();
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['one.', 'two.', 'three.']);
    player.finishChunk();
    await tick();
    expect(arbiter.getState().current).toBeNull();
  });

  it('picks the highest tier first when several wait', async () => {
    const { player, arbiter } = makeArbiter();
    // The floor is held, so nothing starts — all three genuinely queue.
    arbiter.setOperatorSpeaking(true);
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['answer.'] });
    arbiter.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] });
    arbiter.submit({ id: 'chatter', tier: TIER_CHATTER, chunks: ['chatter.'] });
    arbiter.setOperatorSpeaking(false);
    await tick();
    // Ack (tier 2) outranks the answer (tier 3).
    expect(player.playCalls()[0]?.chunk).toBe('ack.');
    player.finishChunk();
    await tick();
    expect(player.playCalls()[1]?.chunk).toBe('answer.');
    player.finishChunk();
    await tick();
    // Chatter queued from idle while higher tiers then arrived is discarded,
    // not played last.
    expect(player.playCalls()[2]).toBeUndefined();
  });

  // PINNED PROPERTY 1 — tier 4 chatter is dropped (not queued) when a higher
  // tier is waiting. §4.1 rule 4: "dropped, not queued, if it would delay 1–3".
  it('drops tier 4 chatter when a higher tier is playing or waiting', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['answer.'] });
    await tick();
    expect(arbiter.submit({ id: 'chat', tier: TIER_CHATTER, chunks: ['chat.'] })).toBe(
      'dropped'
    );
    player.finishChunk();
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['answer.']);
    expect(arbiter.getState().queued).toHaveLength(0);
  });

  it('plays tier 4 chatter when the arbiter is completely idle', async () => {
    const { player, arbiter } = makeArbiter();
    expect(arbiter.submit({ id: 'chat', tier: TIER_CHATTER, chunks: ['chat.'] })).toBe(
      'queued'
    );
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['chat.']);
  });

  // PINNED PROPERTY 2 — barge-in ducks (volume lowers, playback continues);
  // volume is restored at the next chunk boundary. Never a hard stop.
  it('ducks playback when the operator takes the floor and restores at the chunk boundary', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a.', 'b.', 'c.'] });
    await tick();
    expect(player.playCalls()).toEqual([{ chunk: 'a.', volume: NORMAL_VOLUME, rate: 1 }]);

    // The operator takes the floor mid-chunk: live duck, NO hard stop.
    arbiter.setOperatorSpeaking(true);
    expect(player.calls.some((c) => c.kind === 'volume' && c.volume === DUCKED_VOLUME)).toBe(
      true
    );
    expect(player.stopCallCount()).toBe(0);

    // Still on the floor: the next chunk starts ducked (playback continues).
    player.finishChunk();
    await tick();
    expect(player.playCalls()[1]).toEqual({ chunk: 'b.', volume: DUCKED_VOLUME, rate: 1 });

    // The floor is released mid-chunk 'b.': no live restore — the current
    // ducked chunk stays ducked; the NEXT chunk boundary restores volume.
    arbiter.setOperatorSpeaking(false);
    expect(player.calls.some((c) => c.kind === 'volume' && c.volume === NORMAL_VOLUME)).toBe(
      false
    );
    player.finishChunk();
    await tick();
    expect(player.playCalls()[2]).toEqual({ chunk: 'c.', volume: NORMAL_VOLUME, rate: 1 });
    expect(player.stopCallCount()).toBe(0);
  });

  // §4.1 rule 1 — no speech starts over an operator mid-utterance. A NEW
  // intent waits for the floor; only already-playing audio ducks.
  it('holds a newly submitted intent until the operator releases the floor', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.setOperatorSpeaking(true);
    expect(arbiter.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] })).toBe(
      'queued'
    );
    await tick();
    expect(player.playCalls()).toHaveLength(0);
    arbiter.setOperatorSpeaking(false);
    await tick();
    expect(player.playCalls()).toEqual([
      { chunk: 'ack.', volume: NORMAL_VOLUME, rate: 1 },
    ]);
  });

  // PINNED PROPERTY 3 (arbiter side) — playback state never refuses work:
  // a submission while a chunk is in flight is queued, not dropped.
  it('queues a submission made while a chunk is in flight', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] });
    await tick();
    expect(arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['answer.'] })).toBe(
      'queued'
    );
    player.finishChunk();
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['ack.', 'answer.']);
  });

  it('a tier 2 receipt ack preempts a playing tier 3 answer at the chunk boundary; the answer resumes', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a1.', 'a2.', 'a3.'] });
    await tick();
    arbiter.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] });
    player.finishChunk(); // finish a1 — the boundary
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.', 'ack.']);
    player.finishChunk(); // ack done
    await tick();
    // The answer resumes from where it was — chunk 2, not a replay of a1.
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.', 'ack.', 'a2.']);
    player.finishChunk();
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual([
      'a1.',
      'ack.',
      'a2.',
      'a3.',
    ]);
  });

  // §4.1 rule 1 — preemption is also new speech: an ack arriving while the
  // operator holds the floor must NOT start over them at the boundary. The
  // ducked answer keeps playing; the switch happens after the floor releases.
  it('does not start a preempting intent over a held floor; the switch happens at the boundary after release', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a1.', 'a2.', 'a3.'] });
    await tick();
    arbiter.setOperatorSpeaking(true); // floor: a1 continues, ducked
    arbiter.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] });
    player.finishChunk(); // a1 boundary
    await tick();
    // The answer continued ducked — the ack did not start over the operator.
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.', 'a2.']);
    expect(player.playCalls()[1].volume).toBe(DUCKED_VOLUME);

    arbiter.setOperatorSpeaking(false); // floor released
    player.finishChunk(); // a2 boundary — the ack preempts NOW
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.', 'a2.', 'ack.']);
    player.finishChunk(); // ack done
    await tick();
    // The answer resumes its last chunk after the ack.
    expect(player.playCalls().map((c) => c.chunk)).toEqual([
      'a1.',
      'a2.',
      'ack.',
      'a3.',
    ]);
  });

  it('a tier 3 answer preempts playing chatter at the chunk boundary; chatter is discarded', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'chat', tier: TIER_CHATTER, chunks: ['c1.', 'c2.'] });
    await tick();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['answer.'] });
    player.finishChunk(); // finish c1
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['c1.', 'answer.']);
    player.finishChunk();
    await tick();
    // c2 never plays — preempted chatter is dropped, not resumed.
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['c1.', 'answer.']);
  });

  describe('pause and resume at chunk boundaries', () => {
    it('pause stops at the current chunk boundary; resume continues from the next chunk', async () => {
      const { player, arbiter } = makeArbiter();
      arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a1.', 'a2.', 'a3.'] });
      await tick();
      arbiter.pause(); // takes effect at the boundary of the in-flight chunk
      player.finishChunk(); // a1 finishes — the boundary
      await tick();
      expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.']);
      expect(arbiter.getState().paused).toBe(true);

      arbiter.resume();
      await tick();
      // Resumes from the NEXT chunk — a2, never a replay of a1, never mid-word.
      expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.', 'a2.']);
      expect(arbiter.getState().paused).toBe(false);
      player.finishChunk();
      await tick();
      expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.', 'a2.', 'a3.']);
      player.finishChunk();
      await tick();
      expect(arbiter.getState().current).toBeNull();
    });

    it('pausing before playback holds subsequent submissions until resume', async () => {
      const { player, arbiter } = makeArbiter();
      arbiter.pause();
      arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a1.'] });
      await tick();
      expect(player.playCalls()).toHaveLength(0);
      arbiter.resume();
      await tick();
      expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.']);
    });
  });

  it('stopAll clears the queue and hard-stops the current chunk', async () => {
    const { player, arbiter } = makeArbiter();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a1.', 'a2.'] });
    arbiter.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] });
    await tick();
    arbiter.stopAll();
    expect(player.stopCallCount()).toBe(1);
    expect(arbiter.getState().current).toBeNull();
    expect(arbiter.getState().queued).toHaveLength(0);
    player.finishChunk();
    await tick();
    // Nothing further plays — the queue is gone.
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['a1.']);
  });

  it('drops tier 4 chatter while paused', async () => {
    const { arbiter } = makeArbiter();
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['a1.'] });
    arbiter.pause();
    expect(arbiter.submit({ id: 'chat', tier: TIER_CHATTER, chunks: ['chat.'] })).toBe(
      'dropped'
    );
  });

  it('drops waiting chatter when the operator takes the floor', async () => {
    const { player, arbiter } = makeArbiter();
    // Hold the floor, queue an answer so the queue is genuinely occupied.
    arbiter.setOperatorSpeaking(true);
    arbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['answer.'] });
    arbiter.submit({ id: 'chat', tier: TIER_CHATTER, chunks: ['chat.'] });
    arbiter.setOperatorSpeaking(false);
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['answer.']);
    player.finishChunk();
    await tick();
    expect(player.playCalls().map((c) => c.chunk)).toEqual(['answer.']);
  });

  it('reports playback failures through the error handler and keeps the queue moving', async () => {
    const { arbiter } = makeArbiter();
    const failing = new FakePlayer();
    const originalPlay = failing.playChunk.bind(failing);
    failing.playChunk = (chunk, volume, rate) => {
      if (chunk === 'bad.') {
        return Promise.reject(new Error('tts down'));
      }
      return originalPlay(chunk, volume, rate);
    };
    const arb = createSpeechArbiter();
    arb.attachPlayer(failing);
    const onError = vi.fn();
    arb.setErrorHandler(onError);
    arb.submit({ id: 'bad', tier: TIER_ANSWER, chunks: ['bad.'] });
    arb.submit({ id: 'ack', tier: TIER_RECEIPT_ACK, chunks: ['ack.'] });
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(failing.playCalls().map((c) => c.chunk)).toEqual(['ack.']);
    expect(arbiter).toBeDefined();
  });
});

/**
 * Voice Mode native-voice surface (Track C) — the two properties the brief
 * makes non-negotiable about this module:
 *
 *   1. ducking is to ≈15%, never a stop (N5), and
 *   2. the arbiter has NO capture authority (N5/N1) — there is no method on the
 *      public surface that could gate, delay or suppress microphone capture.
 */
describe('voice-live requirement — ducking level and no capture authority', () => {
  it('ducks to ≈15% volume', () => {
    expect(DUCKED_VOLUME).toBeGreaterThanOrEqual(0.13);
    expect(DUCKED_VOLUME).toBeLessThanOrEqual(0.17);
    expect(NORMAL_VOLUME).toBe(1);
    expect(DUCKED_VOLUME).toBeLessThan(NORMAL_VOLUME);
  });

  it('exposes no capture-authority method of any kind', () => {
    const arbiter = createSpeechArbiter();
    const surface = arbiter as unknown as Record<string, unknown>;
    for (const forbidden of [
      'setCaptureEnabled',
      'setCaptureMode',
      'pauseCapture',
      'resumeCapture',
      'stopCapture',
      'suppressCapture',
      'muteCapture',
      'setMicrophoneEnabled',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
    // And the direction of the one floor signal is INTO the arbiter only.
    expect(typeof arbiter.setOperatorSpeaking).toBe('function');
    expect(typeof arbiter.isOperatorSpeaking).toBe('function');
  });
});

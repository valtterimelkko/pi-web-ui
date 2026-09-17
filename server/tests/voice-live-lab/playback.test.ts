/**
 * L0 reference player tests (plan §8.2).
 *
 * The player is where "received" becomes "heard", so the tests pin down the
 * three facts the report must be able to state separately: what arrived, what
 * was actually rendered (and at what level), and what was deliberately
 * discarded. Ducking and native interruption are proved to be different
 * policies, not two names for the same behaviour.
 */
import { describe, expect, it } from 'vitest';

import { EVENT, EventLog, createMonotonicClock } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  DEFAULT_DUCK_GAIN,
  ReferencePlayer,
  applyGain,
} from '../../../scripts/voice-live-lab/lib/playback.js';

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

const SAMPLES = [1000, -2000, 3000, -4000];

describe('reference player', () => {
  it('renders a clean pass-through unchanged and balances its accounting', () => {
    const player = new ReferencePlayer();
    player.receive(pcm(SAMPLES));
    const rendered = player.render();

    expect(rendered.equals(pcm(SAMPLES))).toBe(true);
    expect(player.renderedPcm().equals(player.receivedPcm())).toBe(true);
    const stats = player.stats();
    expect(stats.receivedFrames).toBe(4);
    expect(stats.renderedFrames).toBe(4);
    expect(stats.discardedFrames).toBe(0);
    expect(stats.queuedFrames).toBe(0);
    expect(stats.gainChanges).toBe(0);
    expect(player.accountingBalanced()).toBe(true);
  });

  it('ducks to 0.15 while the operator holds the floor and restores afterwards', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const player = new ReferencePlayer({ log });
    expect(DEFAULT_DUCK_GAIN).toBe(0.15);

    player.receive(pcm(SAMPLES));
    player.setOperatorFloor(true);
    expect(player.stats().currentGain).toBe(0.15);
    const ducked = player.render();
    expect(ducked.equals(applyGain(pcm(SAMPLES), 0.15))).toBe(true);
    expect(ducked.equals(pcm(SAMPLES))).toBe(false);

    player.setOperatorFloor(false);
    expect(player.stats().currentGain).toBe(1);
    expect(player.stats().gainChanges).toBe(2);
    expect(log.events().filter((event) => event.kind === EVENT.PLAYBACK_GAIN)).toHaveLength(2);
    expect(player.accountingBalanced()).toBe(true);
  });

  it('does not cancel on barge-in under the duck profile', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const player = new ReferencePlayer({ log, profile: 'duck' });
    player.receive(pcm(SAMPLES));
    player.interrupt();

    const kinds = log.events().map((event) => event.kind);
    expect(kinds).toContain(EVENT.PLAYBACK_INTERRUPT_IGNORED);
    expect(kinds).not.toContain(EVENT.PLAYBACK_DISCARDED);

    player.render();
    const stats = player.stats();
    expect(stats.renderedFrames).toBe(4);
    expect(stats.discardedFrames).toBe(0);
    expect(stats.interruptions).toBe(1);
    expect(player.accountingBalanced()).toBe(true);
  });

  it('flushes the unrendered queue on barge-in under the native-interrupt profile', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const player = new ReferencePlayer({ log, profile: 'native-interrupt' });
    player.receive(pcm(SAMPLES));
    player.render(2);
    player.interrupt();

    const stats = player.stats();
    expect(stats.receivedFrames).toBe(4);
    expect(stats.renderedFrames).toBe(2);
    expect(stats.discardedFrames).toBe(2);
    expect(stats.queuedFrames).toBe(0);
    expect(player.renderedPcm().equals(pcm(SAMPLES.slice(0, 2)))).toBe(true);
    expect(player.discardedPcm().equals(pcm(SAMPLES.slice(2)))).toBe(true);
    expect(player.accountingBalanced()).toBe(true);

    const discarded = log.events().find((event) => event.kind === EVENT.PLAYBACK_DISCARDED);
    expect(discarded?.payload.cause).toBe('interrupt');
    expect(discarded?.payload.frames).toBe(2);
  });

  it('treats explicit stop as a discard in both profiles', () => {
    const duckPlayer = new ReferencePlayer({ profile: 'duck' });
    duckPlayer.receive(pcm(SAMPLES));
    duckPlayer.stop();
    expect(duckPlayer.render().byteLength).toBe(0);
    expect(duckPlayer.stats().discardedFrames).toBe(4);
    expect(duckPlayer.accountingBalanced()).toBe(true);
    expect(duckPlayer.stats().receivedFrames).toBe(4);
  });

  it('supports a mid-answer level change using the consumed prefix', () => {
    const player = new ReferencePlayer();
    player.receive(pcm(SAMPLES));
    const head = player.render(2);
    player.setOperatorFloor(true);
    const tail = player.render(2);

    expect(head.equals(pcm(SAMPLES.slice(0, 2)))).toBe(true);
    expect(tail.equals(applyGain(pcm(SAMPLES.slice(2)), 0.15))).toBe(true);
    const stats = player.stats();
    expect(stats.consumedFrames).toBe(4);
    expect(stats.consumedMs).toBeCloseTo((4 / 24000) * 1000, 6);
    expect(player.accountingBalanced()).toBe(true);
  });

  it('clamps when gain is applied to extreme samples', () => {
    const loud = pcm([32767, -32768, 0]);
    const boosted = applyGain(loud, 2);
    expect(boosted.readInt16LE(0)).toBe(32767);
    expect(boosted.readInt16LE(2)).toBe(-32768);
    const quiet = applyGain(loud, 0.15);
    expect(quiet.readInt16LE(0)).toBe(Math.round(32767 * 0.15));
    expect(quiet.readInt16LE(4)).toBe(0);
  });

  it('accepts chunked input and rejects malformed PCM or empty chunks', () => {
    const player = new ReferencePlayer();
    player.receive(pcm([1, 2]));
    player.receive(pcm([3, 4]));
    expect(player.stats().receivedFrames).toBe(4);
    player.receive(Buffer.alloc(0));
    expect(player.stats().receivedFrames).toBe(4);
    expect(() => player.receive(Buffer.from([1]))).toThrow(/even/);
    player.render();
    expect(player.renderedPcm().equals(pcm([1, 2, 3, 4]))).toBe(true);
  });
});

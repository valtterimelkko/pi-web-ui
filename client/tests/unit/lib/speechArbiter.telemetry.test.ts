import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSpeechArbiter,
  TIER_RECEIPT_ACK,
  TIER_ANSWER,
  TIER_CHATTER,
  type ArbiterPlayer,
} from '../../../src/lib/speechArbiter';
import {
  clearBrowserDiagnostics,
  createBrowserDiagnosticBundle,
} from '../../../src/lib/browserDiagnostics.js';

/**
 * P10 D4 — the speech arbiter's own decisions land in the browser diagnostic
 * bundle: intent submitted (tier), dropped because a higher tier was active,
 * floor held/released (barge-in), and playback failures. Behaviour is pinned
 * by speechArbiter.test.ts; this suite only observes it.
 */

/** Flush microtasks so the arbiter's drive loop reaches its first await. */
const tick = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve();
};

class FakePlayer implements ArbiterPlayer {
  calls: Array<{ kind: string; chunk?: string; volume?: number }> = [];
  failNext = false;
  private pending: Array<() => void> = [];

  playChunk(chunk: string, volume: number): Promise<void> {
    this.calls.push({ kind: 'play', chunk, volume });
    if (this.failNext) return Promise.reject(new Error('synthesis exploded'));
    return new Promise<void>((resolve) => { this.pending.push(resolve); });
  }
  setVolume(volume: number): void {
    this.calls.push({ kind: 'volume', volume });
  }
  stopCurrent(): void {
    this.calls.push({ kind: 'stop' });
  }
  finishChunk(): void {
    this.pending.shift()?.();
  }
}

function speechEvents() {
  return createBrowserDiagnosticBundle().events.filter((e) => e.kind === 'speech');
}

let player: FakePlayer;

beforeEach(() => {
  clearBrowserDiagnostics();
  player = new FakePlayer();
});

afterEach(() => clearBrowserDiagnostics());

describe('speech arbiter telemetry', () => {
  it('records an accepted intent with its tier', () => {
    const arbiter = createSpeechArbiter();
    arbiter.attachPlayer(player);
    expect(arbiter.submit({ id: 'a', tier: TIER_ANSWER, text: 'The worker finished.' })).toBe('queued');
    expect(speechEvents()).toHaveLength(1);
    expect(speechEvents()[0]).toMatchObject({ kind: 'speech', operation: 'submit', speechTier: TIER_ANSWER });
  });

  it('records chatter dropped because the arbiter was not idle', () => {
    const arbiter = createSpeechArbiter();
    arbiter.attachPlayer(player);
    arbiter.submit({ id: 'a', tier: TIER_ANSWER, text: 'answer first' });
    expect(arbiter.submit({ id: 'c', tier: TIER_CHATTER, text: 'low value chatter' })).toBe('dropped');
    const drop = speechEvents().find((e) => e.operation === 'drop');
    expect(drop).toMatchObject({ speechTier: TIER_CHATTER, state: 'busy' });
  });

  it('records floor held and released (barge-in)', async () => {
    const arbiter = createSpeechArbiter();
    arbiter.attachPlayer(player);
    arbiter.submit({ id: 'a', tier: TIER_ANSWER, text: 'long answer.' });
    await tick();
    arbiter.setOperatorSpeaking(true);
    arbiter.setOperatorSpeaking(false);
    const ops = speechEvents().map((e) => e.operation);
    expect(ops).toContain('floor_held');
    expect(ops).toContain('floor_released');
  });

  it('records a playback failure without muting the queue', async () => {
    const arbiter = createSpeechArbiter();
    arbiter.attachPlayer(player);
    player.failNext = true;
    const errors: unknown[] = [];
    arbiter.setErrorHandler((err) => errors.push(err));
    arbiter.submit({ id: 'a', tier: TIER_RECEIPT_ACK, text: 'Noted — still holding that.' });
    await tick(5);
    const failure = speechEvents().find((e) => e.operation === 'playback_failed');
    expect(failure).toBeDefined();
    expect(failure?.speechTier).toBe(TIER_RECEIPT_ACK);
    expect(failure?.errorName).toBe('Error');
    expect(errors).toHaveLength(1);
  });

  it('records explicit stop and pause/resume', () => {
    const arbiter = createSpeechArbiter();
    arbiter.attachPlayer(player);
    arbiter.pause();
    arbiter.resume();
    arbiter.stopAll();
    const ops = speechEvents().map((e) => e.operation);
    expect(ops).toEqual(['paused', 'resumed', 'stopped']);
  });
});

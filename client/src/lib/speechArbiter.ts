/**
 * speechArbiter — the client-side playback scheduler for Drive Mode speech.
 *
 * Spec: docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md §4.1 "The speech priority
 * ladder" and §4.2 "Interleaved composition" (both DECIDED by the operator,
 * 2026-09-13).
 *
 * THE INVARIANT — capture is unconditional; only playback is scheduled.
 * This module schedules speech and nothing else. It has no send capability,
 * no access to the dictation capture path, and no way to delay, refuse or
 * drop an operator utterance. The `setOperatorSpeaking` signal flows INTO
 * this module (the operator holds the floor); nothing flows out that could
 * gate capture.
 *
 * The ladder (strict precedence, highest first):
 *   1. The operator speaking is never interrupted. Expressed by
 *      `setOperatorSpeaking(true)`: already-playing audio ducks (volume
 *      lowers, never hard-stopped), new intents wait, chatter is dropped.
 *   2. A receipt ack (tier 2) speaks before anything else.
 *   3. The worker's completed answer (tier 3) speaks at the next natural gap.
 *   4. Talker chatter (tier 4) is lowest — dropped, not queued, when it
 *      cannot play immediately.
 *
 * P10 D4: every scheduling decision is observed into the existing browser
 * diagnostic ring (see speechTelemetry.ts) — submit/drop/floor/playback —
 * so "why didn't I hear it?" is answerable from the manual diagnostics
 * bundle. Observation only: the telemetry calls cannot alter scheduling.
 * Chunk boundaries are the only scheduling points. Nothing is ever cut
 * mid-chunk except an explicit `stopAll()`; barge-in ducks instead of
 * stopping, and pause/resume happen at chunk boundaries, so speech never
 * resumes mid-word (§4.1 "Chunked TTS is what makes barge-in clean").
 */

import { recordSpeechEvent } from './speechTelemetry.js';

/** Playback tiers. Tier 1 — the operator's floor — is not a playback tier;
 * it is expressed with `setOperatorSpeaking()` and outranks every intent. */
export type SpeechTier = 2 | 3 | 4;

/** §4.1 rule 2 — an unacknowledged operator utterance gets a receipt ack. */
export const TIER_RECEIPT_ACK: SpeechTier = 2;
/** §4.1 rule 3 — the worker's completed answer. */
export const TIER_ANSWER: SpeechTier = 3;
/** §4.1 rule 4 — the talker's own conversational chatter. */
export const TIER_CHATTER: SpeechTier = 4;

export const NORMAL_VOLUME = 1;
/** Ducked volume while the operator holds the floor (barge-in). */
export const DUCKED_VOLUME = 0.15;

export interface SpeechIntentInput {
  /** Stable caller-chosen id (e.g. a message id); generated when omitted. */
  id?: string;
  tier: SpeechTier;
  /** Pre-chunked speech. Either `chunks` or `text` must be given. */
  chunks?: string[];
  /** Convenience: chunked automatically with `chunkIntoSentences`. */
  text?: string;
}

export interface ArbiterPlayer {
  /** Play one chunk at the given volume; resolves when the chunk finishes. */
  playChunk(chunk: string, volume: number, rate: number): Promise<void>;
  /** Live volume change on the in-flight chunk (barge-in ducking). */
  setVolume(volume: number): void;
  /** Hard-cancel the in-flight chunk. Explicit stop only — never barge-in. */
  stopCurrent(): void;
}

export interface ArbiterState {
  playing: boolean;
  paused: boolean;
  ducked: boolean;
  operatorSpeaking: boolean;
  current: {
    id: string;
    tier: SpeechTier;
    /** Index of the chunk currently playing (or next to play). */
    chunkIndex: number;
    totalChunks: number;
  } | null;
  queued: Array<{ id: string; tier: SpeechTier }>;
}

export interface SpeechArbiter {
  attachPlayer(player: ArbiterPlayer, opts?: { getRate?: () => number }): void;
  hasPlayer(): boolean;
  /** Callback for synthesis/playback failures (e.g. to raise a toast). */
  setErrorHandler(fn: (err: unknown) => void): void;
  /** Returns 'queued' or 'dropped'. Tier 4 is dropped whenever it cannot
   *  play immediately (§4.1 rule 4) — never deferred indefinitely. */
  submit(input: SpeechIntentInput): 'queued' | 'dropped';
  /** §4.1 rule 1 — the operator's floor. Ducks in-flight audio; new intents
   *  wait; waiting chatter is dropped. Never touches capture. */
  setOperatorSpeaking(speaking: boolean): void;
  isOperatorSpeaking(): boolean;
  /** Stop at the current chunk boundary; resume continues from the next. */
  pause(): void;
  resume(): void;
  /** Explicit stop — the only hard-cancel. Clears queue and current chunk. */
  stopAll(): void;
  getState(): ArbiterState;
  subscribe(fn: () => void): () => void;
}

interface QueueEntry {
  intent: { id: string; tier: SpeechTier; chunks: string[] };
  /** Index of the next unplayed chunk. */
  nextChunk: number;
  seq: number;
}

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’']);

/**
 * Split speech into sentence-sized chunks (§4.1: chunked TTS makes speech
 * start early and makes pause/resume clean). Splits after `.` `!` `?` `…`
 * runs (plus closing quotes) when followed by whitespace or end of text —
 * so "3.5" never splits — and hard-splits any chunk longer than maxLen at
 * whitespace.
 */
export function chunkIntoSentences(text: string, maxLen = 280): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (!TERMINATORS.has(trimmed[i])) continue;
    let end = i + 1;
    while (end < trimmed.length && TERMINATORS.has(trimmed[end])) end++;
    while (end < trimmed.length && CLOSERS.has(trimmed[end])) end++;
    if (end >= trimmed.length || /\s/.test(trimmed[end])) {
      const piece = trimmed.slice(start, end).trim();
      if (piece) pieces.push(piece);
      start = end;
      i = end - 1;
    }
  }
  if (start < trimmed.length) {
    const tail = trimmed.slice(start).trim();
    if (tail) pieces.push(tail);
  }

  // Hard-split overlong pieces at whitespace so no chunk exceeds maxLen.
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= maxLen) {
      out.push(piece);
      continue;
    }
    let rest = piece;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(' ', maxLen);
      if (cut < Math.floor(maxLen / 2)) cut = maxLen; // no usable space
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

export function createSpeechArbiter(): SpeechArbiter {
  let player: ArbiterPlayer | null = null;
  let getRate: () => number = () => 1;
  let onError: (err: unknown) => void = () => {};

  let queue: QueueEntry[] = [];
  let current: QueueEntry | null = null;
  let playingChunk = false;
  let paused = false;
  let operatorSpeaking = false;
  let ducked = false;
  let seqCounter = 0;
  /** Bumped by stopAll so an in-flight chunk resolve is recognised as stale. */
  let generation = 0;
  let running = false;

  const listeners = new Set<() => void>();
  const notify = () => {
    listeners.forEach((fn) => fn());
  };

  function takeHighest(): QueueEntry | null {
    if (queue.length === 0) return null;
    queue.sort((a, b) => a.intent.tier - b.intent.tier || a.seq - b.seq);
    return queue.shift() as QueueEntry;
  }

  function peekHighestTier(): SpeechTier | null {
    if (queue.length === 0) return null;
    return queue.reduce((min, e) => (e.intent.tier < min ? e.intent.tier : min), 4 as SpeechTier);
  }

  async function drive(): Promise<void> {
    const gen = generation;
    try {
      while (gen === generation) {
        if (paused) break;

        if (!current) {
          const next = takeHighest();
          if (!next) break;
          if (operatorSpeaking) {
            // §4.1 rule 1 — nothing new starts over the operator. Put it
            // back and wait for the floor to be released.
            queue.push(next);
            break;
          }
          current = next;
        } else if (queue.length > 0 && !operatorSpeaking) {
          // Chunk boundary of an in-flight intent: a strictly higher tier
          // preempts here — never mid-chunk, so nothing resumes mid-word.
          // While the operator holds the floor there is no preemption: the
          // preempting intent is new speech too (§4.1 rule 1), so the ducked
          // intent keeps playing and the switch happens at a later boundary
          // once the floor is released.
          const waiting = peekHighestTier();
          if (waiting !== null && waiting < current.intent.tier) {
            const preempted = current;
            current = null;
            if (preempted.intent.tier !== TIER_CHATTER) {
              queue.push(preempted); // resumes from its next unplayed chunk
            } // chatter is dropped, not resumed (§4.1 rule 4)
            current = takeHighest();
          }
        }

        const entry = current as QueueEntry;
        if (entry.nextChunk >= entry.intent.chunks.length) {
          current = null;
          continue;
        }

        const chunk = entry.intent.chunks[entry.nextChunk];
        // Barge-in ducks at once (live) and per-chunk while the floor is
        // held; the restore is a chunk-boundary event (the next playChunk
        // call carries NORMAL_VOLUME again).
        const volume = operatorSpeaking ? DUCKED_VOLUME : NORMAL_VOLUME;
        ducked = operatorSpeaking;
        playingChunk = true;
        notify();
        try {
          await (player as ArbiterPlayer).playChunk(chunk, volume, getRate());
        } catch (err) {
          playingChunk = false;
          if (gen !== generation) return; // stopAll happened mid-chunk
          // Synthesis/playback failure: drop this intent, keep the queue
          // moving — one failed chunk must not mute everything after it.
          current = null;
          onError(err);
          recordSpeechEvent('playback_failed', {
            tier: entry.intent.tier,
            errorName: err instanceof Error ? err.name : typeof err === 'string' ? err : 'Unknown',
          });
          continue;
        }
        playingChunk = false;
        if (gen !== generation) return; // stopAll happened mid-chunk
        entry.nextChunk += 1;
        if (entry.nextChunk >= entry.intent.chunks.length) current = null;
        notify();
      }
    } finally {
      if (gen === generation) {
        running = false;
        notify();
      }
    }
  }

  function pump(): void {
    if (running) return;
    if (!player) return; // hold everything until a player is attached
    running = true;
    void drive();
  }

  const arbiter: SpeechArbiter = {
    attachPlayer(attached, opts) {
      if (running) arbiter.stopAll();
      player = attached;
      if (opts?.getRate) getRate = opts.getRate;
      pump();
    },
    hasPlayer() {
      return player !== null;
    },
    setErrorHandler(fn) {
      onError = fn;
    },
    submit(input) {
      const chunks = (
        input.chunks ?? (input.text !== undefined ? chunkIntoSentences(input.text) : [])
      )
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      const tier = input.tier;
      const validTier = tier === TIER_RECEIPT_ACK || tier === TIER_ANSWER || tier === TIER_CHATTER;
      if (!validTier || chunks.length === 0) {
        recordSpeechEvent('drop', { tier, reason: 'invalid' });
        return 'dropped';
      }
      if (tier === TIER_CHATTER) {
        // §4.1 rule 4 — chatter plays only from a completely idle arbiter.
        // Anything else means it would trail higher speech: drop it now.
        const busy =
          operatorSpeaking || paused || current !== null || queue.length > 0;
        if (busy) {
          recordSpeechEvent('drop', { tier, reason: 'busy' });
          notify();
          return 'dropped';
        }
      }
      const id = input.id ?? `intent-${seqCounter}`;
      queue.push({ intent: { id, tier, chunks }, nextChunk: 0, seq: seqCounter++ });
      recordSpeechEvent('submit', { tier });
      notify();
      pump();
      return 'queued';
    },
    setOperatorSpeaking(speaking) {
      if (operatorSpeaking === speaking) return;
      operatorSpeaking = speaking;
      if (speaking) {
        // Live-duck the in-flight chunk (never a hard stop) and discard
        // waiting chatter — the floor outranks it (§4.1 rule 4).
        if (playingChunk && player) {
          ducked = true;
          player.setVolume(DUCKED_VOLUME);
        }
        queue = queue.filter((e) => e.intent.tier !== TIER_CHATTER);
      }
      recordSpeechEvent(speaking ? 'floor_held' : 'floor_released');
      // On release we deliberately do NOT restore live: volume is restored
      // at the next chunk boundary, so the ducked chunk stays ducked.
      notify();
      if (!speaking) pump();
    },
    isOperatorSpeaking() {
      return operatorSpeaking;
    },
    pause() {
      // A global hold: the in-flight chunk finishes and the drive loop stops
      // at that boundary; submissions made while paused wait for resume.
      paused = true;
      recordSpeechEvent('paused');
      notify();
    },
    resume() {
      if (!paused) return;
      paused = false;
      recordSpeechEvent('resumed');
      notify();
      pump();
    },
    stopAll() {
      generation += 1;
      queue = [];
      current = null;
      playingChunk = false;
      paused = false;
      ducked = false;
      running = false;
      recordSpeechEvent('stopped');
      player?.stopCurrent();
      notify();
    },
    getState(): ArbiterState {
      return {
        playing: current !== null && !paused,
        paused,
        ducked,
        operatorSpeaking,
        current: current
          ? {
              id: current.intent.id,
              tier: current.intent.tier,
              chunkIndex: current.nextChunk,
              totalChunks: current.intent.chunks.length,
            }
          : null,
        queued: queue.map((e) => ({ id: e.intent.id, tier: e.intent.tier })),
      };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };

  return arbiter;
}

/** App-wide singleton. The TTS-backed player in useReadAloud attaches to it. */
export const speechArbiter: SpeechArbiter = createSpeechArbiter();

import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIStore } from '../store/uiStore';
import {
  speechArbiter,
  chunkIntoSentences,
  TIER_ANSWER,
  type ArbiterPlayer,
} from '../lib/speechArbiter';
import { spokenLedger } from '../lib/spokenLedger';

const API_URL = import.meta.env.VITE_API_URL || '';

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'paused';

/** Max decoded audio buffers kept warm. Two covers the one-ahead priming
 *  (the playing chunk plus the next); the oldest is evicted beyond that. */
const WARM_BUFFER_LIMIT = 3;
/** Wait before the single retry of a failed chunk synthesis. A transient
 *  upstream failure usually clears within a fraction of a second; the arbiter
 *  drops the WHOLE remaining intent when a chunk fails, so this pause is
 *  cheap insurance against the beginning of a read vanishing. */
const RETRY_BACKOFF_MS = 150;

// Module-level singleton: shared AudioContext so we can resume() it during a user gesture
let audioCtx: AudioContext | null = null;
// Speed toggle — persisted across messages until explicitly switched off
let playbackRate: number = 1.0;

const speedListeners = new Set<() => void>();

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * The arbiter's player: synthesises and plays ONE sentence chunk at a time
 * (§4.1 "Chunked TTS is what makes barge-in clean" — a chunk boundary is the
 * only scheduling point, so pause/resume never resume mid-word). Volume is
 * applied through a GainNode so barge-in can duck the live chunk.
 *
 * P21 — synthesis is ONE-AHEAD: while chunk N plays, chunk N+1 is already
 * being fetched and decoded, so a chunk boundary costs no synthesis round
 * trip (the operator heard this as pauses during longer reads — the drive
 * loop awaits playChunk, so without priming every boundary is silent for the
 * full TTS latency). A failed chunk is retried ONCE: the frozen arbiter
 * responds to a chunk error by dropping the whole remaining intent, so a
 * single failed fetch used to make the rest of a read — often starting with
 * its first words — silently vanish. The arbiter itself is untouched.
 */
class TtsChunkPlayer implements ArbiterPlayer {
  private voice: string | undefined;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private resolveCurrent: (() => void) | null = null;
  private abort: AbortController | null = null;
  /** The chunk list of the intent currently primed/playing, and how far it
   *  has advanced. Priming keyed on the sequence lets repeated chunk text
   *  ("Yes. Yes. Yes.") stay correct without text-only matching. */
  private primedChunks: string[] = [];
  private primedCursor = 0;
  /** In-flight/completed synthesis keyed by voice+text. */
  private warm = new Map<string, Promise<AudioBuffer>>();
  /** Abort controllers for prefetches (playChunk's own synthesis uses
   *  `abort`, the hard-cancel signal). */
  private prefetchAborts = new Set<AbortController>();

  setVoice(voice: string | undefined) {
    this.voice = voice;
  }

  /** Warms synthesis for a submitted intent. Called at submit time so the
   *  first chunk's synthesis starts immediately and the second starts while
   *  the first plays. One-ahead only: the rest of the text is NOT fetched
   *  upfront (§4.1 — speech starts after one synthesis, and an intent that
   *  never plays costs at most two bounded requests). */
  primeQueue(chunks: string[]) {
    this.primedChunks = [...chunks];
    this.primedCursor = 0;
    this.primeAt(0);
    this.primeAt(1);
  }

  private warmKey(text: string): string {
    return `${this.voice ?? ''}\u0000${text}`;
  }

  private fetchAndDecode(text: string, signal: AbortSignal): Promise<AudioBuffer> {
    return (async () => {
      const ctx = getAudioContext();
      const res = await fetch(`${API_URL}/api/tts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: this.voice }),
        signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error((body.error as string) ?? `HTTP ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('Empty audio response');
      }
      return ctx.decodeAudioData(arrayBuffer);
    })();
  }

  private primeAt(index: number) {
    const text = this.primedChunks[index];
    if (text === undefined) return;
    const key = this.warmKey(text);
    if (this.warm.has(key)) return;
    const controller = new AbortController();
    this.prefetchAborts.add(controller);
    const promise = this.fetchAndDecode(text, controller.signal);
    promise
      .catch(() => {}) // consumed (and retried) by playChunk; never unhandled
      .finally(() => this.prefetchAborts.delete(controller));
    this.warm.set(key, promise);
    while (this.warm.size > WARM_BUFFER_LIMIT) {
      const oldest = this.warm.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.warm.delete(oldest);
    }
  }

  async playChunk(chunk: string, volume: number, rate: number): Promise<void> {
    const ctx = getAudioContext();
    this.abort = new AbortController();

    // Advance the primed cursor onto THIS chunk (a repeated chunk text is
    // fine — the cursor, not text matching, tracks position). A chunk that
    // was never primed (an intent submitted without priming — the mechanical
    // acks — or after a preemption invalidated the sequence) synthesises
    // directly, exactly as before.
    if (this.primedChunks[this.primedCursor] === chunk) {
      this.primedCursor += 1;
      // The chunk now at the cursor is the NEXT one to play: keep it warm.
      this.primeAt(this.primedCursor);
    } else if (!this.warm.has(this.warmKey(chunk))) {
      this.primedChunks = [];
      this.primedCursor = 0;
    }

    const bufferPromise = this.warm.get(this.warmKey(chunk));
    this.warm.delete(this.warmKey(chunk));
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await (bufferPromise ?? this.fetchAndDecode(chunk, this.abort.signal));
    } catch (err) {
      if (this.abort.signal.aborted) throw err;
      // One retry: the arbiter drops the whole intent on a chunk error, so a
      // transient synthesis failure must be absorbed here. A backoff gives a
      // rate-limited upstream room to clear. (bufferPromise is deliberately
      // not reused — a warm promise that rejected once stays rejected.)
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      audioBuffer = await this.fetchAndDecode(chunk, this.abort.signal);
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(ctx.destination);

    this.source = source;
    this.gain = gain;
    return new Promise<void>((resolve) => {
      this.resolveCurrent = resolve;
      source.addEventListener(
        'ended',
        () => {
          if (this.source === source) {
            this.source = null;
            this.gain = null;
            this.resolveCurrent = null;
          }
          resolve();
        },
        { once: true }
      );
      source.start(0);
    });
  }

  /** Live volume change on the in-flight chunk (barge-in ducking). */
  setVolume(volume: number) {
    if (this.gain) {
      this.gain.gain.value = volume;
    }
  }

  /** Live playback-rate change on the in-flight chunk (speed toggle). */
  setRate(rate: number) {
    if (this.source) {
      this.source.playbackRate.value = rate;
    }
  }

  /** Hard-cancel. Explicit stop only — never barge-in (that ducks). */
  stopCurrent() {
    this.abort?.abort();
    for (const controller of this.prefetchAborts) controller.abort();
    this.prefetchAborts.clear();
    this.warm.clear();
    this.primedChunks = [];
    this.primedCursor = 0;
    // Capture locals first: stop() may fire 'ended' (async per spec, but not
    // guaranteed synchronous-ordering-safe), and the ended handler nulls
    // these fields.
    const source = this.source;
    const gain = this.gain;
    this.source = null;
    this.gain = null;
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
      source.disconnect();
    }
    gain?.disconnect();
    this.resolveCurrent?.();
    this.resolveCurrent = null;
  }
}

const ttsPlayer = new TtsChunkPlayer();

// The app-wide arbiter speaks through this player. Attaching at module load
// is side-effect-free: no AudioContext exists until the first chunk plays.
speechArbiter.attachPlayer(ttsPlayer, { getRate: () => playbackRate });

speechArbiter.setErrorHandler((err: unknown) => {
  // One failed chunk drops its intent but keeps the queue moving; surface
  // the failure the way the pre-arbiter hook did.
  const msg = (err as Error).message || '';
  if (
    msg.includes('NotAllowed') ||
    msg.includes('AudioContext') ||
    msg.includes('play()') ||
    msg.includes('user gesture')
  ) {
    useUIStore.getState().addToast({
      type: 'error',
      message: 'Unable to play audio. Try tapping the button again.',
    });
  } else {
    useUIStore.getState().addToast({
      type: 'error',
      message: err instanceof Error ? err.message : 'Failed to generate audio',
    });
  }
});

/** Explicit stop of everything the arbiter is doing (queue + current chunk). */
export function stopCurrentAudio() {
  speechArbiter.stopAll();
}

/** P21 — prime one-ahead synthesis for an intent BEFORE it is submitted, so
 *  the first chunk's synthesis starts at submit (not at first play) and the
 *  second chunk is warm before the first finishes. The reading path (P17–P19)
 *  calls this with the same chunking the arbiter will apply, so a chunk
 *  boundary never waits on a synthesis round trip. */
export function primePlaybackQueue(chunks: string[], voice?: string) {
  if (voice !== undefined) ttsPlayer.setVoice(voice);
  ttsPlayer.primeQueue(chunks);
}

/**
 * @param messageId the arbiter intent id for this surface ('drive-mode', or
 *        'drive-mode-<sessionId>' for a lane).
 * @param ledgerScope the scope this playback records its words under. Multi-lane
 *        passes the LANE's scope so that one lane's explicit playback and its
 *        auto-speak still share one record (never said twice), while another
 *        lane saying the same words is a different event and still speaks.
 *        Absent = the shared content scope.
 */
export function useReadAloud(messageId: string, ledgerScope?: string) {
  const [state, setState] = useState<ReadAloudState>('idle');
  const [speedEnabled, setSpeedEnabled] = useState(playbackRate > 1.0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Mirror arbiter state into this instance's hook state. Only the instance
  // whose message is the arbiter's current intent shows playing/paused; one
  // with a pending intent shows loading; everything else is idle.
  useEffect(() => {
    const sync = () => {
      const st = speechArbiter.getState();
      if (st.current && st.current.id === messageId) {
        setState(st.paused ? 'paused' : 'playing');
      } else if (st.queued.some((q) => q.id === messageId)) {
        setState('loading');
      } else if (stateRef.current !== 'idle') {
        setState('idle');
      }
    };
    sync();
    const unsubscribe = speechArbiter.subscribe(sync);

    const syncSpeed = () => {
      setSpeedEnabled(playbackRate > 1.0);
    };
    speedListeners.add(syncSpeed);

    return () => {
      unsubscribe();
      speedListeners.delete(syncSpeed);
    };
  }, [messageId]);

  const toggleSpeed = useCallback(() => {
    playbackRate = playbackRate > 1.0 ? 1.0 : 1.25;
    ttsPlayer.setRate(playbackRate);
    setSpeedEnabled(playbackRate > 1.0);
    speedListeners.forEach((fn) => fn());
  }, []);

  const play = useCallback(
    (text: string, voice?: string) => {
      const st = speechArbiter.getState();

      // Tap again on the playing message = stop (existing toggle behaviour).
      if (st.current && st.current.id === messageId) {
        speechArbiter.stopAll();
        return;
      }
      // Replacing peer answer playback preserves the pre-arbiter UX of
      // tapping read-aloud on another message. A tier-2 receipt ack is never
      // stopped — it outranks this playback and this intent queues behind it.
      if (st.current && st.current.tier === TIER_ANSWER) {
        speechArbiter.stopAll();
      }

      const chunks = chunkIntoSentences(text);
      if (chunks.length === 0) {
        return;
      }

      ttsPlayer.setVoice(voice);
      // Prime synthesis immediately: the first chunk starts fetching now
      // (inside the user gesture — this also anchors the AudioContext resume
      // before playback) and the second chunk is warm while the first plays.
      ttsPlayer.primeQueue(chunks);

      // CRITICAL: Resume the AudioContext synchronously during the user gesture.
      // iOS Safari puts AudioContext in "suspended" state until a user gesture
      // calls resume(). Once resumed, we can schedule playback at any time.
      const ctx = getAudioContext();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          // Browser may still block (e.g., no prior interaction).
          // We'll show an error after the fetch completes if playback fails.
        });
      }

      // Explicit operator action: always play what was asked for, even if the
      // talker (or an earlier read-aloud) already said these words. Mark the
      // text as spoken FIRST so no auto producer can repeat it (P16) — the
      // explicit path updates the shared record, it is never refused by it.
      spokenLedger.mark(text, ledgerScope);
      speechArbiter.submit({ id: messageId, tier: TIER_ANSWER, chunks });
    },
    [messageId, ledgerScope]
  );

  const stop = useCallback(() => {
    speechArbiter.stopAll();
  }, []);

  /** Stop at the current chunk boundary; resume continues from the next. */
  const pause = useCallback(() => {
    speechArbiter.pause();
  }, []);

  const resume = useCallback(() => {
    speechArbiter.resume();
  }, []);

  return { state, play, stop, pause, resume, speedEnabled, toggleSpeed };
}

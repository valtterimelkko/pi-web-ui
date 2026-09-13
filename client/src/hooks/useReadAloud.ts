import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIStore } from '../store/uiStore';
import {
  speechArbiter,
  chunkIntoSentences,
  TIER_ANSWER,
  type ArbiterPlayer,
} from '../lib/speechArbiter';

const API_URL = import.meta.env.VITE_API_URL || '';

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'paused';

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
 */
class TtsChunkPlayer implements ArbiterPlayer {
  private voice: string | undefined;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private resolveCurrent: (() => void) | null = null;
  private abort: AbortController | null = null;

  setVoice(voice: string | undefined) {
    this.voice = voice;
  }

  async playChunk(chunk: string, volume: number, rate: number): Promise<void> {
    const ctx = getAudioContext();
    this.abort = new AbortController();
    const res = await fetch(`${API_URL}/api/tts`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, voice: this.voice }),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error((body.error as string) ?? `HTTP ${res.status}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('Empty audio response');
    }
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

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

export function useReadAloud(messageId: string) {
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

      speechArbiter.submit({ id: messageId, tier: TIER_ANSWER, chunks });
    },
    [messageId]
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

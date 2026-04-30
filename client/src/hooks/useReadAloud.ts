import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIStore } from '../store/uiStore';

const API_URL = import.meta.env.VITE_API_URL || '';

type ReadAloudState = 'idle' | 'loading' | 'playing';

// Module-level singleton: shared AudioContext so we can resume() it during a user gesture
let audioCtx: AudioContext | null = null;
// Track the currently playing source node so we can stop it
let currentSource: AudioBufferSourceNode | null = null;
let currentBuffer: AudioBuffer | null = null;
// Speed toggle — persisted across messages until explicitly toggled off
let playbackRate: number = 1.0;

const listeners = new Set<() => void>();
const speedListeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

export function stopCurrentAudio() {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // Already stopped
    }
    currentSource.disconnect();
    currentSource = null;
  }
  currentBuffer = null;
  notifyListeners();
}

export function useReadAloud(messageId: string) {
  const [state, setState] = useState<ReadAloudState>('idle');
  const [speedEnabled, setSpeedEnabled] = useState(playbackRate > 1.0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Sync local state with global audio state
  useEffect(() => {
    const sync = () => {
      if (!currentSource) {
        if (stateRef.current === 'playing') {
          setState('idle');
        }
      }
    };
    listeners.add(sync);

    // Also sync speed state across instances
    const syncSpeed = () => {
      setSpeedEnabled(playbackRate > 1.0);
    };
    speedListeners.add(syncSpeed);

    return () => {
      listeners.delete(sync);
      speedListeners.delete(syncSpeed);
    };
  }, []);

  const toggleSpeed = useCallback(() => {
    playbackRate = playbackRate > 1.0 ? 1.0 : 1.25;
    // Apply to currently playing source immediately
    if (currentSource) {
      currentSource.playbackRate.value = playbackRate;
    }
    setSpeedEnabled(playbackRate > 1.0);
    speedListeners.forEach((fn) => fn());
  }, []);

  const play = useCallback(
    (text: string, voice?: string) => {
      if (stateRef.current === 'playing') {
        stopCurrentAudio();
        setState('idle');
        return;
      }

      // Stop any currently playing audio
      stopCurrentAudio();

      setState('loading');

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

      fetch(`${API_URL}/api/tts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), voice }),
      })
        .then((res) => {
          if (!res.ok) {
            return res.json().then((body) => {
              throw new Error((body.error as string) ?? `HTTP ${res.status}`);
            });
          }
          return res.arrayBuffer();
        })
        .then((arrayBuffer) => {
          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            throw new Error('Empty audio response');
          }

          // Decode the MP3 data into an AudioBuffer
          return ctx.decodeAudioData(arrayBuffer).then((audioBuffer) => {
            currentBuffer = audioBuffer;

            // Create a source node and connect it
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.playbackRate.value = playbackRate;
            source.connect(ctx.destination);

            source.addEventListener(
              'ended',
              () => {
                currentSource = null;
                currentBuffer = null;
                setState('idle');
                notifyListeners();
              },
              { once: true }
            );

            currentSource = source;

            // Start playback — this works because the AudioContext was resumed
            // during the user gesture
            source.start(0);
            setState('playing');
          });
        })
        .catch((err: unknown) => {
          if ((err as Error).name === 'AbortError') {
            setState('idle');
            return;
          }
          stopCurrentAudio();
          // Check if the error is from the AudioContext not being allowed
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
          setState('idle');
        });
    },
    [messageId]
  );

  const stop = useCallback(() => {
    if (stateRef.current !== 'idle') {
      stopCurrentAudio();
      setState('idle');
    }
  }, []);

  return { state, play, stop, speedEnabled, toggleSpeed };
}

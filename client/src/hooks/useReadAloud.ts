import { useState, useRef, useCallback, useEffect } from 'react';
import { useUIStore } from '../store/uiStore';

const API_URL = import.meta.env.VITE_API_URL || '';

type ReadAloudState = 'idle' | 'loading' | 'playing';

// Module-level singleton to ensure only one audio plays globally
let globalAudio: HTMLAudioElement | null = null;

const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

function stopGlobalAudio() {
  if (globalAudio) {
    globalAudio.pause();
    globalAudio.src = '';
    globalAudio = null;
  }
  notifyListeners();
}

export function useReadAloud(messageId: string) {
  const [state, setState] = useState<ReadAloudState>('idle');
  const stateRef = useRef(state);
  stateRef.current = state;

  // Sync local state with global audio state
  useEffect(() => {
    const sync = () => {
      if (!globalAudio || !globalAudio.src) {
        // Only reset to idle if we are in 'playing' state, not 'loading'
        if (stateRef.current === 'playing') {
          setState('idle');
        }
      }
    };
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const play = useCallback(
    (text: string, voice?: string) => {
      if (stateRef.current === 'playing') {
        stopGlobalAudio();
        setState('idle');
        return;
      }

      // Stop any other playing audio before starting new one
      if (globalAudio) {
        stopGlobalAudio();
      }

      setState('loading');

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
          return res.blob();
        })
        .then((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob as Blob);
          const audio = new Audio(url);
          globalAudio = audio;

          audio.addEventListener(
            'ended',
            () => {
              URL.revokeObjectURL(url);
              if (globalAudio === audio) globalAudio = null;
              setState('idle');
              notifyListeners();
            },
            { once: true }
          );

          audio.addEventListener(
            'error',
            () => {
              URL.revokeObjectURL(url);
              if (globalAudio === audio) globalAudio = null;
              setState('idle');
              notifyListeners();
            },
            { once: true }
          );

          return audio.play().then(() => {
            setState('playing');
          }).catch((err: unknown) => {
            setState('idle');
          });
        })
        .catch((err: unknown) => {
          if ((err as Error).name === 'AbortError') {
            setState('idle');
            return;
          }
          useUIStore
            .getState()
            .addToast({
              type: 'error',
              message: err instanceof Error ? err.message : 'Failed to play audio',
            });
          setState('idle');
        });
    },
    [messageId]
  );

  const stop = useCallback(() => {
    if (stateRef.current !== 'idle') {
      stopGlobalAudio();
      setState('idle');
    }
  }, []);

  return { state, play, stop };
}

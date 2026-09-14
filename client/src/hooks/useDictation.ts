import { useState, useRef, useCallback, useEffect } from 'react';
import { reportClientError } from '../lib/clientDiagnosticsReporter.js';

type DictationState = 'idle' | 'recording' | 'processing' | 'error';

const CHUNK_INTERVAL_MS = 1000;

const API_URL = import.meta.env.VITE_API_URL || '';

function getMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
}

async function apiPost(path: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Optional voice-surface correlation attached to dictation error reports
 *  (P13): the same worker-session key the server's VoiceMode records carry. */
export interface DictationErrorContext {
  runtime?: string;
  workerSessionId?: string;
}

export function useDictation(onTranscript: (text: string) => void, errorContext?: DictationErrorContext) {
  const [state, setState] = useState<DictationState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingChunksRef = useRef<Promise<void>>(Promise.resolve());
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const errorContextRef = useRef<DictationErrorContext | undefined>(errorContext);
  errorContextRef.current = errorContext;

  /** P13: dictation failures (mic, STT pipeline) are voice-surface errors
   *  invisible to every server-side query today. Report bounded, scrubbed,
   *  correlated — never altering the hook's own behaviour. */
  const reportDictationError = useCallback((message: string) => {
    const ctx = errorContextRef.current;
    void reportClientError({
      operation: 'dictation_error',
      message,
      ...(ctx?.runtime ? { runtime: ctx.runtime } : {}),
      ...(ctx?.workerSessionId ? { workerSessionId: ctx.workerSessionId } : {}),
    });
  }, []);

  useEffect(() => {
    apiPost('/api/dictation/warmup').catch(() => {});
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMessage('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Microphone not supported in this browser.');
      setState('error');
      reportDictationError('Microphone not supported in this browser.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let reason: string;
      if (msg.includes('Permission') || msg.includes('NotAllowed') || msg.includes('denied')) {
        reason = 'Microphone permission denied.';
      } else if (msg.includes('NotFound') || msg.includes('Requested device not found')) {
        reason = 'No microphone found.';
      } else {
        reason = `Microphone error: ${msg}`;
      }
      setErrorMessage(reason);
      setState('error');
      reportDictationError(reason);
      return;
    }

    streamRef.current = stream;

    let id: string;
    try {
      const result = await apiPost('/api/dictation/start') as { id: string };
      id = result.id;
    } catch (err: unknown) {
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      const msg = err instanceof Error ? err.message : 'Failed to start recording';
      setErrorMessage(msg);
      setState('error');
      reportDictationError(msg);
      return;
    }

    recordingIdRef.current = id;
    pendingChunksRef.current = Promise.resolve();

    const mimeType = getMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && recordingIdRef.current) {
        const currentId = recordingIdRef.current;
        pendingChunksRef.current = pendingChunksRef.current.then(async () => {
          const buf = await e.data.arrayBuffer();
          await fetch(`${API_URL}/api/dictation/${currentId}/stream`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf,
          }).catch(console.warn);
        });
      }
    };

    recorder.start(CHUNK_INTERVAL_MS);
    setState('recording');
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    const id = recordingIdRef.current;
    if (!recorder || !id) return;

    setState('processing');

    await new Promise<void>(resolve => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    await pendingChunksRef.current;

    mediaRecorderRef.current = null;
    recordingIdRef.current = null;

    try {
      const result = await apiPost(`/api/dictation/${id}/finish`) as { text: string; duration_ms: number };
      onTranscriptRef.current(result.text);
      setState('idle');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to process recording';
      setErrorMessage(msg);
      setState('error');
      reportDictationError(msg);
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'idle' || state === 'error') {
      void startRecording();
    } else if (state === 'recording') {
      void stopRecording();
    }
  }, [state, startRecording, stopRecording]);

  return { state, errorMessage, toggle, startRecording, stopRecording };
}

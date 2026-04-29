import { useState, useRef, useCallback, useEffect } from 'react';

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

export function useDictation(onTranscript: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingChunksRef = useRef<Promise<void>>(Promise.resolve());
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    apiPost('/api/dictation/warmup').catch(() => {});
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMessage('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Microphone not supported in this browser.');
      setState('error');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Permission') || msg.includes('NotAllowed') || msg.includes('denied')) {
        setErrorMessage('Microphone permission denied.');
      } else if (msg.includes('NotFound') || msg.includes('Requested device not found')) {
        setErrorMessage('No microphone found.');
      } else {
        setErrorMessage(`Microphone error: ${msg}`);
      }
      setState('error');
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
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start recording');
      setState('error');
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
      setErrorMessage(err instanceof Error ? err.message : 'Failed to process recording');
      setState('error');
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'idle' || state === 'error') {
      void startRecording();
    } else if (state === 'recording') {
      void stopRecording();
    }
  }, [state, startRecording, stopRecording]);

  return { state, errorMessage, toggle };
}

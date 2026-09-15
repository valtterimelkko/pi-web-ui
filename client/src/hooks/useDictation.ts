import { useState, useRef, useCallback, useEffect } from 'react';
import { reportClientError } from '../lib/clientDiagnosticsReporter.js';

type DictationState = 'idle' | 'starting' | 'recording' | 'processing' | 'error';

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

/**
 * The microphone is a SINGLE-OWNER resource (Child V, 2026-09-15).
 *
 * A two-tab browser reproduction proved the earlier reference-per-field design
 * could leak a hot microphone past the app's own knowledge:
 *   - a second activation landing while the device was still being acquired
 *     (second tab, cold device, permission prompt) started a SECOND
 *     MediaRecorder and overwrote the refs, so one tap to stop released only
 *     one of them — the app read "Start recording" while a recorder was still
 *     recording and the microphone track was still live;
 *   - unmounting the surface while recording (Exit Voice Mode) left the
 *     recorder and the track running with no control left in the app.
 *
 * The fix is one owned capture object, a lock over the acquisition window, and
 * a teardown that runs on unmount. Nothing here changes what is sent where:
 * the transcript path, the verbatim relay and the confirm gate are untouched.
 */
interface Capture {
  recordingId: string | null;
  stream: MediaStream;
  recorder: MediaRecorder;
}

function stopTracks(stream: MediaStream): void {
  try {
    stream.getTracks().forEach(t => t.stop());
  } catch {
    /* the stream is already gone; nothing to release */
  }
}

export function useDictation(onTranscript: (text: string) => void, errorContext?: DictationErrorContext) {
  const [state, setState] = useState<DictationState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  /** The one capture this hook owns, if any. */
  const captureRef = useRef<Capture | null>(null);
  /** Acquisition lock: held from the tap until a capture exists or the attempt
   *  has failed, so a tap inside that window cannot open a second lane. */
  const startingRef = useRef(false);
  /** True once the surface has gone away: an acquisition in flight must not
   *  leave a live stream behind. Reset on mount so React StrictMode's
   *  mount/unmount/mount cycle cannot latch it. */
  const disposedRef = useRef(false);
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

  /** Best-effort: tell the server to drop an in-flight recording's buffered
   *  audio. Never transcription, and never surfaces are sent. */
  const abandonServerRecording = useCallback((recordingId: string) => {
    void fetch(`${API_URL}/api/dictation/${recordingId}/abort`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    }).catch(() => {
      /* the recording is abandoned locally either way; the server entry is
         bounded and in-memory only */
    });
  }, []);

  /** Release whatever this hook owns: stop the recorder, stop the microphone
   *  tracks, and abandon the server-side recording. Idempotent. */
  const releaseCapture = useCallback(
    (opts: { abandon: boolean }) => {
      const capture = captureRef.current;
      captureRef.current = null;
      startingRef.current = false;
      if (!capture) return;
      try {
        if (capture.recorder.state !== 'inactive') capture.recorder.stop();
      } catch {
        /* already stopped */
      }
      stopTracks(capture.stream);
      if (opts.abandon && capture.recordingId) abandonServerRecording(capture.recordingId);
    },
    [abandonServerRecording]
  );

  useEffect(() => {
    apiPost('/api/dictation/warmup').catch(() => {});
  }, []);

  // The surface owns the microphone for exactly as long as it is mounted.
  // React StrictMode runs this cleanup once on mount, which is harmless: with
  // no capture there is nothing to release.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      releaseCapture({ abandon: true });
    };
  }, [releaseCapture]);

  const startRecording = useCallback(async () => {
    // Single owner: an acquisition already in flight, or a live capture, is not
    // replaced. A second tap here is absorbed, never a second lane.
    if (startingRef.current || captureRef.current) return;

    startingRef.current = true;
    setErrorMessage('');
    setState('starting');

    if (!navigator.mediaDevices?.getUserMedia) {
      startingRef.current = false;
      setErrorMessage('Microphone not supported in this browser.');
      setState('error');
      reportDictationError('Microphone not supported in this browser.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err: unknown) {
      startingRef.current = false;
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

    // The surface went away while the device was being acquired: release it
    // immediately rather than leaving a live track the app cannot reach.
    if (disposedRef.current) {
      startingRef.current = false;
      stopTracks(stream);
      return;
    }

    let id: string;
    try {
      const result = await apiPost('/api/dictation/start') as { id: string };
      id = result.id;
    } catch (err: unknown) {
      startingRef.current = false;
      stopTracks(stream);
      const msg = err instanceof Error ? err.message : 'Failed to start recording';
      setErrorMessage(msg);
      setState('error');
      reportDictationError(msg);
      return;
    }

    if (disposedRef.current) {
      startingRef.current = false;
      stopTracks(stream);
      abandonServerRecording(id);
      return;
    }

    const mimeType = getMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const capture: Capture = { recordingId: id, stream, recorder };
    captureRef.current = capture;
    pendingChunksRef.current = Promise.resolve();

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      // Only the current owner streams: a lane that has been released (or
      // replaced) can never feed a recording session it no longer holds.
      if (captureRef.current !== capture) return;
      pendingChunksRef.current = pendingChunksRef.current.then(async () => {
        if (captureRef.current !== capture) return;
        const buf = await e.data.arrayBuffer();
        await fetch(`${API_URL}/api/dictation/${id}/stream`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        }).catch(console.warn);
      });
    };

    recorder.start(CHUNK_INTERVAL_MS);
    startingRef.current = false;
    setState('recording');
  }, [abandonServerRecording, reportDictationError]);

  const stopRecording = useCallback(async () => {
    const capture = captureRef.current;
    if (!capture) return; // nothing owned: a stop with no lane is a no-op

    // Take ownership out of the ref BEFORE awaiting, so a concurrent stop (or a
    // release) can never drive the same recorder twice.
    captureRef.current = null;
    startingRef.current = false;
    setState('processing');

    await new Promise<void>(resolve => {
      if (capture.recorder.state === 'inactive') {
        resolve();
        return;
      }
      capture.recorder.addEventListener('stop', () => resolve(), { once: true });
      capture.recorder.stop();
    });

    stopTracks(capture.stream);
    await pendingChunksRef.current;

    if (!capture.recordingId) {
      setState('idle');
      return;
    }

    try {
      const result = await apiPost(`/api/dictation/${capture.recordingId}/finish`) as { text: string; duration_ms: number };
      onTranscriptRef.current(result.text);
      setState('idle');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to process recording';
      setErrorMessage(msg);
      setState('error');
      reportDictationError(msg);
    }
  }, [reportDictationError]);

  const toggle = useCallback(() => {
    if (state === 'idle' || state === 'error') {
      void startRecording();
    } else if (state === 'recording') {
      void stopRecording();
    }
    // 'starting' and 'processing' absorb the tap: there is exactly one lane,
    // and it is already transitioning.
  }, [state, startRecording, stopRecording]);

  return { state, errorMessage, toggle, startRecording, stopRecording };
}

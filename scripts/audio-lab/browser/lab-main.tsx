/**
 * Audio lab — real product player lane.
 *
 * This page mounts the REAL product read-aloud stack: `useReadAloud` (the
 * actual `TtsChunkPlayer` with one-ahead priming, retry and gain) attached to
 * the REAL app-wide `speechArbiter`. Nothing about the scheduling, ducking,
 * chunking or playback graph is reimplemented here — the lab drives the
 * product's own code and measures the operating system's output.
 *
 * It exists because the authenticated full-app lane cannot be made
 * deterministic: the words a model chooses to say are not known in advance.
 * Here the lab supplies the text, so a scenario can name the exact chunk whose
 * head was eaten. The full-app lane (separate, real login, real /api/tts) is
 * retained for end-to-end proof; this lane is where the scenario matrix runs.
 *
 * The page is served from the lab's own static server and `/api/tts` is
 * fulfilled by Playwright with cached fixture MP3 bytes, so no credentials and
 * no network are needed for a routine run.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  chunkIntoSentences,
  speechArbiter,
  TIER_ANSWER,
  type ArbiterState,
} from '../../../client/src/lib/speechArbiter.js';
import { useReadAloud, primePlaybackQueue } from '../../../client/src/hooks/useReadAloud.js';
import { getRecentBrowserEvents } from '../../../client/src/lib/browserDiagnostics.js';

interface LabEvent {
  seq: number;
  t: number;
  event: string;
  detail?: Record<string, unknown>;
}

const events: LabEvent[] = [];
let seq = 0;
let micRecorder: MediaRecorder | null = null;
let micChunks: Blob[] = [];
let micBytes = 0;

function record(event: string, detail?: Record<string, unknown>): void {
  events.push({ seq: seq++, t: Math.round(performance.now() * 1000) / 1000, event, ...(detail ? { detail } : {}) });
  if (events.length > 5000) events.splice(0, events.length - 5000);
  const el = document.getElementById('events');
  if (el) el.textContent = JSON.stringify(events.slice(-8), null, 1);
}

interface Controls {
  readAloud(text: string, options?: { voice?: string; prime?: boolean }): Record<string, unknown>;
  stop(): void;
  pause(): void;
  resume(): void;
  duck(on: boolean): void;
  speed(on: boolean): void;
  chunk(text: string): string[];
  arbiterState(): ArbiterState;
  events(): LabEvent[];
  contextState(): { state: string; sampleRate: number };
  /** The PRODUCT's own speech diagnostics (browserDiagnostics ring). Not a lab
   *  invention: it is the same record a maintainer reads from the manual
   *  diagnostics bundle when answering "why didn't I hear it?". */
  productTelemetry(): Array<Record<string, unknown>>;
  /**
   * Open the microphone through the browser's REAL capture machinery
   * (getUserMedia -> MediaRecorder). Chrome is launched with a synthetic audio
   * capture device in this lane, so the stimulus is SYNTHETIC — the report says
   * so explicitly; it is not microphone-hardware proof. What it does prove is
   * that opening capture does not disturb playback or the audio graph.
   */
  openMic(): Promise<{ ok: boolean; error?: string; track: Record<string, unknown> }>;
  closeMic(): Promise<{ ok: boolean; bytes: number; chunks: number }>;
  micState(): { open: boolean; bytes: number; chunks: number };
  /** Render nothing at all: the negative control for the whole lane. */
  idle(): void;
}

function LabApp(): JSX.Element {
  const { play, stop, pause, resume, speedEnabled, toggleSpeed } = useReadAloud('lab-message');
  const [text, setText] = useState('');
  const speedRef = useRef(speedEnabled);
  speedRef.current = speedEnabled;

  const readAloud = useCallback(
    (input: string, options?: { voice?: string; prime?: boolean }) => {
      const chunks = chunkIntoSentences(input);
      // Record the intent BEFORE submitting, so the event log describes what
      // was asked for even if playback never starts (the failure the lab is
      // looking for).
      record('intent', { text: input, chunks, chunksCount: chunks.length });
      if (options?.prime !== false) primePlaybackQueue(chunks, options?.voice);
      const before = performance.now();
      play(input, options?.voice);
      record('submitted', { latencyMs: Math.round((performance.now() - before) * 1000) / 1000 });
      return { chunks, arbiter: speechArbiter.getState() };
    },
    [play]
  );

  useEffect(() => {
    const unsubscribe = speechArbiter.subscribe(() => {
      const snapshot = speechArbiter.getState();
      record('arbiter', {
        playing: snapshot.playing,
        paused: snapshot.paused,
        ducked: snapshot.ducked,
        operatorSpeaking: snapshot.operatorSpeaking,
        chunkIndex: snapshot.current?.chunkIndex ?? null,
        totalChunks: snapshot.current?.totalChunks ?? null,
        queued: snapshot.queued.length,
      });
    });
    return unsubscribe;
  }, []);

  const api: Controls = {
    readAloud,
    stop: () => {
      record('control', { control: 'stop' });
      stop();
    },
    pause: () => {
      record('control', { control: 'pause' });
      pause();
    },
    resume: () => {
      record('control', { control: 'resume' });
      resume();
    },
    duck: (on: boolean) => {
      record('control', { control: 'duck', on });
      speechArbiter.setOperatorSpeaking(on);
    },
    speed: (on: boolean) => {
      record('control', { control: 'speed', on });
      if (speedRef.current !== on) toggleSpeed();
    },
    chunk: (input: string) => chunkIntoSentences(input),
    arbiterState: () => speechArbiter.getState(),
    events: () => events.slice(),
    contextState: () => {
      // The product player owns the shared AudioContext; read it through a
      // probe so the report can state the real device rate.
      const ctx = (window as unknown as { __labContextProbe?: AudioContext }).__labContextProbe;
      return ctx ? { state: ctx.state, sampleRate: ctx.sampleRate } : { state: 'unknown', sampleRate: 0 };
    },
    productTelemetry: () =>
      getRecentBrowserEvents(400).filter((event) => event.kind === 'speech').map((event) => ({ ...event })),

    openMic: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        const settings = (track.getSettings?.() ?? {}) as Record<string, unknown>;
        micRecorder = new MediaRecorder(stream);
        micChunks = [];
        micBytes = 0;
        micRecorder.ondataavailable = (event) => {
          micChunks.push(event.data);
          micBytes += event.data.size;
        };
        micRecorder.start(250);
        record('mic_open', { settings });
        return { ok: true, track: settings as Record<string, unknown> };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record('mic_open_failed', { error: message });
        return { ok: false, error: message, track: {} };
      }
    },
    closeMic: async () => {
      if (!micRecorder) return { ok: true, bytes: micBytes, chunks: micChunks.length };
      const recorder = micRecorder;
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
      recorder.stream.getTracks().forEach((track) => track.stop());
      micRecorder = null;
      record('mic_close', { bytes: micBytes, chunks: micChunks.length });
      return { ok: true, bytes: micBytes, chunks: micChunks.length };
    },
    micState: () => ({ open: micRecorder !== null, bytes: micBytes, chunks: micChunks.length }),
    idle: () => record('rendered_nothing', {}),
  };

  (window as unknown as { __labProduct: Controls }).__labProduct = api;
  (window as unknown as { __labProductText: string }).__labProductText = text;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem', maxWidth: 900 }}>
      <h1>Audio lab — real product player lane</h1>
      <p>
        Real <code>useReadAloud</code> + real <code>speechArbiter</code>. Fixture audio is served by
        the lab harness. Autoplay is <strong>not</strong> relaxed: arm audio with a real click first.
      </p>
      <p>
        <button
          id="arm"
          onClick={() => {
            // Mirror the product's gesture-anchored resume: the real player's
            // play() resumes the shared context, and a probe context records
            // the device rate for the report.
            const probe = new AudioContext();
            (window as unknown as { __labContextProbe?: AudioContext }).__labContextProbe = probe;
            void probe.resume().then(() => record('armed', { state: probe.state, rate: probe.sampleRate }));          }}
        >
          Arm audio (user gesture)
        </button>
      </p>
      <p>
        <input
          id="text"
          aria-label="text"
          style={{ width: '100%' }}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Chunk text for the lab to read"
        />
      </p>
      <p>
        <button id="read" onClick={() => readAloud(text)}>
          Read aloud
        </button>{' '}
        <button id="stop" onClick={() => stop()}>
          Stop
        </button>{' '}
        <button id="pause" onClick={() => pause()}>
          Pause
        </button>{' '}
        <button id="resume" onClick={() => resume()}>
          Resume
        </button>{' '}
        <button id="speed" onClick={() => toggleSpeed()}>
          Speed {speedEnabled ? '1.25' : '1.0'}
        </button>{' '}
        <button id="idle" onClick={() => record('rendered_nothing', {})}>
          Render nothing
        </button>
      </p>
      <pre id="events" style={{ background: '#f6f6f6', padding: '0.75rem', overflowX: 'auto' }} />
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('lab page is missing its root element');
createRoot(container).render(<LabApp />);
record('page_loaded', {});

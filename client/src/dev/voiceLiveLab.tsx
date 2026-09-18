/**
 * Voice Mode ducking lab (Track C) — the Playwright evidence surface.
 *
 * It is a LAB ENTRYPOINT, not product code: its job is to run the real product
 * modules in a real browser so ducking can be measured on rendered audio rather
 * than asserted against a mock.
 *
 * What is real here:
 *   - `createWebAudioPlaybackBackend` + `PlaybackPipeline`: the production 24 kHz
 *     scheduler, feeding a real `GainNode` chain. An `AnalyserNode` sits after
 *     the master gain, so the numbers the spec records are rendered amplitude.
 *   - `VoiceLiveSurface.startCapture()`: the production path — `getUserMedia` →
 *     `MediaStreamAudioSourceNode` → the capture AudioWorklet → VAD → the
 *     arbiter's floor and `voice_activity_state`.
 *   - `DriveModeVoiceLive`, `ProposalCard`, `ParkingLotDrawer`: the real React
 *     components, bound to the same surface.
 *
 * What is substituted: the operating system's microphone. A virtual microphone
 * (a `MediaStreamDestination` fed by a gain-controlled oscillator) is returned
 * from `navigator.mediaDevices.getUserMedia`, and the spec turns its level up to
 * mean "the operator is speaking". Everything downstream of `getUserMedia` is
 * untouched product code.
 */

import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import {
  VOICE_AUDIO_OUTPUT_MIME,
  VOICE_WIRE_VERSION,
  type VoiceClientMessage,
  type VoiceServerMessage,
} from '@pi-web-ui/shared';
import { createSpeechArbiter } from '../lib/speechArbiter';
import { VoiceLiveSurface } from '../lib/voiceLive/surface';
import { createVoiceLane, pcm16Base64 } from '../lib/voiceLive/messages';
import { createWebAudioPlaybackBackend } from '../lib/voiceLive/playbackSession';
import { DriveModeVoiceLive } from '../components/DriveMode/DriveModeVoiceLive';

const LANE = createVoiceLane({ workerSessionId: 'voice-lab-worker', runtime: 'pi', nonce: 'lab' });
const PLAYBACK_RATE = 24_000;
const ANALYSIS_WINDOW_MS = 15;
const ANALYSIS_READS = 14;

interface LabEvent {
  t: number;
  event: string;
  data?: unknown;
}

interface LabState {
  ready: boolean;
  armed: boolean;
  captureStarted: boolean;
  modelSpeechRunning: boolean;
  events: LabEvent[];
  chimePlays: Array<{ variant: string; at: number }>;
  captureChunksSent: number;
  activityReports: Array<{ state: string; at: number }>;
  /** Every frame the surface handed to its transport (evidence: the echo). */
  sentFrames: VoiceClientMessage[];
}

const state: LabState = {
  ready: false,
  armed: false,
  captureStarted: false,
  modelSpeechRunning: false,
  events: [],
  chimePlays: [],
  captureChunksSent: 0,
  activityReports: [],
  sentFrames: [],
};

/** How long a lane start may stay unanswered in this lab (M7 evidence). */
let laneProbeTimeoutMs = 12_000;

/** The exact reason a cascade server gives for refusing a live lane. */
const CASCADE_DETAIL =
  'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade); the push-to-talk cascade is now serving this lane';

function now(): number {
  return Math.round(performance.now() * 1000) / 1000;
}

function log(event: string, data?: unknown): void {
  state.events.push({ t: now(), event, ...(data === undefined ? {} : { data }) });
  render();
}

// ── Audio graph + virtual microphone ────────────────────────────────────────

const arbiter = createSpeechArbiter();
let context: AudioContext | null = null;
let surface: VoiceLiveSurface | null = null;
let masterGain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let outputBuffer: Float32Array<ArrayBuffer> | null = null;
let virtualMic: { stream: MediaStream; setSpeaking(on: boolean): void } | null = null;
let modelSpeechTimer: number | null = null;
let outputSeq = 0;
let lastSpeaking: boolean | null = null;
let lastChimeSeen: string | null = null;

function buildVirtualMicrophone(context_: AudioContext): { stream: MediaStream; setSpeaking(on: boolean): void } {
  const destination = context_.createMediaStreamDestination();
  const gain = context_.createGain();
  gain.gain.value = 0; // silent until the spec says the operator is speaking
  const voice = context_.createOscillator(); // 220 Hz "voice"
  voice.frequency.value = 220;
  voice.type = 'sawtooth';
  const formant = context_.createOscillator(); // a second partial, speech-like
  formant.frequency.value = 660;
  formant.type = 'sine';
  const formantGain = context_.createGain();
  formantGain.gain.value = 0.4;
  voice.connect(gain);
  formant.connect(formantGain).connect(gain);
  gain.connect(destination);
  voice.start();
  formant.start();
  return {
    stream: destination.stream,
    setSpeaking(on: boolean) {
      gain.gain.setTargetAtTime(on ? 0.6 : 0, context_.currentTime, 0.01);
    },
  };
}

async function arm(): Promise<{ state: string; sampleRate: number }> {
  if (!context) {
    context = new AudioContext();
  }
  await context.resume();
  if (!virtualMic) virtualMic = buildVirtualMicrophone(context);
  state.armed = true;
  log('armed', { state: context.state, sampleRate: context.sampleRate });
  return { state: context.state, sampleRate: context.sampleRate };
}

function ensureSurface(): VoiceLiveSurface {
  if (surface) return surface;
  if (!context) throw new Error('arm() first');
  const backend = createWebAudioPlaybackBackend(context, context.destination);
  masterGain = backend.masterGain;
  analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  outputBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
  masterGain.connect(analyser);
  analyser.connect(context.destination);

  surface = new VoiceLiveSurface({
    lane: LANE,
    arbiter,
    factories: {
      createAudioContext: () => context as AudioContext,
      createPlaybackBackend: () => backend,
      laneProbeTimeoutMs,
      getUserMedia: async () => {
        if (!virtualMic) throw new Error('virtual microphone not armed');
        // The production path calls this exact API; the lab substitutes the
        // operating system's device with a deterministic virtual one.
        return virtualMic.stream;
      },
    },
    send: (frame) => {
      // The lab's transport seam: every frame the production surface builds is
      // recorded verbatim, so the spec can assert what really went out (the
      // proposalRef echo, the presentation report after playback).
      state.sentFrames.push(frame as VoiceClientMessage);
      if (frame.type === 'voice_audio_chunk') state.captureChunksSent += 1;
      log('send', frame.type);
    },
  });
  // Record the VAD → floor boundary transitions the surface published, so the
  // spec can correlate "operator started speaking" with the ducking it measures.
  // Seed the transition tracker with the current value so the first publish
  // does not fabricate a boundary that never happened.
  lastSpeaking = surface.getState().controller.operatorSpeaking;
  const activeSurface: VoiceLiveSurface = surface;
  activeSurface.subscribe(() => {
    const current = activeSurface.getState();
    if (current.controller.operatorSpeaking !== lastSpeaking) {
      lastSpeaking = current.controller.operatorSpeaking;
      state.activityReports.push({
        state: lastSpeaking ? 'speech_start' : 'speech_end',
        at: now(),
      });
    }
    if (current.lastChime && current.lastChime !== lastChimeSeen) {
      lastChimeSeen = current.lastChime;
      state.chimePlays.push({ variant: current.lastChime, at: now() });
    }
  });
  return activeSurface;
}

async function startCapture(): Promise<string> {
  const active = ensureSurface();
  const result = await active.startCapture();
  state.captureStarted = result === 'live';
  log('capture', result);
  return result;
}

function setSpeaking(on: boolean): void {
  if (!virtualMic) throw new Error('arm() first');
  virtualMic.setSpeaking(on);
  log(on ? 'operator_speaks' : 'operator_stops');
}

// ── Model speech (real 24 kHz chunks through the production pipeline) ───────

function modelChunk(seq: number): VoiceServerMessage {
  const frames = PLAYBACK_RATE / 50; // 20 ms
  const pcm = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    pcm[i] = Math.round(0.6 * 32767 * Math.sin((2 * Math.PI * 440 * i) / PLAYBACK_RATE));
  }
  return {
    type: 'voice_audio_chunk',
    version: VOICE_WIRE_VERSION,
    laneId: LANE.laneId,
    attachmentGeneration: LANE.attachmentGeneration,
    seq,
    mimeType: VOICE_AUDIO_OUTPUT_MIME,
    data: pcm16Base64(pcm),
    durationMs: 20,
    atMs: 0,
    // A deliberately malformed extra field would be ignored (server→client is
    // the host's own words); we keep the frame exactly to contract shape.
  } as unknown as VoiceServerMessage;
}

function startModelSpeech(): void {
  const active = ensureSurface();
  if (modelSpeechTimer !== null) return;
  state.modelSpeechRunning = true;
  modelSpeechTimer = window.setInterval(() => {
    active.onWireMessage(modelChunk(outputSeq));
    outputSeq += 1;
  }, 20);
  log('model_speech_start');
}

function stopModelSpeech(): void {
  if (modelSpeechTimer !== null) {
    window.clearInterval(modelSpeechTimer);
    modelSpeechTimer = null;
  }
  state.modelSpeechRunning = false;
  log('model_speech_stop');
}

// ── Measurement ─────────────────────────────────────────────────────────────

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function measure(): Promise<unknown> {
  const active = ensureSurface();
  if (!analyser || !outputBuffer) throw new Error('arm() first');
  const readings: number[] = [];
  for (let i = 0; i < ANALYSIS_READS; i += 1) {
    analyser.getFloatTimeDomainData(outputBuffer);
    readings.push(rms(outputBuffer));
    await new Promise((resolve) => setTimeout(resolve, ANALYSIS_WINDOW_MS));
  }
  const surfaceState = active.getState();
  const arbiterState = arbiter.getState();
  const result = {
    at: now(),
    output: {
      rmsMean: round(readings.reduce((a, b) => a + b, 0) / readings.length),
      rmsPeak: round(Math.max(...readings)),
      masterGainValue: round(masterGain ? masterGain.gain.value : -1),
    },
    arbiter: {
      operatorSpeaking: arbiterState.operatorSpeaking,
      ducked: arbiterState.ducked,
      playing: arbiterState.playing,
    },
    capture: {
      lifecycle: surfaceState.capture,
      detail: surfaceState.captureDetail,
      chunksSent: state.captureChunksSent,
      stats: surfaceState.captureStats,
    },
    playback: surfaceState.playback,
    activityReports: [...state.activityReports],
    chimePlays: [...state.chimePlays],
  };
  log('measure', result);
  return result;
}

function snapshot(): unknown {
  const active = ensureSurface();
  return {
    state: {
      armed: state.armed,
      captureStarted: state.captureStarted,
      modelSpeechRunning: state.modelSpeechRunning,
      captureChunksSent: state.captureChunksSent,
    },
    events: [...state.events],
    chimePlays: [...state.chimePlays],
    sentFrames: state.sentFrames.map((frame) => ({ ...frame })),
    surface: active.getState(),
    arbiter: arbiter.getState(),
  };
}

/** Frames of one type the surface has sent, oldest first. */
function sentFramesOfType(type: string): VoiceClientMessage[] {
  return state.sentFrames.filter((frame) => frame.type === type);
}

/** The frames a cascade server sends back for a lane it will not serve live. */
function deliverCascadeUnavailable(): void {
  deliver(serverMessage('voice_state', { state: 'error', detail: CASCADE_DETAIL }));
  deliver(
    serverMessage('voice_error', {
      code: 'voice_provider_unavailable',
      message: CASCADE_DETAIL,
      fatal: true,
    }),
  );
  render();
}

/** The frame the voice-frame budget limiter sends when nothing named a lane. */
function deliverTransportRefusal(): void {
  deliver({
    type: 'voice_error',
    version: VOICE_WIRE_VERSION,
    laneId: '',
    attachmentGeneration: 0,
    code: 'voice_internal_error',
    message: 'Voice frame rate exceeded; the frame was dropped.',
    fatal: false,
  });
  render();
}

// ── Wire fixtures for the visual (React) section ────────────────────────────

function deliver(raw: unknown): string {
  const active = ensureSurface();
  return active.onWireMessage(raw);
}

function serverMessage(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: LANE.laneId,
    attachmentGeneration: LANE.attachmentGeneration,
    ...extra,
  };
}

function deliverProposal(overrides: Record<string, unknown> = {}): string {
  const outcome = deliver(
    serverMessage('proposal_created', {
      proposal: {
        proposalId: 'prop-lab-1',
        version: 3,
        sha256: 'ab12'.padEnd(64, '7'),
        promotionRoute: 'directed',
        original: 'ask it whether the retry handler drops the token',
        tidied: 'ask whether the retry handler drops the token',
        presentedVariant: 'tidied',
        presentation: { completed: true },
        ...overrides,
      },
    }),
  );
  render();
  return outcome;
}

function deliverReceipt(outcome: string): string {
  const result = deliver(
    serverMessage('receipt_event', {
      receipt: {
        releaseId: 'rel-lab-1',
        proposalId: 'prop-lab-1',
        idempotencyKey: 'idem-lab-1',
        outcome,
        atMs: 1,
      },
    }),
  );
  render();
  return result;
}

function deliverParking(): string {
  const result = deliver(
    serverMessage('parking_updated', {
      operation: 'listed',
      items: [
        { itemId: 'item-lab-1', text: 'ask about the retry logic', createdAtMs: 1 },
        { itemId: 'item-lab-2', text: 'check the timeout constant', createdAtMs: 2 },
      ],
    }),
  );
  render();
  return result;
}

function deliverResolved(): string {
  const result = deliver(
    serverMessage('proposal_resolved', { proposalId: 'prop-lab-1', outcome: 'released', releaseId: 'rel-lab-1' }),
  );
  render();
  return result;
}

// ── Readout + React mount ───────────────────────────────────────────────────

function render(): void {
  const el = document.getElementById('readout');
  if (el) {
    el.textContent = JSON.stringify(
      {
        armed: state.armed,
        capture: surface?.getState().capture ?? 'idle',
        captureChunksSent: state.captureChunksSent,
        masterGain: masterGain ? round(masterGain.gain.value) : null,
        operatorSpeaking: arbiter.getState().operatorSpeaking,
        lastChime: surface?.getState().lastChime ?? null,
        events: state.events.slice(-6),
      },
      null,
      2,
    );
  }
}

let reactMounted = false;
function mountReact(): void {
  if (reactMounted) return;
  const root = document.getElementById('react-root');
  const active = ensureSurface();
  if (!root) return;
  reactMounted = true;
  createRoot(root).render(createElement(DriveModeVoiceLive, { surface: active, workerLabel: 'voice-lab-worker' }));
  active.subscribe(() => {
    // Re-render is driven by useSyncExternalStore inside the component; this
    // keeps the plain <pre> readout in step with it.
    render();
  });
}

window.__voiceLiveLab = {
  arm: async () => {
    await arm();
    ensureSurface();
    mountReact();
    state.ready = true;
    render();
    return { ready: true };
  },
  isReady: () => state.ready,
  startCapture,
  setSpeaking,
  startModelSpeech,
  stopModelSpeech,
  measure,
  snapshot,
  events: () => [...state.events],
  deliverProposal,
  deliverReceipt,
  deliverParking,
  deliverResolved,
  /** M7: open the lane on the wire (voice_session_start). */
  startLane: () => ensureSurface().startLane(),
  /** M7: the lane's honest availability from the surface's own state. */
  laneState: () => ensureSurface().getState().lane,
  // M8: a refusal that carried no lane envelope (the rate limiter's answer).
  deliverTransportRefusal,
  // M7: the pair a cascade server sends instead of serving the lane live.
  deliverCascadeUnavailable,
  /** H3: read the live proposal back aloud (the production read-back path). */
  readBack: (variant?: 'original' | 'tidied') => ensureSurface().readBackProposal(variant),
  sentFrames: (type?: string) => (type ? sentFramesOfType(type) : state.sentFrames.map((frame) => ({ ...frame }))),
  /** Must be called before arm(): the surface reads it when it is built. */
  setLaneProbeTimeout: (ms: number) => {
    laneProbeTimeoutMs = ms;
    return laneProbeTimeoutMs;
  },
  resetEvents: () => {
    state.events.length = 0;
    state.activityReports.length = 0;
    state.chimePlays.length = 0;
    state.sentFrames.length = 0;
    render();
    return true;
  },
};

declare global {
  interface Window {
    __voiceLiveLab: Record<string, unknown>;
  }
}

const armFromButton = window.__voiceLiveLab.arm as () => Promise<unknown>;
document.getElementById('arm')?.addEventListener('click', () => void armFromButton().catch(() => undefined));
document.getElementById('start')?.addEventListener('click', () => void startCapture());
document.getElementById('speak')?.addEventListener('click', () => setSpeaking(true));
document.getElementById('silence')?.addEventListener('click', () => setSpeaking(false));

render();

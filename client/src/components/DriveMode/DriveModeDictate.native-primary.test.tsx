import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VOICE_WIRE_VERSION, type VoiceClientMessage } from '@pi-web-ui/shared';
import { DriveModeDictate } from './DriveModeDictate';
import { VoiceLiveSurface, type VoiceLiveSurfaceFactories } from '../../lib/voiceLive/surface';
import { createVoiceLane } from '../../lib/voiceLive/messages';
import { loadCaptureWorklet } from '../../lib/voiceLive/captureSession';
import type {
  CaptureActivityReport,
  CaptureSession,
  StartCaptureSessionOptions,
} from '../../lib/voiceLive/captureSession';
import type { PlaybackBackend, ScheduledHandle } from '../../lib/voiceLive/playbackSession';

/**
 * Phase 2 (native-primary) — the FAMILIAR main Voice Mode controls are bound
 * to the NATIVE Live engine, and no competing default lane selector remains.
 *
 * Contract under test (plan §3.1, §11 Phase 2):
 *   - the main mic starts the native voice lane (evidence: voice_session_start
 *     on the wire + a real capture session), not the cascade talker;
 *   - the engine badge reports the ACTUAL path with evidence from the lane,
 *     never a configured label;
 *   - a refused/unavailable native lane degrades visibly and the cascade
 *     fallback engages ONLY on an explicit operator gesture;
 *   - a pending live-voice candidate survives a forced failure untouched:
 *     never auto-sent, never silently moved to the cascade path;
 *   - reading levels, push-to-talk, focus, stop and the layout scaffolding
 *     stay present and bind to whichever engine is actually operating.
 */

const sendMock = vi.fn();
const sendPromptMock = vi.fn();
vi.mock('../../hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock, sendPrompt: sendPromptMock })),
}));

const capture = {
  state: 'idle' as 'idle' | 'starting' | 'recording' | 'processing' | 'error',
  errorMessage: '',
  toggle: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  transcript: null as ((text: string) => void) | null,
};

vi.mock('../../hooks/useDictation', () => ({
  useDictation: vi.fn((onTranscript: (text: string) => void) => {
    capture.transcript = onTranscript;
    return {
      state: capture.state,
      errorMessage: capture.errorMessage,
      startRecording: capture.startRecording,
      stopRecording: capture.stopRecording,
      toggle: capture.toggle,
    };
  }),
}));

const sessionState = { isStreaming: false, messages: [] as Array<Record<string, unknown>> };
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector ? selector(sessionState) : sessionState
  ),
}));

const driveState = { phase: 'dictate', setPhase: vi.fn() };
vi.mock('../../store/driveModeStore', () => ({
  useDriveModeStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector ? selector(driveState) : driveState
  ),
}));

vi.mock('lucide-react', () => ({
  Mic: () => <span data-testid="icon-mic" />,
  Smartphone: () => <span data-testid="icon-smartphone" />,
  Monitor: () => <span data-testid="icon-monitor" />,
  MicOff: () => <span data-testid="icon-micoff" />,
  Square: () => <span data-testid="icon-square" />,
  VolumeX: () => <span data-testid="icon-volumex" />,
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  Send: () => <span data-testid="icon-send" />,
  Car: () => <span data-testid="icon-car" />,
  Eye: () => <span data-testid="icon-eye" />,
  EyeOff: () => <span data-testid="icon-eyeoff" />,
  Inbox: () => <span data-testid="icon-inbox" />,
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Radio: () => <span data-testid="icon-radio" />,
  Keyboard: () => <span data-testid="icon-keyboard" />,
  AlertTriangle: () => <span data-testid="icon-warning" />,
  BellRing: () => <span data-testid="icon-bell" />,
  Clock: () => <span data-testid="icon-clock" />,
  HelpCircle: () => <span data-testid="icon-help" />,
  Volume2: () => <span data-testid="icon-volume2" />,
  ArrowUpRight: () => <span data-testid="icon-arrow-up-right" />,
}));

// ── The native lane the surface binds to: a REAL VoiceLiveSurface over fake
//    browser factories (same approach as DriveModeVoiceLive.test.tsx), so the
//    routing assertions see genuine surface behaviour, not a stub. ──

const native = vi.hoisted(() => {
  const holder: {
    surface: import('../../lib/voiceLive/surface').VoiceLiveSurface | null;
    lane: import('../../lib/voiceLive/messages').VoiceLaneIdentity | null;
    frames: import('@pi-web-ui/shared').VoiceClientMessage[];
  } = { surface: null, lane: null, frames: [] };
  return holder;
});

function buildNativeSurface(options: { failMic?: boolean } = {}): VoiceLiveSurface {
  const frames: VoiceClientMessage[] = [];
  native.frames = frames;
  const activity: Array<(report: CaptureActivityReport) => void> = [];
  const counters = { captureStops: 0 };
  const backend: PlaybackBackend = {
    currentTime: () => 0,
    schedule: (): ScheduledHandle => ({ stop() {} }),
    setVolumeAt() {},
    setVolumeNow() {},
    stopAll() {},
    currentVolume: () => 1,
  };
  const gain = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
    connect() {},
    disconnect() {},
  });
  const fakeContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    audioWorklet: {
      addModule: async () => {},
    },
    createGain: gain,
    createOscillator: () => ({ type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }),
    resume: async () => undefined,
    close: async () => undefined,
  } as unknown as AudioContext;
  const factories: VoiceLiveSurfaceFactories = {
    createAudioContext: () => fakeContext,
    createPlaybackBackend: () => backend,
    getUserMedia: async () => {
      if (options.failMic) throw new Error('NotAllowedError: permission denied');
      return { getAudioTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    startCaptureSession: async (opts: StartCaptureSessionOptions) => {
      await loadCaptureWorklet(opts.context, {
        ...(opts.onFault ? { onFault: opts.onFault } : {}),
        ...(opts.workletUrls ? { workletUrls: opts.workletUrls } : {}),
      });
      activity.push(opts.onActivity ?? (() => {}));
      const session: CaptureSession = {
        inputRate: 48_000,
        stop: async () => {
          counters.captureStops += 1;
        },
        flush() {},
        stats: () => ({ framesProduced: 0, chunksSent: 0, chunksDropped: 0, speaking: false, pendingChunks: 0 }),
      };
      return session;
    },
  };
  const lane = createVoiceLane({ workerSessionId: WORKER, nonce: 'np1' });
  native.lane = lane;
  const surface = new VoiceLiveSurface({
    lane,
    send: (frame) => void frames.push(frame),
    arbiter: createSpeechArbiter(),
    factories,
  });
  native.surface = surface;
  return surface;
}

vi.mock('../../hooks/useVoiceLiveLane', () => ({
  useVoiceLiveLane: vi.fn(() => {
    if (!native.surface) throw new Error('test bug: native surface not built');
    return { surface: native.surface, laneId: native.lane?.laneId ?? 'lane' };
  }),
}));

import { createSpeechArbiter } from '../../lib/speechArbiter';

const WORKER = '/pi/worker.jsonl';

function renderSurface(sdkType = 'pi') {
  buildNativeSurface();
  return render(
    <DriveModeDictate
      sessionId={WORKER}
      sdkType={sdkType}
      modelName="test-model"
      sessionDisplayName="Worker"
      onExit={vi.fn()}
      onAbort={vi.fn()}
    />
  );
}

function env(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: native.lane?.laneId,
    attachmentGeneration: 0,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.surface = null;
  native.lane = null;
  native.frames = [];
  capture.state = 'idle';
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getAudioTracks: () => [{ stop() {} }] }) },
  });
});

describe('DriveModeDictate — native primary (Phase 2)', () => {
  it('RED CORE: the main microphone starts the NATIVE voice lane, not the cascade talker', async () => {
    renderSurface();
    fireEvent.click(screen.getByTestId('drive-mic'));
    await waitFor(() =>
      expect(native.frames.some((f) => f.type === 'voice_session_start')).toBe(true),
    );
    // Real capture work through the native surface, not the cascade dictation.
    await waitFor(() => expect(native.surface?.getState().capture).toBe('live'));
    expect(capture.toggle).not.toHaveBeenCalled();
    expect(capture.startRecording).not.toHaveBeenCalled();
  });

  it('no competing default lane selector remains on the main surface', () => {
    renderSurface();
    expect(screen.queryByTestId('native-voice-lane')).toBeNull();
    expect(screen.queryByTestId('native-voice-lane-toggle')).toBeNull();
    expect(screen.queryByText(/Free lane/)).toBeNull();
    // The familiar surface itself is intact.
    expect(screen.getByTestId('drive-mic')).toBeTruthy();
  });

  it('the engine badge reports the ACTUAL path with evidence from the lane', async () => {
    renderSurface();
    const badge = screen.getByTestId('voice-engine-badge');
    expect(badge.getAttribute('data-engine')).toBe('native');
    expect(badge.getAttribute('data-lane-state')).toBe('unknown');

    fireEvent.click(screen.getByTestId('drive-mic'));
    await waitFor(() => expect(badge.getAttribute('data-lane-state')).toBe('connecting'));

    // The server's own answer is the evidence of the active engine.
    native.surface?.onWireMessage(env('voice_state', { state: 'live', workerActivity: 'working' }));
    await waitFor(() => expect(badge.getAttribute('data-lane-state')).toBe('live'));
    expect(badge.getAttribute('data-wire-state')).toBe('live');
  });

  it('a runtime the voice wire cannot serve is named honestly, without guessing an engine', () => {
    renderSurface('opencode');
    const badge = screen.getByTestId('voice-engine-badge');
    expect(badge.getAttribute('data-engine')).toBe('native');
    expect(badge.textContent).toContain('opencode');
  });

  it('a refused lane degrades visibly and the cascade fallback engages ONLY explicitly', async () => {
    renderSurface();
    // Refuse the lane the way the cascade-mode server does.
    native.surface?.onWireMessage(
      env('voice_error', {
        code: 'voice_provider_unavailable',
        message: 'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade)',
        fatal: true,
      }),
    );
    const badge = await waitFor(() => {
      const b = screen.getByTestId('voice-engine-badge');
      expect(b.getAttribute('data-lane-state')).toBe('unavailable');
      return b;
    });
    // The degraded state names the server's own reason.
    const banner = screen.getByTestId('voice-engine-fallback-banner');
    expect(banner.textContent).toContain('VOICE_MODE_ENGINE=cascade');

    // NO silent engine switch: the main mic must not start the cascade capture.
    fireEvent.click(screen.getByTestId('drive-mic'));
    expect(capture.toggle).not.toHaveBeenCalled();
    expect(capture.startRecording).not.toHaveBeenCalled();
    expect(screen.getByTestId('voice-engine-badge').getAttribute('data-engine')).toBe('native');

    // The explicit gesture is what engages the fallback.
    fireEvent.click(screen.getByTestId('voice-engine-fallback-activate'));
    expect(screen.getByTestId('voice-engine-badge').getAttribute('data-engine')).toBe('cascade-fallback');
    fireEvent.click(screen.getByTestId('drive-mic'));
    expect(capture.toggle).toHaveBeenCalled();
  });

  it('a pending live-voice candidate survives a forced failure: never auto-sent, never moved to the cascade path', async () => {
    renderSurface();
    // Go live, then create a proposal (the host's candidate for approval).
    fireEvent.click(screen.getByTestId('drive-mic'));
    await waitFor(() => { expect(native.frames.some((f) => f.type === 'voice_session_start')).toBe(true); });
    native.surface?.onWireMessage(env('voice_state', { state: 'live' }));
    native.surface?.onWireMessage(
      env('proposal_created', {
        proposal: {
          proposalId: 'prop-9',
          version: 5,
          sha256: 'c'.repeat(64),
          promotionRoute: 'directed',
          original: 'ask it whether the retry handler drops the token',
          tidied: 'ask whether the retry handler drops the token',
          presentedVariant: 'tidied',
          presentation: { completed: true },
        },
      }),
    );
    await screen.findByTestId('proposal-card');

    // Force the failure mid-candidate.
    native.surface?.onWireMessage(
      env('voice_error', {
        code: 'voice_provider_unavailable',
        message: 'the live engine stopped',
        fatal: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('voice-engine-badge').getAttribute('data-lane-state')).toBe('unavailable'),
    );

    // The draft is preserved and still pending — it was not released.
    expect(screen.getByTestId('proposal-card')).toBeTruthy();
    const confirmFrames = native.frames.filter((f) => f.type === 'proposal_confirm');
    expect(confirmFrames).toHaveLength(0);

    // Taking the explicit fallback does not send the candidate through the
    // cascade path either: the transition itself sends NOTHING, and the draft
    // stays VISIBLE as a preserved, unapproved notice — never auto-sent.
    fireEvent.click(screen.getByTestId('voice-engine-fallback-activate'));
    fireEvent.click(screen.getByTestId('drive-mic'));
    expect(sendMock).not.toHaveBeenCalled();
    const preserved = screen.getByTestId('voice-engine-preserved-draft');
    expect(preserved.textContent).toContain('not sent');
    expect(preserved.textContent).toContain('retry handler');
  });

  it('the reading level control binds to the native engine while it is primary', async () => {
    renderSurface();
    fireEvent.click(screen.getByTestId('drive-mic'));
    await waitFor(() => expect(native.frames.some((f) => f.type === 'voice_session_start')).toBe(true));
    native.surface?.onWireMessage(env('voice_state', { state: 'live' }));

    // The familiar control position; the native engine receives the choice.
    fireEvent.click(screen.getByTestId('reading-level-headlines'));
    await waitFor(() =>
      expect(native.frames.some((f) => f.type === 'voice_reading_level')).toBe(true),
    );
    const frame = native.frames.find((f) => f.type === 'voice_reading_level') as
      | { level?: string }
      | undefined;
    expect(frame?.level).toBe('headlines');
  });

  it('push-to-talk is retained: the mode selector exists and the main mic holds to talk', async () => {
    renderSurface();
    fireEvent.click(screen.getByTestId('drive-capture-mode-push-to-talk'));
    await waitFor(() =>
      expect(native.surface?.getState().controller.captureMode).toBe('push-to-talk'),
    );

    const mic = screen.getByTestId('drive-mic');
    fireEvent.pointerDown(mic);
    await waitFor(() => expect(native.surface?.getState().capture).toBe('live'));
    fireEvent.pointerUp(mic);
    await waitFor(() => expect(native.surface?.getState().capture).not.toBe('live'));
  });

  it('the preservation set stays present: focus, layout toggle, floor, stop, contract hint', () => {
    renderSurface();
    expect(screen.getByTestId('drive-mode-surface').getAttribute('data-engine')).toBe('native');
    expect(screen.getByTestId('voice-layout-toggle')).toBeTruthy();
    expect(screen.getByTestId('voice-contract-hint')).toBeTruthy();
    expect(screen.getByTestId('drive-mic')).toBeTruthy();
  });
});

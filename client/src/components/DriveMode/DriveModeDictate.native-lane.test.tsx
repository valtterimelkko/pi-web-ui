import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DriveModeDictate } from './DriveModeDictate';

/**
 * M7 (Track L) — the native voice lane is mounted WHERE THE VOICE LANE LIVES,
 * and a lane that cannot start never takes the shipped Drive Mode surface down
 * with it.
 *
 * The mocks mirror the existing `DriveModeDictate.single-lane` suite (which
 * pins the shipped surface byte for byte): the dictation hook, the two stores,
 * the app socket and the icon set. Everything else — including the mount under
 * test — is the real component tree.
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
  transcript: null as ((text: string) => void) | null,
};

vi.mock('../../hooks/useDictation', () => ({
  useDictation: vi.fn((onTranscript: (text: string) => void) => {
    capture.transcript = onTranscript;
    return {
      state: capture.state,
      errorMessage: capture.errorMessage,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
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
}));

const WORKER = '/pi/worker.jsonl';

function renderSurface(sdkType = 'pi') {
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

/** The multi-lane shape: `laneEnabled` is Drive Mode's own flag, `addressed` says
 *  which lane the operator is looking at. */
function renderFace(options: { laneEnabled: boolean; addressed: boolean }) {
  return render(
    <DriveModeDictate
      sessionId={WORKER}
      sdkType="pi"
      modelName="test-model"
      sessionDisplayName="Worker"
      onExit={vi.fn()}
      onAbort={vi.fn()}
      laneEnabled={options.laneEnabled}
      addressed={options.addressed}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no microphone; the lane's honest capability check would report
  // "unsupported". Substitute the device, as the ducking lab does.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getAudioTracks: () => [{ stop() {} }] }) },
  });
});

describe('DriveModeDictate — the native voice lane is reachable from the voice surface (M7)', () => {
  it('names a session runtime the voice wire cannot serve instead of guessing at one', () => {
    renderSurface('opencode');
    const lane = screen.getByTestId('native-voice-lane');
    expect(lane.getAttribute('data-runtime-served')).toBe('false');
    expect(screen.getByTestId('native-voice-lane-runtime-unavailable').textContent).toContain('opencode');
    // The shipped surface is untouched.
    expect(screen.getByTestId('drive-mic')).toBeTruthy();
    expect(screen.getByTestId('voice-contract-hint')).toBeTruthy();
  });

  it('offers the native lane without disturbing the shipped microphone surface', () => {
    renderSurface();
    // The shipped surface is exactly as before, plus one closed, named lane.
    expect(screen.getByTestId('drive-mic')).toBeTruthy();
    expect(screen.getByTestId('voice-contract-hint')).toBeTruthy();
    const lane = screen.getByTestId('native-voice-lane');
    expect(lane).toBeTruthy();
    expect(screen.getByTestId('native-voice-lane-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('drive-mode-voice-live')).toBeNull();
    expect(screen.getByTestId('native-voice-lane-summary')).toBeTruthy();
  });

  it('a lane the server will not serve explains itself in place, and the drive surface survives', async () => {
    const { unmount } = renderSurface();
    fireEvent.click(screen.getByTestId('native-voice-lane-toggle'));
    await screen.findByTestId('drive-mode-voice-live');
    expect(screen.getByTestId('drive-mic')).toBeTruthy();

    // The lane's own socket tap delivers the cascade server's refusal.
    const laneId = screen.getByTestId('native-voice-lane').getAttribute('data-lane-id');
    const { emitVoiceFrame } = await import('../../lib/voiceLive/frameBus');
    emitVoiceFrame({
      type: 'voice_error',
      version: 1,
      laneId,
      attachmentGeneration: 0,
      code: 'voice_provider_unavailable',
      message: 'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade)',
      fatal: true,
    });

    const panel = await screen.findByTestId('voice-live-unavailable');
    expect(panel.getAttribute('data-reason')).toBe('unavailable');
    expect(screen.getByTestId('voice-live-unavailable-detail').textContent).toContain('cascade');

    // Nothing about the shipped Drive Mode journey changed: the mic, its
    // contract hint and the exit control are all still there and usable.
    expect(screen.getByTestId('drive-mic')).toBeTruthy();
    expect(screen.getByTestId('voice-contract-hint')).toBeTruthy();
    fireEvent.click(screen.getByTestId('drive-mic'));
    await waitFor(() => expect(capture.toggle).toHaveBeenCalled());

    unmount();
  });

  /**
   * ONE PLAYBACK CHAIN PER PAGE.
   *
   * The operator reported the talker's voice "talking on top of each other", and
   * the one mechanism a single scheduler cannot produce is a second output chain:
   * every mounted lane surface owns its own AudioContext and its own playback
   * pipeline, so two mounted surfaces would play the same model audio twice.
   * Multi-lane Drive Mode mounts the dictate surface once per lane (all of them
   * stay mounted so their capture and cards live per lane), so the guard that
   * only the ADDRESSED lane mounts a voice lane is what keeps a two-lane page from
   * becoming two players. Production evidence agrees (every lane the server has
   * ever seen is index 1, one per page); this pins it so it cannot regress.
   */
  it('mounts exactly one lane per page: a non-addressed lane mounts none', async () => {
    const { voiceLaneRegistrationCount } = await import('../../lib/voiceLive/frameBus');

    const addressed = renderFace({ laneEnabled: true, addressed: true });
    expect(screen.getAllByTestId('native-voice-lane')).toHaveLength(1);
    expect(voiceLaneRegistrationCount()).toBe(1);
    addressed.unmount();
    await waitFor(() => expect(voiceLaneRegistrationCount()).toBe(0));

    const addressedTwo = renderFace({ laneEnabled: true, addressed: true });
    const notAddressed = renderFace({ laneEnabled: true, addressed: false });
    // Two dictate surfaces are mounted (as multi-lane Drive Mode does), and still
    // only one of them is a player.
    expect(screen.getAllByTestId('native-voice-lane')).toHaveLength(1);
    expect(voiceLaneRegistrationCount()).toBe(1);

    notAddressed.unmount();
    addressedTwo.unmount();
    await waitFor(() => expect(voiceLaneRegistrationCount()).toBe(0));
  });
});

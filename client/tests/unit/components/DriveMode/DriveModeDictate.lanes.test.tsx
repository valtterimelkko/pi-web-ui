import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';
import { laneFloor } from '../../../../src/components/DriveMode/voiceLanes';
import { useReadingLevelStore } from '../../../../src/components/DriveMode/readingLevel';

/**
 * Multi-lane surface behaviour (lane work, 2026-09-15).
 *
 * ONE tab holds the lanes: every lane mounts its own DriveModeDictate with
 * per-lane transcript, card, reading level and focus; only the ADDRESSED
 * lane's surface is visible; taking the mic on the addressed lane hands the
 * floor over from a capturing lane; and lane surfaces never fight over the
 * store's dictate phase.
 */

const sendMock = vi.fn();
const sendPromptMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock, sendPrompt: sendPromptMock })),
}));

/** Per-instance dictation records so two lanes can be driven independently.
 *  Keyed by the instance's worker session (from the hook's error context);
 *  re-renders replace the record, so a lookup is always the LIVE instance. */
const instancesBySession: Record<
  string,
  {
    state: 'idle' | 'starting' | 'recording' | 'processing' | 'error';
    errorMessage: string;
    toggle: ReturnType<typeof vi.fn>;
    stopRecording: ReturnType<typeof vi.fn>;
    startRecording: ReturnType<typeof vi.fn>;
    transcript: ((text: string) => void) | null;
  }
> = {};

vi.mock('../../../../src/hooks/useDictation', () => ({
  useDictation: vi.fn((onTranscript: (text: string) => void, ctx?: { workerSessionId?: string }) => {
    const instance = {
      state: 'idle' as const,
      errorMessage: '',
      toggle: vi.fn(),
      stopRecording: vi.fn(),
      startRecording: vi.fn(),
      transcript: onTranscript,
    };
    instancesBySession[ctx?.workerSessionId ?? 'unknown'] = instance;
    return instance;
  }),
}));

const sessionState = {
  isStreaming: false,
  messages: [] as Array<Record<string, unknown>>,
  sessionMessages: {} as Record<string, Array<Record<string, unknown>>>,
  streamingSessions: {} as Record<string, boolean>,
};
vi.mock('../../../../src/store/sessionStore', () => ({
  useSessionStore: vi.fn((selector: (s: unknown) => unknown) =>
    selector ? selector(sessionState) : sessionState
  ),
}));

const driveState = { phase: 'dictate', setPhase: vi.fn() };
vi.mock('../../../../src/store/driveModeStore', () => ({
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
}));

function makeBlockedPlayer(): ArbiterPlayer {
  return {
    playChunk: () => new Promise<void>(() => {}),
    setVolume: () => {},
    stopCurrent: () => {},
  };
}

const SESSION_A = '/pi/worker-a.jsonl';
const SESSION_B = '/pi/worker-b.jsonl';

function renderLane(
  sessionId: string,
  opts: { laneEnabled: boolean; addressed: boolean },
  key?: string
) {
  return render(
    <DriveModeDictate
      key={key}
      sessionId={sessionId}
      sdkType="pi"
      modelName="test-model"
      sessionDisplayName={sessionId === SESSION_A ? 'Worker A' : 'Worker B'}
      onExit={vi.fn()}
      onAbort={vi.fn()}
      laneEnabled={opts.laneEnabled}
      addressed={opts.addressed}
    />
  );
}

function surfaceOf(sessionId: string): HTMLElement {
  const surface = document.querySelector(`[data-drive-session="${sessionId}"]`);
  if (!surface) throw new Error(`no lane surface for ${sessionId}`);
  return surface as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTalkerTurnBus();
  for (const key of Object.keys(instancesBySession)) delete instancesBySession[key];
  sendMock.mockReturnValue('sent');
  sendPromptMock.mockReturnValue('sent');
  sessionState.isStreaming = false;
  sessionState.messages = [];
  sessionState.sessionMessages = {};
  sessionState.streamingSessions = {};
  driveState.phase = 'dictate';
  spokenLedger.clear();
  speechArbiter.stopAll();
  laneFloor.dispose();
  speechArbiter.attachPlayer(makeBlockedPlayer());
  useReadingLevelStore.setState({ level: 'summary', levels: {} });
});

afterEach(() => {
  speechArbiter.stopAll();
  laneFloor.dispose();
});

describe('two lanes, one tab — per-lane surfaces', () => {
  it('the addressed lane is visible; a non-addressed lane is hidden, not unmounted', () => {
    renderLane(SESSION_A, { laneEnabled: true, addressed: true }, 'a');
    renderLane(SESSION_B, { laneEnabled: true, addressed: false }, 'b');
    const a = surfaceOf(SESSION_A);
    const b = surfaceOf(SESSION_B);
    expect(a.hasAttribute('hidden')).toBe(false);
    expect(b.hasAttribute('hidden')).toBe(true);
    // Hidden, not gone: lane B's mic control still exists in the document.
    expect(within(b).getByTestId('drive-mic')).toBeInTheDocument();
  });

  it('each lane reads its OWN session transcript — lane A\'s answer never becomes lane B\'s', () => {
    sessionState.sessionMessages = {
      [SESSION_B]: [
        { id: 'm1', role: 'assistant', content: 'Worker B finished the deploy.' },
      ],
      // Lane A (the "current" session) has a DIFFERENT transcript.
    };
    sessionState.messages = [];
    renderLane(SESSION_A, { laneEnabled: true, addressed: false }, 'a');
    renderLane(SESSION_B, { laneEnabled: true, addressed: true }, 'b');

    // The ADDRESSED lane's surface has an answer to read — its OWN transcript
    // (the global current-session transcript is empty).
    const readAloudB = within(surfaceOf(SESSION_B)).getByRole('button', { name: /read aloud/i });
    expect(readAloudB).not.toBeDisabled();
    // …and lane A's surface has none (its transcript is empty), even hidden.
    expect(
      within(surfaceOf(SESSION_A)).queryByRole('button', { name: /read aloud/i, hidden: true })
    ).toBeNull();
  });

  it('each lane reads its OWN streaming state', () => {
    sessionState.streamingSessions = { [SESSION_A]: true };
    renderLane(SESSION_A, { laneEnabled: true, addressed: true }, 'a');
    renderLane(SESSION_B, { laneEnabled: true, addressed: false }, 'b');
    expect(
      within(surfaceOf(SESSION_A)).getByTestId('floor-state-label').textContent
    ).toMatch(/working silently/i);
    expect(
      within(surfaceOf(SESSION_B)).getByTestId('floor-state-label').textContent
    ).toMatch(/tap to speak/i);
  });

  it('a reading-level change in one lane stays in that lane', () => {
    renderLane(SESSION_A, { laneEnabled: true, addressed: true }, 'a');
    renderLane(SESSION_B, { laneEnabled: true, addressed: false }, 'b');
    fireEvent.click(within(surfaceOf(SESSION_A)).getByTestId('reading-level-verbatim'));
    expect(
      within(surfaceOf(SESSION_A)).getByTestId('reading-level-indicator').textContent
    ).toMatch(/verbatim/i);
    expect(
      within(surfaceOf(SESSION_B)).getByTestId('reading-level-indicator').textContent
    ).toMatch(/summary/i);
  });

  it('lane surfaces never write the store phase — no cross-lane phase fights', () => {
    sessionState.streamingSessions = { [SESSION_A]: true };
    const { rerender: rerenderA } = renderLane(SESSION_A, { laneEnabled: true, addressed: true }, 'a');
    renderLane(SESSION_B, { laneEnabled: true, addressed: false }, 'b');
    act(() => {
      rerenderA(
        <DriveModeDictate
          sessionId={SESSION_A}
          sdkType="pi"
          modelName="test-model"
          sessionDisplayName="Worker A"
          onExit={vi.fn()}
          onAbort={vi.fn()}
          laneEnabled
          addressed
        />
      );
    });
    expect(driveState.setPhase).not.toHaveBeenCalled();
  });
});

describe('two lanes, one tab — the floor changes hands on the addressed lane', () => {
  it('taking the mic on the addressed lane stops (finalises) the capturing lane first', () => {
    renderLane(SESSION_A, { laneEnabled: true, addressed: false }, 'a');
    renderLane(SESSION_B, { laneEnabled: true, addressed: true }, 'b');
    // Lane A is recording (it holds the operator floor)…
    instancesBySession[SESSION_A].state = 'recording';
    act(() => {
      laneFloor.setLaneCapture(SESSION_A, true);
    });
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);
    // …the operator addresses lane B and taps its mic: A's capture is
    // finalised (its words go to A's talker — never dropped) and B starts.
    fireEvent.click(within(surfaceOf(SESSION_B)).getByTestId('drive-mic'));
    expect(instancesBySession[SESSION_A].stopRecording).toHaveBeenCalledTimes(1);
    expect(instancesBySession[SESSION_B].toggle).toHaveBeenCalledTimes(1);
  });

  it('tapping the mic with nobody capturing starts capture with no handoff', () => {
    renderLane(SESSION_B, { laneEnabled: true, addressed: true }, 'b');
    fireEvent.click(within(surfaceOf(SESSION_B)).getByTestId('drive-mic'));
    expect(instancesBySession[SESSION_B].stopRecording).not.toHaveBeenCalled();
    expect(instancesBySession[SESSION_B].toggle).toHaveBeenCalledTimes(1);
  });
});

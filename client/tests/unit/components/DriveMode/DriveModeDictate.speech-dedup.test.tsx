import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { speechArbiter, TIER_ANSWER, type ArbiterPlayer, type SpeechIntentInput } from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';

/**
 * P16 — never say the same thing twice (read-aloud vs talker collision).
 *
 * The defect: read-aloud submits at TIER_ANSWER, exactly like the talker's
 * auto-speak, but the auto-speak's dedup guard was written only by the auto
 * path. Press read-aloud on an answer, let the turn end, and the auto-speak
 * re-submitted the same text at the same tier — the operator heard it twice,
 * back to back.
 *
 * These tests drive the REAL surface (a click on "Read Aloud" and the real
 * auto-speak effect), not a helper, so they pin the operator-visible defect:
 *   req 1 — read-aloud then turn end must not re-submit the same answer;
 *   req 2 — a genuinely different answer still speaks (auto-speak is NOT off);
 *   req 3 — the explicit action always plays, even over the talker's own
 *           playback, and marks the text so the auto path cannot repeat it;
 *   req 4 — while read-aloud plays, no duplicate is queued behind it.
 *
 * P15's stop-talker suite is untouched; these tests neither stop nor clear
 * playback through the stop control.
 */

// --- Transport: capture outgoing socket messages ----------------------------
const sendMock = vi.fn();
const sendPromptMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock, sendPrompt: sendPromptMock })),
}));

// --- Capture: controllable dictation state ----------------------------------
const capture: {
  state: 'idle' | 'recording' | 'processing' | 'error';
  errorMessage: string;
  toggle: ReturnType<typeof vi.fn>;
  transcript: ((text: string) => void) | null;
} = {
  state: 'idle',
  errorMessage: '',
  toggle: vi.fn(),
  transcript: null,
};
vi.mock('../../../../src/hooks/useDictation', () => ({
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

// --- Stores -----------------------------------------------------------------
const sessionState = { isStreaming: false, messages: [] as Array<Record<string, unknown>> };
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

// The read-aloud hook resumes the shared AudioContext during the user gesture.
// Playback itself is the fake arbiter player below, so the context only has to
// exist and be resumable.
class StubAudioContext {
  state = 'running';
  resume = vi.fn(async () => {});
}

// --- A blocked fake player: submitted speech stays visibly in-flight ---------
function makeBlockedPlayer() {
  const played: string[] = [];
  const resolvers: Array<() => void> = [];
  const player: ArbiterPlayer = {
    playChunk: (chunk: string) => {
      played.push(chunk);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
    setVolume: () => {},
    stopCurrent: () => {
      while (resolvers.length) resolvers.shift()?.();
    },
  };
  return { player, played };
}

const WORKER = '/pi/worker.jsonl';
const ANSWER_A = 'The build is green and all checks passed.';
const ANSWER_B = 'A genuinely different answer that must still speak.';

const surface = () => (
  <DriveModeDictate
    sessionId={WORKER}
    sdkType="pi"
    modelName="test-model"
    sessionDisplayName="Worker"
    onExit={vi.fn()}
    onAbort={vi.fn()}
  />
);

let harness = makeBlockedPlayer();

function renderSurface() {
  return render(surface());
}

/** Drive one completed worker answer through the real auto-speak effect. */
function finishWorkerAnswer(text: string, rerender: (ui: ReactElement) => void) {
  sessionState.isStreaming = true;
  sessionState.messages = [
    { id: 'm1', role: 'assistant', content: text, timestamp: Date.now() },
  ];
  act(() => {
    rerender(surface());
  });
  sessionState.isStreaming = false;
  act(() => {
    rerender(surface());
  });
}

const readAloudButton = () => screen.getByRole('button', { name: /read aloud/i });
const autoAnswerIds = () =>
  speechArbiter.getState().queued.map((q) => q.id).filter((id) => id.startsWith('answer-auto'));

/** Every submission the surface made at the answer tier, in order. */
function answerSubmissions(
  spy: MockInstance<[SpeechIntentInput], 'queued' | 'dropped'>
): SpeechIntentInput[] {
  return spy.mock.calls
    .map(([input]) => input)
    .filter((input) => input.tier === TIER_ANSWER);
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockReturnValue('sent');
  sendPromptMock.mockReturnValue('sent');
  capture.state = 'idle';
  capture.errorMessage = '';
  capture.transcript = null;
  sessionState.isStreaming = false;
  sessionState.messages = [];
  driveState.phase = 'dictate';
  vi.stubGlobal('AudioContext', StubAudioContext);
  spokenLedger.clear();
  speechArbiter.stopAll();
  harness = makeBlockedPlayer();
  speechArbiter.attachPlayer(harness.player);
});

afterEach(() => {
  speechArbiter.stopAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('P16 — read-aloud and the talker never say the same answer twice', () => {
  it('req 1 + req 4 — a read-aloud answer is not re-submitted by the auto-speak when the turn ends', () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    sessionState.messages = [
      { id: 'm1', role: 'assistant', content: ANSWER_A, timestamp: 1 },
    ];
    const { rerender } = renderSurface();

    // The operator asks for the answer aloud — explicit action, plays now.
    fireEvent.click(readAloudButton());
    expect(speechArbiter.getState().current?.id).toBe('drive-mode');
    expect(harness.played[0]).toBe(ANSWER_A);

    // The turn then ends with the SAME final assistant message.
    finishWorkerAnswer(ANSWER_A, rerender);

    // No duplicate queued behind the read-aloud, and exactly one submission
    // of this answer in total: the operator's.
    expect(autoAnswerIds()).toEqual([]);
    expect(answerSubmissions(submitSpy)).toHaveLength(1);
    expect(speechArbiter.getState().current?.id).toBe('drive-mode');
  });

  it('req 2 — a genuinely different answer after a read-aloud still speaks', () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    sessionState.messages = [
      { id: 'm1', role: 'assistant', content: ANSWER_A, timestamp: 1 },
    ];
    const { rerender } = renderSurface();
    fireEvent.click(readAloudButton());
    expect(speechArbiter.getState().current?.id).toBe('drive-mode');

    finishWorkerAnswer(ANSWER_B, rerender);

    // The new answer was submitted (queued behind the still-playing read-aloud)
    // and it is the NEW text — auto-speak was not disabled.
    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain(ANSWER_B);
    expect(autoAnswerIds()).toHaveLength(1);
  });

  it('req 3 — the explicit action replays an answer the talker already spoke, and then blocks the auto repeat', () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    // The talker auto-speaks the completed answer first…
    finishWorkerAnswer(ANSWER_A, rerender);
    expect(speechArbiter.getState().current?.id).toBe('answer-auto-0');

    // …and the operator still gets to hear it on demand: read-aloud wins.
    fireEvent.click(readAloudButton());
    expect(speechArbiter.getState().current?.id).toBe('drive-mode');
    expect(harness.played[harness.played.length - 1]).toBe(ANSWER_A);

    // A later turn-ending with the same text cannot repeat it again.
    const before = answerSubmissions(submitSpy).length;
    finishWorkerAnswer(ANSWER_A, rerender);
    expect(answerSubmissions(submitSpy)).toHaveLength(before);
    expect(autoAnswerIds()).toEqual([]);
  });

  it('INVARIANT — capture is never gated by read-aloud playback', () => {
    sessionState.messages = [
      { id: 'm1', role: 'assistant', content: ANSWER_A, timestamp: 1 },
    ];
    renderSurface();
    fireEvent.click(readAloudButton());
    expect(speechArbiter.getState().current?.id).toBe('drive-mode');

    expect(capture.transcript).toBeTruthy();
    act(() => {
      capture.transcript?.('an utterance while the answer is read aloud');
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: 'an utterance while the answer is read aloud' })
    );
  });
});

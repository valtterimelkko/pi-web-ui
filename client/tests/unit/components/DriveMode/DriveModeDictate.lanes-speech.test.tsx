import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { speechArbiter, TIER_ANSWER, type ArbiterPlayer, type SpeechIntentInput } from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';
import { useReadingLevelStore } from '../../../../src/components/DriveMode/readingLevel';

/**
 * MULTI-LANE SPEECH (operator question, 2026-09-16):
 *
 *   "if I have two or three lanes open … will the other lanes also give their
 *    headlines when it's the time to give … each one at their turn?"
 *
 * Yes — every mounted lane runs its own answer reader and submits at its own
 * turn end, through the one shared voice. But the "one answer speaks once"
 * record (P16) is keyed by the WORDS, not by the lane, so two workers answering
 * with the same words collided: the first lane claimed the text and the second
 * lane's answer was silently dropped.
 *
 * The record must be per lane: two workers saying the same thing are two
 * events, while one lane's two producers (auto-speak and read-aloud) still
 * must never double-speak.
 */

vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: vi.fn(), sendPrompt: vi.fn() })),
}));

// The talker's digest seam: identical Headlines lines for both lanes, which is
// exactly the collision the operator asked about.
const digestMock = vi.fn(async () => ({ ok: true as const, digest: 'Done: LANE-ACK. Needs you: nothing.' }));
vi.mock('../../../../src/hooks/useTurnDigest', () => ({
  useTurnDigest: vi.fn(() => ({ requestDigest: digestMock })),
}));

vi.mock('../../../../src/hooks/useDictation', () => ({
  useDictation: vi.fn(() => ({
    state: 'idle',
    errorMessage: '',
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggle: vi.fn(),
  })),
}));

const sessionState = {
  isStreaming: false,
  messages: [] as Array<Record<string, unknown>>,
  streamingSessions: {} as Record<string, boolean>,
  sessionMessages: {} as Record<string, Array<Record<string, unknown>>>,
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
  Mic: () => <span />,
  Smartphone: () => <span />,
  Monitor: () => <span />,
  MicOff: () => <span />,
  Square: () => <span />,
  VolumeX: () => <span />,
  Check: () => <span />,
  X: () => <span />,
  Send: () => <span />,
  Car: () => <span />,
  Eye: () => <span />,
  EyeOff: () => <span />,
  Inbox: () => <span />,
}));

class StubAudioContext {
  state = 'running';
  resume = vi.fn(async () => {});
}

function makeBlockedPlayer() {
  const player: ArbiterPlayer = {
    playChunk: () => new Promise<void>(() => {}),
    setVolume: () => {},
    stopCurrent: () => {},
  };
  return player;
}

const LANE_A = '01a0-lane-a';
const LANE_B = '01a0-lane-b';
/** Short enough that Summary reads it verbatim (no digest round-trip). */
const SAME_WORDS = 'All checks passed and the build is green.';
const OTHER_WORDS = 'The migration is half applied and needs a decision from you.';

function laneSurface(sessionId: string, addressed: boolean): ReactElement {
  return (
    <DriveModeDictate
      sessionId={sessionId}
      sdkType="pi"
      modelName="test-model"
      sessionDisplayName={`Worker ${sessionId}`}
      onExit={vi.fn()}
      onAbort={vi.fn()}
      laneEnabled
      addressed={addressed}
    />
  );
}

function twoLanes(): ReactElement {
  return (
    <>
      {laneSurface(LANE_A, true)}
      {laneSurface(LANE_B, false)}
    </>
  );
}

/** One assistant message per lane, the turn running in both. */
function streaming(answers: Record<string, string>) {
  sessionState.streamingSessions = { [LANE_A]: true, [LANE_B]: true };
  sessionState.sessionMessages = Object.fromEntries(
    Object.entries(answers).map(([sessionId, text]) => [
      sessionId,
      [{ id: `m-${sessionId}`, role: 'assistant', content: text, timestamp: Date.now() }],
    ])
  );
}

/** Both turns finish at the same moment — each lane's own turn end. */
function finish() {
  sessionState.streamingSessions = { [LANE_A]: false, [LANE_B]: false };
}

function answerSubmissions(spy: MockInstance<[SpeechIntentInput], 'queued' | 'dropped'>): SpeechIntentInput[] {
  return spy.mock.calls.map(([input]) => input).filter((input) => input.tier === TIER_ANSWER);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.isStreaming = false;
  sessionState.messages = [];
  sessionState.streamingSessions = {};
  sessionState.sessionMessages = {};
  driveState.phase = 'dictate';
  vi.stubGlobal('AudioContext', StubAudioContext);
  spokenLedger.clear();
  speechArbiter.stopAll();
  speechArbiter.attachPlayer(makeBlockedPlayer());
  useReadingLevelStore.setState({ level: 'summary', levels: {} });
  digestMock.mockClear();
});

afterEach(() => {
  speechArbiter.stopAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('multi-lane answers speak per lane, at each lane’s own turn', () => {
  it('two lanes answering with the SAME words both speak', () => {
    const submit = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = render(twoLanes());

    streaming({ [LANE_A]: SAME_WORDS, [LANE_B]: SAME_WORDS });
    act(() => {
      rerender(twoLanes());
    });
    finish();
    act(() => {
      rerender(twoLanes());
    });

    const spoken = answerSubmissions(submit).map((input) => input.text);
    expect(spoken).toHaveLength(2);
    expect(spoken.every((text) => text === SAME_WORDS)).toBe(true);
  });

  it('two lanes answering differently both speak', () => {
    const submit = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = render(twoLanes());

    streaming({ [LANE_A]: SAME_WORDS, [LANE_B]: OTHER_WORDS });
    act(() => {
      rerender(twoLanes());
    });
    finish();
    act(() => {
      rerender(twoLanes());
    });

    const spoken = answerSubmissions(submit).map((input) => input.text);
    expect(spoken).toHaveLength(2);
    expect(spoken).toContain(SAME_WORDS);
    expect(spoken).toContain(OTHER_WORDS);
  });

  it('two lanes whose HEADLINES digests come back identical both speak', async () => {
    // The operator's own mode: "let's say I have only the headlines activated".
    // The digest is the talker's, so two workers can easily produce the SAME
    // headline line — and the second lane must still be read out.
    useReadingLevelStore.getState().setLevelFor(LANE_A, 'headlines');
    useReadingLevelStore.getState().setLevelFor(LANE_B, 'headlines');

    const submit = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = render(twoLanes());

    streaming({ [LANE_A]: OTHER_WORDS, [LANE_B]: OTHER_WORDS });
    act(() => {
      rerender(twoLanes());
    });
    finish();
    await act(async () => {
      rerender(twoLanes());
      await Promise.resolve();
    });

    const spoken = answerSubmissions(submit).map((input) => input.text);
    expect(digestMock).toHaveBeenCalledTimes(2);
    expect(spoken).toHaveLength(2);
    expect(spoken[0]).toBe(spoken[1]);
    expect(spoken[0]).toContain('LANE-ACK');
  });

  it('inside ONE lane the same words still never speak twice (P16 holds per lane)', () => {
    const submit = vi.spyOn(speechArbiter, 'submit');
    const oneLane = () => <>{laneSurface(LANE_A, true)}</>;
    const { rerender } = render(oneLane());

    streaming({ [LANE_A]: SAME_WORDS, [LANE_B]: OTHER_WORDS });
    act(() => {
      rerender(oneLane());
    });

    // The operator reads the answer aloud explicitly…
    fireEvent.click(screen.getByRole('button', { name: /read aloud/i }));
    const afterReadAloud = answerSubmissions(submit).length;
    expect(afterReadAloud).toBe(1);

    // …then the turn ends with the same words: the auto path must not repeat them.
    finish();
    act(() => {
      rerender(oneLane());
    });
    expect(answerSubmissions(submit)).toHaveLength(1);
  });
});

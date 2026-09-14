import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';

/**
 * P15 — the "Stop talker" control.
 *
 * The operator's own requirements, pinned here:
 *   1. stops the current speech;
 *   2. cancels the queue completely;
 *   3. does NOT come back to the cancelled item (never re-spoken);
 *   4. resumes normal behaviour on genuinely NEW input.
 *
 * Invariants that must not soften: stopping playback never gates capture,
 * and barge-in (duck-not-stop) is untouched.
 *
 * The RED-first failure is the missing control: these tests look for a
 * button named "Stop talker" and, before the implementation, it does not
 * exist. The guard-sufficiency test below (requirement 3) is deliberately
 * written against the raw arbiter so it can also prove, independently of
 * the button, whether the existing `spokenAnswerRef` guard is enough.
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

function dictate(text: string): void {
  if (!capture.transcript) {
    throw new Error('useDictation was never invoked — the transcript capture is unwired');
  }
  capture.transcript(text);
}
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

// --- Stores -------------------------------------------------------------------
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
  MicOff: () => <span data-testid="icon-micoff" />,
  Square: () => <span data-testid="icon-square" />,
  VolumeX: () => <span data-testid="icon-volumex" />,
  Check: () => <span data-testid="icon-check" />,
  X: () => <span data-testid="icon-x" />,
  Send: () => <span data-testid="icon-send" />,
  Car: () => <span data-testid="icon-car" />,
}));

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
const ANSWER_A = 'First answer that must never come back.';
const ANSWER_B = 'A genuinely new answer speaks.';

function renderSurface() {
  return render(
    <DriveModeDictate
      sessionId={WORKER}
      sdkType="pi"
      modelName="test-model"
      sessionDisplayName="Worker"
      onExit={vi.fn()}
      onAbort={vi.fn()}
    />
  );
}

let harness = makeBlockedPlayer();

/** Drive one completed worker answer through the real auto-speak effect. */
function finishWorkerAnswer(text: string, rerender: (ui: ReactElement) => void) {
  sessionState.isStreaming = true;
  sessionState.messages = [
    { id: 'm1', role: 'assistant', content: text, timestamp: Date.now() },
  ];
  act(() => {
    rerender(
      <DriveModeDictate
        sessionId={WORKER}
        sdkType="pi"
        modelName="test-model"
        sessionDisplayName="Worker"
        onExit={vi.fn()}
        onAbort={vi.fn()}
      />
    );
  });
  sessionState.isStreaming = false;
  act(() => {
    rerender(
      <DriveModeDictate
        sessionId={WORKER}
        sdkType="pi"
        modelName="test-model"
        sessionDisplayName="Worker"
        onExit={vi.fn()}
        onAbort={vi.fn()}
      />
    );
  });
}

function stopTalker() {
  fireEvent.click(screen.getByRole('button', { name: /^stop talker$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTalkerTurnBus();
  sendMock.mockReturnValue('sent');
  sendPromptMock.mockReturnValue('sent');
  capture.state = 'idle';
  capture.errorMessage = '';
  capture.transcript = null;
  sessionState.isStreaming = false;
  sessionState.messages = [];
  driveState.phase = 'dictate';
  spokenLedger.clear();
  speechArbiter.stopAll();
  harness = makeBlockedPlayer();
  speechArbiter.attachPlayer(harness.player);
});

afterEach(() => {
  speechArbiter.stopAll();
});

describe('P15 — Stop talker', () => {
  it('is visible while the talker is speaking and gone when it is idle', () => {
    speechArbiter.submit({ id: 'answer', tier: 3, text: 'A long playing answer.' });
    renderSurface();
    expect(screen.getByRole('button', { name: /^stop talker$/i })).toBeInTheDocument();

    act(() => {
      speechArbiter.stopAll();
    });
    expect(screen.queryByRole('button', { name: /^stop talker$/i })).not.toBeInTheDocument();
  });

  it('req 1+2 — stops the current speech AND clears the queue completely', () => {
    speechArbiter.submit({ id: 'answer-a', tier: 3, text: ANSWER_A });
    speechArbiter.submit({ id: 'answer-b', tier: 3, text: 'A queued follow-up answer.' });
    renderSurface();
    const before = speechArbiter.getState();
    expect(before.current?.id).toBe('answer-a');
    expect(before.queued.length).toBe(1);

    stopTalker();

    const after = speechArbiter.getState();
    expect(after.current).toBeNull();
    expect(after.queued).toEqual([]);
    expect(after.playing).toBe(false);
  });

  it('req 3 (guard sufficiency) — a stopped auto-spoken answer is not resubmitted on later renders', () => {
    const { rerender } = renderSurface();
    finishWorkerAnswer(ANSWER_A, rerender);
    expect(speechArbiter.getState().current?.id).toBe('answer-auto-0');
    const playedBefore = [...harness.played];

    // Stop through the primitive the feature consumes, then keep rendering
    // the surface exactly as the arbiter's own notify cycle would.
    act(() => {
      speechArbiter.stopAll();
    });
    for (let i = 0; i < 3; i++) {
      act(() => {
        rerender(
          <DriveModeDictate
            sessionId={WORKER}
            sdkType="pi"
            modelName="test-model"
            sessionDisplayName="Worker"
            onExit={vi.fn()}
            onAbort={vi.fn()}
          />
        );
      });
    }

    expect(speechArbiter.getState().current).toBeNull();
    expect(speechArbiter.getState().queued).toEqual([]);
    expect(harness.played).toEqual(playedBefore); // the cancelled answer never replayed
  });

  it('req 3 — the visible control also does not let the cancelled answer come back', () => {
    const { rerender } = renderSurface();
    finishWorkerAnswer(ANSWER_A, rerender);
    expect(speechArbiter.getState().current?.id).toBe('answer-auto-0');

    stopTalker();
    expect(speechArbiter.getState().current).toBeNull();

    // Unrelated renders after the stop must not resurrect it.
    for (let i = 0; i < 3; i++) {
      act(() => {
        rerender(
          <DriveModeDictate
            sessionId={WORKER}
            sdkType="pi"
            modelName="test-model"
            sessionDisplayName="Worker"
            onExit={vi.fn()}
            onAbort={vi.fn()}
          />
        );
      });
    }
    expect(speechArbiter.getState().current).toBeNull();
    expect(speechArbiter.getState().queued).toEqual([]);
    expect(harness.played).toEqual([ANSWER_A]);
  });

  it('req 4 — a genuinely new worker answer speaks after a stop', () => {
    const { rerender } = renderSurface();
    finishWorkerAnswer(ANSWER_A, rerender);
    stopTalker();
    expect(speechArbiter.getState().current).toBeNull();

    finishWorkerAnswer(ANSWER_B, rerender);

    expect(speechArbiter.getState().current).not.toBeNull();
    expect(speechArbiter.getState().current?.tier).toBe(3);
    expect(harness.played).toContain(ANSWER_B);
  });

  it('req 4 — a new relay from the talker speaks after a stop', () => {
    const { rerender } = renderSurface();
    finishWorkerAnswer(ANSWER_A, rerender);
    stopTalker();
    expect(speechArbiter.getState().current).toBeNull();

    act(() => {
      emitTalkerTurnResult({
        type: 'talker_turn_result',
        workerSessionId: WORKER,
        runtime: 'pi',
        reply: 'A brand new relay reply.',
        phase: 'released',
        released: {
          utteranceId: 42,
          text: 'deploy to staging',
          delivery: { outcome: 'delivered', mechanism: 'steer' },
        },
        cancelled: false,
      });
    });
    act(() => {
      rerender(
        <DriveModeDictate
          sessionId={WORKER}
          sdkType="pi"
          modelName="test-model"
          sessionDisplayName="Worker"
          onExit={vi.fn()}
          onAbort={vi.fn()}
        />
      );
    });

    expect(speechArbiter.getState().current).not.toBeNull();
    expect(harness.played).toContain('A brand new relay reply.');
  });

  it('INVARIANT — stopping the talker never gates capture', () => {
    const { rerender } = renderSurface();
    finishWorkerAnswer(ANSWER_A, rerender);

    stopTalker();

    // Capture is unconditional: an utterance after the stop is still recorded
    // and still reaches the talker transport.
    act(() => {
      dictate('words spoken right after the stop');
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: 'words spoken right after the stop' })
    );
  });

  it('INVARIANT — barge-in survives a stop: the floor stays held and capture works', () => {
    const { rerender } = renderSurface();
    finishWorkerAnswer(ANSWER_A, rerender);
    capture.state = 'recording'; // the operator has taken the floor (ducked)
    act(() => {
      rerender(
        <DriveModeDictate
          sessionId={WORKER}
          sdkType="pi"
          modelName="test-model"
          sessionDisplayName="Worker"
          onExit={vi.fn()}
          onAbort={vi.fn()}
        />
      );
    });
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);

    stopTalker();

    // Playback is gone, but stopping it is not the same as releasing the
    // floor — the operator still holds it and capture still works.
    expect(speechArbiter.getState().current).toBeNull();
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);
    act(() => {
      dictate('an utterance while still holding the floor after a stop');
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: 'an utterance while still holding the floor after a stop' })
    );
  });
});

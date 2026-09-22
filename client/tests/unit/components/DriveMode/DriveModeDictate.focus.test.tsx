import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import {
  speechArbiter,
  TIER_ANSWER,
  type ArbiterPlayer,
  type SpeechIntentInput,
} from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { emitTurnDigestResult, resetTurnDigestBus } from '../../../../src/lib/turnDigest';
import {
  resetReadingLevelStore,
  useReadingLevelStore,
} from '../../../../src/components/DriveMode/readingLevel';

/**
 * P18 package C, deliverable 2 — focus/hold, driven through the REAL surface.
 *
 * Focus is the concentrated-Q&A case: the operator is talking with the talker
 * and does NOT want the worker's answers read out. While focus is on:
 *   - the worker's answers are transcript-only (never spoken);
 *   - the talker holds the floor (its own replies still speak);
 *   - CAPTURE IS UNTOUCHED — focus gates playback, never the mic;
 *   - nothing that arrives is lost: every answer is held.
 * On exit, what arrived while focused is surfaced EXPLICITLY — visible in the
 * recap and spoken at the operator's reading level. "Exit focus" must never
 * mean "the thing that happened while you were away disappeared".
 *
 * The talker may suggest leaving focus, but only the operator presses: no
 * message from the server can switch the control.
 */

const sendMock = vi.fn();
const sendPromptMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock, sendPrompt: sendPromptMock })),
}));

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

/** Feed one dictated utterance through the captured hook callback. */
function dictate(text: string): void {
  if (!capture.transcript) throw new Error('useDictation was never invoked — capture is unwired');
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
  RefreshCw: () => <span data-testid="icon-refresh" />,
  Radio: () => <span data-testid="icon-radio" />,
  Keyboard: () => <span data-testid="icon-keyboard" />,
  AlertTriangle: () => <span data-testid="icon-warning" />,
  BellRing: () => <span data-testid="icon-bell" />,
  Clock: () => <span data-testid="icon-clock" />,
  HelpCircle: () => <span data-testid="icon-help" />,
}));

class StubAudioContext {
  state = 'running';
  resume = vi.fn(async () => {});
}

interface PendingChunk {
  chunk: string;
  resolve: () => void;
}

function makeControllablePlayer() {
  const played: string[] = [];
  const pending: PendingChunk[] = [];
  const player: ArbiterPlayer = {
    playChunk: (chunk: string) => {
      played.push(chunk);
      return new Promise<void>((resolve) => {
        pending.push({ chunk, resolve });
      });
    },
    setVolume: () => {},
    stopCurrent: () => {
      while (pending.length) pending.shift()?.resolve();
    },
  };
  const finishOne = () =>
    act(async () => {
      const next = pending.shift();
      next?.resolve();
    });
  return { player, played, pending, finishOne };
}

const WORKER = '/pi/worker.jsonl';
const ANSWER_A = 'The build is green and all checks passed.';
const ANSWER_B = 'The migration is staged, waiting on your approval.';
const LONG_ANSWER =
  'Alpha the build is green and the whole test suite passes on the first attempt this morning. ' +
  'Bravo the database migration is staged but the second half is still unwritten and untested. ' +
  'Charlie the public API contract changed and two client applications still need updating. ' +
  'Delta the flaky test turned out to be a real race condition and it is now properly fixed. ' +
  'Echo the documentation still describes the old endpoint and it needs a careful rewrite.';

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

let harness = makeControllablePlayer();

function renderSurface() {
  return render(surface() as ReactElement);
}

/** Drive one completed worker answer through the real auto-speak effect. */
async function finishWorkerAnswer(text: string, rerender: (ui: ReactElement) => void) {
  sessionState.isStreaming = true;
  sessionState.messages = [{ id: 'm1', role: 'assistant', content: text, timestamp: Date.now() }];
  act(() => {
    rerender(surface() as ReactElement);
  });
  sessionState.isStreaming = false;
  await act(async () => {
    rerender(surface() as ReactElement);
  });
}

function submissions(
  spy: MockInstance<[SpeechIntentInput], 'queued' | 'dropped'>
): SpeechIntentInput[] {
  return spy.mock.calls.map(([input]) => input);
}

function turnOnFocus() {
  act(() => {
    fireEvent.click(screen.getByTestId('focus-toggle'));
  });
}

function turnOffFocus() {
  act(() => {
    fireEvent.click(screen.getByTestId('focus-toggle'));
  });
}

function sentMessages(type: string): Array<Record<string, unknown>> {
  return sendMock.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message?.type === type);
}

function emitTalker(over: Record<string, unknown>) {
  act(() => {
    emitTalkerTurnResult({
      type: 'talker_turn_result',
      workerSessionId: WORKER,
      runtime: 'pi',
      reply: '',
      phase: 'answered',
      released: null,
      cancelled: false,
      ...over,
    });
  });
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
  resetTalkerTurnBus();
  resetTurnDigestBus();
  localStorage.clear();
  resetReadingLevelStore();
  harness = makeControllablePlayer();
  speechArbiter.attachPlayer(harness.player);
});

afterEach(() => {
  speechArbiter.stopAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('P18/2 req 1 — the control exists and only the operator presses it', () => {
  it('renders a focus control, off by default, and toggles on the operator’s press', () => {
    renderSurface();
    const toggle = screen.getByTestId('focus-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    turnOnFocus();
    expect(screen.getByTestId('focus-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('focus-status').textContent).toMatch(/focus is on/i);
    turnOffFocus();
    expect(screen.getByTestId('focus-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  it('nothing the talker says can switch focus — a suggestion is only a suggestion', () => {
    renderSurface();
    turnOnFocus();
    emitTalker({
      reply: 'This needs you — would you like to leave focus and have a look?',
      phase: 'answered',
      utteranceClass: 'question',
    });
    expect(screen.getByTestId('focus-toggle')).toHaveAttribute('aria-pressed', 'true');
    // And the suggestion still SPEAKS: the talker holds the floor while focused.
    expect(harness.played.join(' ')).toContain('leave focus');
  });

  it('the talker turn carries the focus flag so the talker can suggest (never switch)', () => {
    renderSurface();
    turnOnFocus();
    act(() => {
      dictate('explain the retry bug');
    });
    const turns = sentMessages('talker_turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].utterance).toBe('explain the retry bug');
    expect(turns[0].operatorFocus).toBe(true);
  });
});

describe('P18/2 req 2 — while focused, worker answers are transcript-only and spoken answers stop starting', () => {
  it('a worker answer that arrives while focused is NOT spoken', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    expect(submissions(submitSpy).filter((s) => s.tier === TIER_ANSWER)).toEqual([]);
    expect(harness.played).toEqual([]);
  });

  it('the same answer is read out normally when focus is off (nothing else changed)', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const rendered = renderSurface();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    expect(submissions(submitSpy).some((s) => s.tier === TIER_ANSWER && s.text === ANSWER_A)).toBe(true);
  });

  it('capture continues while focused — focus gates playback, never the mic', () => {
    renderSurface();
    turnOnFocus();
    expect(capture.toggle).toBeDefined();
    act(() => {
      dictate('what did the worker decide about the schema?');
    });
    const turns = sentMessages('talker_turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].utterance).toBe('what did the worker decide about the schema?');
    // Focus is still on: taking the floor changed nothing about it.
    expect(screen.getByTestId('focus-toggle')).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('P18/2 req 3 — on exit, what arrived while focused is surfaced explicitly', () => {
  it('the recap names what arrived and shows each answer verbatim', async () => {
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    await finishWorkerAnswer(ANSWER_B, (ui) => rendered.rerender(ui));

    expect(screen.queryByTestId('focus-recap')).toBeNull();
    turnOffFocus();

    const recap = screen.getByTestId('focus-recap');
    expect(recap.textContent).toMatch(/2 answers/i);
    const items = screen.getAllByTestId('focus-recap-item').map((n) => n.textContent ?? '');
    expect(items.join('\n')).toContain(ANSWER_A);
    expect(items.join('\n')).toContain(ANSWER_B);
  });

  it('the recap SPEAKS: a spoken announcement and then the answers, at the answer tier', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    turnOffFocus();

    const spoken = submissions(submitSpy).filter((s) => s.tier === TIER_ANSWER);
    expect(spoken.some((s) => /while you were focused/i.test(s.text ?? ''))).toBe(true);
    expect(spoken.some((s) => s.text === ANSWER_A)).toBe(true);
    // The announcement is heard first.
    expect(harness.played[0]).toMatch(/while you were focused/i);
  });

  it('a long held answer still goes through the reading level — it is digested, not read raw', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(LONG_ANSWER, (ui) => rendered.rerender(ui));
    turnOffFocus();

    const requests = sentMessages('talker_digest');
    expect(requests).toHaveLength(1);
    expect(String(requests[0].text)).toContain('Alpha the build is green');

    await act(async () => {
      emitTurnDigestResult({
        type: 'talker_digest_result',
        requestId: requests[0].requestId as string,
        workerSessionId: WORKER,
        kind: 'summary',
        digest: 'The build is green and the migration is staged.',
      });
    });
    const spoken = submissions(submitSpy).filter((s) => s.tier === TIER_ANSWER);
    expect(spoken.some((s) => (s.text ?? '').includes('In short: The build is green'))).toBe(true);
    expect(spoken.some((s) => s.text === LONG_ANSWER)).toBe(false);
  });

  it('an answer already heard (read aloud while focused) is still surfaced — but never spoken twice', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    // The operator pressed Read Aloud while focused: the words are heard and
    // the shared record knows it (P16).
    spokenLedger.mark(ANSWER_A);
    turnOffFocus();

    // Surfaced explicitly — nothing is lost to the recap…
    const items = screen.getAllByTestId('focus-recap-item').map((n) => n.textContent ?? '');
    expect(items.join('\n')).toContain(ANSWER_A);
    // …and not repeated in the ear.
    const answerSubmissions = submissions(submitSpy).filter((s) => s.tier === TIER_ANSWER && s.text === ANSWER_A);
    expect(answerSubmissions).toEqual([]);
  });

  it('leaving focus with nothing held says nothing and shows no recap', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    renderSurface();
    turnOnFocus();
    turnOffFocus();
    expect(screen.queryByTestId('focus-recap')).toBeNull();
    expect(submissions(submitSpy).filter((s) => s.tier === TIER_ANSWER)).toEqual([]);
    expect(harness.played).toEqual([]);
  });

  it('the recap can be dismissed, and dismissing it drops nothing else', async () => {
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    turnOffFocus();
    expect(screen.getByTestId('focus-recap')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId('focus-recap-dismiss'));
    });
    expect(screen.queryByTestId('focus-recap')).toBeNull();
  });

  it('an answer that arrives while focused is never silently lost — later arrivals add to the held set', async () => {
    const rendered = renderSurface();
    turnOnFocus();
    await finishWorkerAnswer(ANSWER_A, (ui) => rendered.rerender(ui));
    await finishWorkerAnswer(ANSWER_B, (ui) => rendered.rerender(ui));
    // The status keeps the count visible WHILE focused, so it is clear
    // something is waiting even before exit.
    expect(screen.getByTestId('focus-status').textContent).toMatch(/2/);
    turnOffFocus();
    const items = screen.getAllByTestId('focus-recap-item').map((n) => n.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items.join('\n')).toContain(ANSWER_A);
    expect(items.join('\n')).toContain(ANSWER_B);
  });
});

describe('P18/2 req 4 — the talker holds the floor, and the reading level still applies', () => {
  it('a talker reply speaks while focused (only the worker’s answers are held)', () => {
    renderSurface();
    turnOnFocus();
    emitTalker({ reply: 'The schema change is staged, not applied.', phase: 'answered', utteranceClass: 'question' });
    expect(harness.played).toContain('The schema change is staged, not applied.');
  });

  it('the reading level control keeps working while focused', () => {
    renderSurface();
    turnOnFocus();
    act(() => {
      useReadingLevelStore.getState().setLevel('headlines');
    });
    expect(screen.getByTestId('reading-level-headlines')).toHaveAttribute('aria-pressed', 'true');
  });
});

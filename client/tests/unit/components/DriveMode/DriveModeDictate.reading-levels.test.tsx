import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import {
  speechArbiter,
  TIER_ANSWER,
  TIER_CHATTER,
  type ArbiterPlayer,
  type SpeechIntentInput,
} from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';
import { emitTurnDigestResult, resetTurnDigestBus } from '../../../../src/lib/turnDigest';
import {
  resetReadingLevelStore,
  useReadingLevelStore,
} from '../../../../src/components/DriveMode/readingLevel';

/**
 * P17 package A — the reading levels, driven through the REAL surface.
 *
 * The reframe these tests exist to protect: the verbosity was never the talker
 * being chatty. The auto-speak path read the worker's final answer VERBATIM,
 * with no talker involvement at all — so a reading level is putting the talker
 * into the reading path where there was none.
 *
 * Four behaviours are pinned RED-first here, exactly as the brief asks:
 *   req 1 — a short turn speaks verbatim even in Summary mode;
 *   req 2 — a long turn is digested, not read raw;
 *   req 3 — a mid-speech flip stops at the next chunk boundary, digests the
 *           REMAINDER, and never repeats what was already heard;
 *   req 4 — the indicator reflects the active level.
 *
 * Everything else (dedup, stop-talker, read-aloud, the floor) is pinned by the
 * P15/P16 suites, which these tests must not disturb.
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

class StubAudioContext {
  state = 'running';
  resume = vi.fn(async () => {});
}

// --- A player the test can advance one chunk at a time ----------------------
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
  /** Let the in-flight chunk finish (the arbiter's only scheduling point).
   *  Async: the arbiter advances to the next chunk in a microtask. */
  const finishOne = () =>
    act(async () => {
      const next = pending.shift();
      next?.resolve();
    });
  return { player, played, pending, finishOne };
}

const WORKER = '/pi/worker.jsonl';
const SHORT_ANSWER = 'The build is green and all checks passed.';

/**
 * Eight identifiable sentences, comfortably over the 400-character short-turn
 * threshold, so chunking gives one chunk per sentence and the test can name
 * exactly which part the operator has heard.
 */
const SENTENCES = [
  'Alpha the build is green and the whole test suite passes on the first attempt this morning.',
  'Bravo the database migration is staged but the second half is still unwritten and untested.',
  'Charlie the public API contract changed and two client applications still need updating.',
  'Delta the flaky test turned out to be a real race condition and it is now properly fixed.',
  'Echo the documentation still describes the old endpoint and it needs a careful rewrite.',
  'Foxtrot the production deployment is waiting for your explicit approval before it runs.',
  'Golf the benchmark numbers improved by roughly nine percent after the optimisation.',
  'Hotel nothing else needs your attention for the rest of this working afternoon.',
];
const LONG_ANSWER = SENTENCES.join(' ');

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

/** Drive one completed worker answer through the real auto-speak effect.
 *  Awaited because a digest plan is a round trip: the surface asks the talker
 *  and speaks when the answer arrives (the verbatim path stays synchronous). */
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

function answerSubmissions(
  spy: MockInstance<[SpeechIntentInput], 'queued' | 'dropped'>
): SpeechIntentInput[] {
  return spy.mock.calls.map(([input]) => input).filter((input) => input.tier === TIER_ANSWER);
}

function sentMessages(type: string): Array<Record<string, unknown>> {
  return sendMock.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message?.type === type);
}

function lastDigestRequest(): Record<string, unknown> {
  const requests = sentMessages('talker_digest');
  expect(requests.length).toBeGreaterThan(0);
  return requests[requests.length - 1];
}

async function deliverDigest(request: Record<string, unknown>, digest: string, kind = 'summary') {
  await act(async () => {
    emitTurnDigestResult({
      type: 'talker_digest_result',
      requestId: request.requestId as string,
      workerSessionId: WORKER,
      kind: kind as 'summary' | 'headlines',
      digest,
    });
  });
}

function setLevel(level: 'verbatim' | 'summary' | 'headlines') {
  act(() => {
    useReadingLevelStore.getState().setLevel(level);
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

describe('P17 req 1 — short turns speak verbatim, even in Summary mode', () => {
  it('speaks a short turn word for word and does not spend a model call on it', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    await finishWorkerAnswer(SHORT_ANSWER, rerender);

    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain(SHORT_ANSWER);
    expect(sentMessages('talker_digest')).toHaveLength(0);
  });
});

describe('P17 req 2 — a long turn is digested instead of read raw', () => {
  it('asks the talker for a digest and speaks that, not the worker’s words', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    await finishWorkerAnswer(LONG_ANSWER, rerender);

    // Nothing raw was read: the digest is what the operator will hear.
    const beforeDigest = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(beforeDigest).not.toContain(LONG_ANSWER);

    const request = lastDigestRequest();
    expect(request.kind).toBe('summary');
    expect(request.text).toBe(LONG_ANSWER);
    expect(request.workerSessionId).toBe(WORKER);

    await deliverDigest(request, 'the build is green and the deploy waits on you');

    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain('In short: the build is green and the deploy waits on you');
    expect(submitted).not.toContain(LONG_ANSWER);
  });

  it('speaks the digest at tier 3 — the answer, condensed, never chatter', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    await finishWorkerAnswer(LONG_ANSWER, rerender);
    await deliverDigest(lastDigestRequest(), 'a digest');

    const tiers = submitSpy.mock.calls
      .map(([input]) => input)
      .filter((input) => (input.text ?? '').includes('a digest'))
      .map((input) => input.tier);
    expect(tiers).toEqual([TIER_ANSWER]);
    expect(tiers).not.toContain(TIER_CHATTER);
  });

  it('never routes the digest request through the operator channel (the gate only carries the operator’s words)', async () => {
    const { rerender } = renderSurface();

    setLevel('summary');
    await finishWorkerAnswer(LONG_ANSWER, rerender);
    await deliverDigest(lastDigestRequest(), 'a digest');

    expect(sentMessages('talker_turn')).toHaveLength(0);
  });

  it('falls back to reading the turn verbatim when the digest cannot be produced — nothing is lost', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    sendMock.mockReturnValue('failed');
    await finishWorkerAnswer(LONG_ANSWER, rerender);

    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain(LONG_ANSWER);
    expect(screen.getByTestId('reading-level-fallback')).toHaveTextContent(/read in full/i);
  });
});

describe('P17 req 3 — Headlines means the one line, and it is exempt from the threshold', () => {
  it('digests even a short turn into the one line, with no summary marker', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('headlines');
    await finishWorkerAnswer(SHORT_ANSWER, rerender);

    const request = lastDigestRequest();
    expect(request.kind).toBe('headlines');
    await deliverDigest(request, 'Done: the build is green. Needs you: nothing.', 'headlines');

    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain('Done: the build is green. Needs you: nothing.');
    expect(submitted).not.toContain(SHORT_ANSWER);
    expect(submitted).not.toContain('In short: Done: the build is green. Needs you: nothing.');
  });
});

describe('P17 req 4 — the indicator reflects the active level', () => {
  it('shows the active level and follows the operator’s change', () => {
    renderSurface();

    expect(screen.getByTestId('reading-level-indicator')).toHaveTextContent('Reading level: Summary');

    fireEvent.click(screen.getByTestId('reading-level-verbatim'));
    expect(screen.getByTestId('reading-level-indicator')).toHaveTextContent('Reading level: Verbatim');

    fireEvent.click(screen.getByTestId('reading-level-headlines'));
    expect(screen.getByTestId('reading-level-indicator')).toHaveTextContent('Reading level: Headlines');
  });

  it('applies the chosen level to the next turn', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    fireEvent.click(screen.getByTestId('reading-level-verbatim'));
    await finishWorkerAnswer(LONG_ANSWER, rerender);

    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain(LONG_ANSWER);
    expect(sentMessages('talker_digest')).toHaveLength(0);
  });
});

describe('P17 req 5 — the mid-answer flip is immediate and bounded', () => {
  it('stops at the next chunk boundary, digests only the unplayed remainder, and never repeats what was heard', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('verbatim');
    await finishWorkerAnswer(LONG_ANSWER, rerender);

    // The worker's words are being read: chunk 0 (Alpha) has finished, chunk 1
    // (Bravo) is in flight.
    expect(harness.played).toEqual([SENTENCES[0]]);
    await harness.finishOne();
    expect(harness.played).toEqual([SENTENCES[0], SENTENCES[1]]);

    const beforeFlip = answerSubmissions(submitSpy).length;

    // The operator realises mid-answer that they want the short version.
    fireEvent.click(screen.getByTestId('reading-level-summary'));

    const request = lastDigestRequest();
    expect(request.kind).toBe('summary');
    // Only the unplayed remainder is digested…
    expect(request.text).toContain('Charlie');
    expect(request.text).not.toContain('Alpha');
    expect(request.text).not.toContain('Bravo');
    // …and the talker is told what the operator has already heard, so the
    // digest cannot repeat it.
    expect(String(request.spokenPrefix)).toContain('Alpha');
    expect(String(request.spokenPrefix)).toContain('Bravo');

    // The current item stops at the boundary — never mid-chunk, never mid-word.
    await harness.finishOne();
    expect(harness.played).toEqual([SENTENCES[0], SENTENCES[1]]);
    expect(speechArbiter.getState().current).toBeNull();

    await deliverDigest(request, 'the rest is staged and the deploy waits on you');

    const submitted = answerSubmissions(submitSpy)
      .slice(beforeFlip)
      .map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain('In short: the rest is staged and the deploy waits on you');
    // What was already heard is never spoken again.
    expect(submitted.join(' | ')).not.toContain('Alpha');
    expect(submitted.join(' | ')).not.toContain('Bravo');
    expect(harness.played.join(' | ')).not.toContain('Charlie');
  });

  it('speaks the remainder verbatim when it is short — a digest of two clauses is pure overhead', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    // A long first sentence, then a short tail: flipping halfway leaves little.
    const head = `Alpha ${'the build is green and the suite passes '.repeat(5)}so far.`;
    const answer = `${head} Bravo the deploy waits on you.`;
    setLevel('verbatim');
    await finishWorkerAnswer(answer, rerender);

    // Flip while the first (long) sentence is still in flight: the remainder is
    // the short tail alone.
    fireEvent.click(screen.getByTestId('reading-level-summary'));
    await harness.finishOne();

    // No model call for a remainder this short: it is simply read out.
    expect(sentMessages('talker_digest')).toHaveLength(0);
    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted.join(' | ')).toContain('Bravo the deploy waits on you');
  });

  it('a flip while a DIGEST is playing re-extracts the whole turn — none of the worker’s words were read out', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    await finishWorkerAnswer(LONG_ANSWER, rerender);
    await deliverDigest(lastDigestRequest(), 'The build is green and the deploy waits on you.');

    // The DIGEST is what is playing (one chunk of the summary, not the worker's
    // sentences). Flipping to Headlines must not treat a digest chunk index as a
    // position in the worker's text.
    const digestRequest = lastDigestRequest();
    await deliverDigest(digestRequest, 'The build is green and the deploy waits on you.');

    fireEvent.click(screen.getByTestId('reading-level-headlines'));

    const requests = sentMessages('talker_digest');
    const flipRequest = requests[requests.length - 1];
    expect(flipRequest.kind).toBe('headlines');
    expect(flipRequest.text).toBe(LONG_ANSWER);
    expect(flipRequest.spokenPrefix).toBeUndefined();

    // The digest in flight stops at its own chunk boundary before anything new
    // is spoken, exactly like a raw read does.
    await harness.finishOne();
    await deliverDigest(flipRequest, 'Done: the build is green. Needs you: the deploy.', 'headlines');

    const submitted = answerSubmissions(submitSpy).map((i) => i.text ?? i.chunks?.join(' '));
    expect(submitted).toContain('Done: the build is green. Needs you: the deploy.');
  });

  it('a flip to Verbatim while a digest plays reads the whole turn — an explicit request for the full text wins', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    await finishWorkerAnswer(LONG_ANSWER, rerender);
    await deliverDigest(lastDigestRequest(), 'The build is green and the deploy waits on you.');
    // The digest (a condensation of the whole turn) is what is playing.
    const beforeFlip = answerSubmissions(submitSpy).length;

    fireEvent.click(screen.getByTestId('reading-level-verbatim'));
    await harness.finishOne();

    const afterFlip = answerSubmissions(submitSpy)
      .slice(beforeFlip)
      .map((i) => i.text ?? i.chunks?.join(' '));
    // None of the worker's WORDS had been read out, so the whole turn is still
    // unplayed — and asking for Verbatim is explicit.
    expect(afterFlip).toEqual([LONG_ANSWER]);
  });

  it('a flip when every chunk has already been heard stops and says nothing', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('verbatim');
    await finishWorkerAnswer(LONG_ANSWER, rerender);
    // Advance to the last chunk: everything before it has been heard.
    for (let i = 0; i < SENTENCES.length - 1; i += 1) {
      await harness.finishOne();
    }
    const beforeFlip = answerSubmissions(submitSpy).length;

    fireEvent.click(screen.getByTestId('reading-level-headlines'));
    await harness.finishOne();

    // Nothing left unplayed: no digest is requested and nothing is re-spoken.
    expect(sentMessages('talker_digest')).toHaveLength(0);
    expect(answerSubmissions(submitSpy)).toHaveLength(beforeFlip);
    expect(speechArbiter.getState().current).toBeNull();
  });

  it('leaves a different answer alone — the flip is about the item in flight, not future turns', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('verbatim');
    await finishWorkerAnswer(SHORT_ANSWER, rerender);
    await harness.finishOne();
    await harness.finishOne();

    const before = answerSubmissions(submitSpy).length;
    fireEvent.click(screen.getByTestId('reading-level-headlines'));
    expect(answerSubmissions(submitSpy)).toHaveLength(before);
    expect(sentMessages('talker_digest')).toHaveLength(0);
  });
});

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
import { emitTurnDigestResult, resetTurnDigestBus } from '../../../../src/lib/turnDigest';
import {
  resetReadingLevelStore,
  useReadingLevelStore,
} from '../../../../src/components/DriveMode/readingLevel';

/**
 * P19 (package B) — the whole-turn digest input, driven through the REAL surface.
 *
 * The gap this closes: the auto-speak path planned on the LAST assistant
 * message, so detail the worker emitted MID-turn was reachable only by clicking
 * read-aloud. A summariser can read the whole turn, interim included — so the
 * digest input becomes the turn's assistant output, and mid-turn detail
 * surfaces without the operator asking.
 *
 * The behaviours pinned RED-first here, exactly as the brief asks:
 *   req 1 — mid-turn detail reaches the digest (and is spoken in it);
 *   req 2 — no duplication across successive turns, including successive
 *           UNPROMPTED runs (goal loops / watch wakes) where no operator
 *           message separates the turns — the spoken ledger alone cannot
 *           cover that, because two turns produce different strings;
 *   req 3 — Headlines still yields one line for a long multi-message turn;
 *   req 4 — the short-turn threshold applies to the TURN: a long turn is
 *           digested even when its last message is short; a short turn is
 *           still read verbatim, now including its interim messages;
 *   req 5 — Verbatim reads the turn faithfully (the recorded decision:
 *           the whole turn, interim included — otherwise the faithful level
 *           would surface less than Summary, which is incoherent);
 *   req 6 — focus/hold (P18) still works over whole-turn answers, and two
 *           held turns never overlap in the recap.
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
  const finishOne = () =>
    act(async () => {
      const next = pending.shift();
      next?.resolve();
    });
  return { player, played, pending, finishOne };
}

const WORKER = '/pi/worker.jsonl';

const USER_PROMPT = { id: 'u0', role: 'user', content: 'Please ship the release', timestamp: Date.now() };

/** Long interim output — carries the small detail (the staging token) that
 *  today is reachable only by clicking read-aloud. Long enough that the whole
 *  turn clears the short-turn verbatim threshold. */
const INTERIM_DETAIL = 'the staging token is pine-4471';
const INTERIM_MESSAGE = {
  id: 'a1',
  role: 'assistant',
  content:
    `Working through the release checklist now. ${INTERIM_DETAIL} and the migration is half applied. ` +
    'I also rebased the release branch onto main so the conflict resolution from yesterday is preserved, ' +
    'and the smoke suite is running against the canary deployment this minute before I tag anything. ' +
    'The changelog has been regenerated from the merged pull requests and the version number has been ' +
    'bumped in both package manifests, while the docker image builds in the background without errors.',
  timestamp: Date.now(),
};
const FINAL_TEXT = 'Done. The release is tagged.';
const FINAL_MESSAGE = { id: 'a2', role: 'assistant', content: FINAL_TEXT, timestamp: Date.now() };

/** First of two unprompted runs (no operator message between them). */
const RUN_ONE_MARKER = 'the first run rebased the deploy notes onto the new staging branch tonight';
const RUN_ONE_MESSAGE = {
  id: 'r1a',
  role: 'assistant',
  content:
    `First run report. ${RUN_ONE_MARKER} and the nightly backup finished cleanly at two in the morning, ` +
    'which the rota spreadsheet now records without any manual copying on your part. The retention sweep ' +
    'also archived the stale session directories from last month and the disk headroom on the build volume ' +
    'is back above twenty percent, so nothing needs your attention there.',
  timestamp: Date.now(),
};
/** Second of two unprompted runs. */
const RUN_TWO_MARKER = 'the second run rotated the api credentials for the staging cluster safely';
const RUN_TWO_MESSAGE = {
  id: 'r2a',
  role: 'assistant',
  content:
    `Second run report. ${RUN_TWO_MARKER} and the old credentials now fail closed in every environment, ` +
    'with the rotation recorded in the audit log under the maintenance window you approved. The dependent ' +
    'webhooks were re-signed with the new secret and their smoke checks all answered within a second, so ' +
    'the integration partners should not have noticed anything at all.',
  timestamp: Date.now(),
};

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

/** Drive one completed worker run through the real auto-speak effect. The
 *  messages for the run must already be in the store. */
async function runToCompletion(rerender: (ui: ReactElement) => void) {
  sessionState.isStreaming = true;
  await act(async () => {
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

function submittedTexts(spy: MockInstance<[SpeechIntentInput], 'queued' | 'dropped'>): string[] {
  return answerSubmissions(spy).map((i) => i.text ?? i.chunks?.join(' ') ?? '');
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

describe('P19 req 1 — mid-turn detail surfaces in the digest without being asked for', () => {
  it('asks the talker to digest the WHOLE turn: interim updates included, not just the last message', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    sessionState.messages = [USER_PROMPT, INTERIM_MESSAGE, FINAL_MESSAGE];
    await runToCompletion(rerender);

    const request = lastDigestRequest();
    expect(request.kind).toBe('summary');
    // The interim detail reaches the digest input — this is the gap P19 closes.
    expect(String(request.text)).toContain(INTERIM_DETAIL);
    // …and the final message is still part of it.
    expect(String(request.text)).toContain(FINAL_TEXT);
    // The operator's words are never part of the digest input.
    expect(String(request.text)).not.toContain('Please ship the release');

    // And what the operator HEARS carries the mid-turn detail forward.
    await deliverDigest(request, 'the staging token was pine-4471 and the release is now tagged');
    const texts = submittedTexts(submitSpy);
    expect(texts.some((t) => t.includes('pine-4471'))).toBe(true);
  });

  it('still digests at tier 3 and never routes the turn through the operator channel', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    sessionState.messages = [USER_PROMPT, INTERIM_MESSAGE, FINAL_MESSAGE];
    await runToCompletion(rerender);
    await deliverDigest(lastDigestRequest(), 'a whole-turn digest');

    const digestSubmissions = submitSpy.mock.calls
      .map(([input]) => input)
      .filter((input) => (input.text ?? '').includes('a whole-turn digest'));
    expect(digestSubmissions).toHaveLength(1);
    expect(digestSubmissions[0].tier).toBe(TIER_ANSWER);
    expect(sentMessages('talker_turn')).toHaveLength(0);
  });
});

describe('P19 req 2 — no duplication across successive turns', () => {
  it('a second turn after the operator speaks digests only the new output', async () => {
    const { rerender } = renderSurface();

    setLevel('summary');
    sessionState.messages = [USER_PROMPT, RUN_ONE_MESSAGE];
    await runToCompletion(rerender);
    await deliverDigest(lastDigestRequest(), 'first run digest');

    // The operator speaks again; the worker answers again.
    const secondUser = { ...USER_PROMPT, id: 'u1', content: 'and the backup rota?' };
    sessionState.messages = [USER_PROMPT, RUN_ONE_MESSAGE, secondUser, RUN_TWO_MESSAGE];
    await runToCompletion(rerender);

    const requests = sentMessages('talker_digest');
    const second = requests[requests.length - 1];
    expect(String(second.text)).toContain(RUN_TWO_MARKER);
    expect(String(second.text)).not.toContain(RUN_ONE_MARKER);
  });

  it('successive UNPROMPTED runs (no operator message between) do not re-digest what was already spoken', async () => {
    const { rerender } = renderSurface();

    setLevel('summary');
    sessionState.messages = [USER_PROMPT, RUN_ONE_MESSAGE];
    await runToCompletion(rerender);
    await deliverDigest(lastDigestRequest(), 'first run digest');

    // A goal-loop / watch-wake continuation: new worker output, no new user message.
    sessionState.messages = [USER_PROMPT, RUN_ONE_MESSAGE, RUN_TWO_MESSAGE];
    await runToCompletion(rerender);

    const requests = sentMessages('talker_digest');
    const second = requests[requests.length - 1];
    expect(String(second.text)).toContain(RUN_TWO_MARKER);
    // The spoken ledger cannot provide this (the strings differ) — the turn
    // scope itself must exclude what was already spoken.
    expect(String(second.text)).not.toContain(RUN_ONE_MARKER);
  });

  it('successive unprompted runs under focus hold do not overlap in the recap either', async () => {
    const { rerender } = renderSurface();

    setLevel('summary');
    fireEvent.click(screen.getByTestId('focus-toggle'));
    sessionState.messages = [USER_PROMPT, RUN_ONE_MESSAGE];
    await runToCompletion(rerender);
    sessionState.messages = [USER_PROMPT, RUN_ONE_MESSAGE, RUN_TWO_MESSAGE];
    await runToCompletion(rerender);

    fireEvent.click(screen.getByTestId('focus-toggle'));
    const items = screen.getAllByTestId('focus-recap-item').map((n) => n.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items[0]).toContain(RUN_ONE_MARKER);
    expect(items[1]).toContain(RUN_TWO_MARKER);
    expect(items[1]).not.toContain(RUN_ONE_MARKER);

    // Settle the recap's digest round trips INSIDE this test: an unsettled
    // talker_digest wait would otherwise be failed by the next test's
    // resetTurnDigestBus(), and its fallback chain would run against the next
    // test's mocks.
    await deliverDigest(lastDigestRequest(), 'first run recap digest');
    await act(async () => {
      resetTurnDigestBus();
    });
  });
});

describe('P19 req 3 — Headlines still yields one line for a long multi-message turn', () => {
  it('extracts the one line from the whole turn — interim included, still not a summary', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('headlines');
    sessionState.messages = [USER_PROMPT, INTERIM_MESSAGE, FINAL_MESSAGE];
    await runToCompletion(rerender);

    const requests = sentMessages('talker_digest');
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.kind).toBe('headlines');
    expect(String(request.text)).toContain(INTERIM_DETAIL);

    await deliverDigest(request, 'Done: the release is tagged. Needs you: nothing.', 'headlines');

    const texts = submittedTexts(submitSpy);
    const headlineSubmissions = texts.filter((t) => t.includes('Done: the release is tagged'));
    expect(headlineSubmissions).toHaveLength(1);
    // The Headlines shape is its own marker — never wrapped in the summary prefix.
    expect(headlineSubmissions[0]).toBe('Done: the release is tagged. Needs you: nothing.');
  });
});

describe('P19 req 4 — the short-turn threshold applies to the turn, and says which rule wins', () => {
  it('a LONG turn is digested even though its LAST message is short — the turn rule wins in Summary', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    sessionState.messages = [USER_PROMPT, INTERIM_MESSAGE, FINAL_MESSAGE];
    await runToCompletion(rerender);

    // The turn as a whole is long, so summarising it is the point: the interim
    // detail is condensed, not spoken line by line.
    const requests = sentMessages('talker_digest');
    expect(requests).toHaveLength(1);
    expect(requests[0].kind).toBe('summary');
    // The interim text was never read raw while the digest was being fetched.
    expect(submittedTexts(submitSpy).join(' | ')).not.toContain(INTERIM_DETAIL);
  });

  it('a SHORT whole turn is still read verbatim — now including its interim messages', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('summary');
    sessionState.messages = [
      USER_PROMPT,
      { id: 'a1', role: 'assistant', content: 'Checking the tag now.', timestamp: Date.now() },
      { id: 'a2', role: 'assistant', content: 'Done.', timestamp: Date.now() },
    ];
    await runToCompletion(rerender);

    // Under the threshold there is nothing to condense: no model call, and the
    // turn is read faithfully — both messages, word for word.
    expect(sentMessages('talker_digest')).toHaveLength(0);
    const all = submittedTexts(submitSpy).join(' | ');
    expect(all).toContain('Checking the tag now.');
    expect(all).toContain('Done.');
  });
});

describe('P19 req 5 — Verbatim reads the turn faithfully (recorded decision)', () => {
  it('reads the whole turn word for word, interim included, with no model call', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('verbatim');
    sessionState.messages = [USER_PROMPT, INTERIM_MESSAGE, FINAL_MESSAGE];
    await runToCompletion(rerender);

    expect(sentMessages('talker_digest')).toHaveLength(0);
    const read = submittedTexts(submitSpy).find((t) => t.includes(FINAL_TEXT));
    expect(read).toBeDefined();
    expect(read).toContain(INTERIM_DETAIL);
    expect(read).toContain(FINAL_TEXT);
  });
});

describe('P19 req 6 — the mid-answer flip still digests only the unplayed remainder of a multi-message turn', () => {
  it('after the first interim sentences are heard, the flip covers only what follows — never the heard prefix', async () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    const { rerender } = renderSurface();

    setLevel('verbatim');
    sessionState.messages = [USER_PROMPT, INTERIM_MESSAGE, FINAL_MESSAGE];
    await runToCompletion(rerender);

    // The whole turn is being read raw: the first sentence has played and the
    // second is in flight.
    expect(harness.played).toHaveLength(1);
    await harness.finishOne();
    expect(harness.played).toHaveLength(2);

    const beforeFlip = answerSubmissions(submitSpy).length;
    fireEvent.click(screen.getByTestId('reading-level-summary'));

    const request = lastDigestRequest();
    expect(request.kind).toBe('summary');
    // Only the unplayed remainder of the WHOLE TURN is digested: the final
    // message is still ahead, the heard sentences are not re-sent.
    expect(String(request.text)).toContain(FINAL_TEXT);
    expect(String(request.text)).not.toContain('Working through the release checklist now');
    expect(String(request.text)).not.toContain(INTERIM_DETAIL);
    // The talker is told what has already been heard, so it cannot repeat it.
    expect(String(request.spokenPrefix)).toContain('Working through the release checklist now');
    expect(String(request.spokenPrefix)).toContain(INTERIM_DETAIL);

    // The in-flight chunk finishes at the boundary — never mid-word.
    await harness.finishOne();
    await deliverDigest(request, 'the rest went fine and the release is tagged');

    const afterFlip = submittedTexts(submitSpy).slice(beforeFlip);
    expect(afterFlip.some((t) => t.includes('In short: the rest went fine and the release is tagged'))).toBe(true);
    // Nothing already heard is spoken again.
    expect(afterFlip.join(' | ')).not.toContain(INTERIM_DETAIL);
    expect(harness.played.join(' | ')).not.toContain('Done. The release is tagged.');
  });
});

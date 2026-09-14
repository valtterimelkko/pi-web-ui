import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';
import { resetReadingLevelStore } from '../../../../src/components/DriveMode/readingLevel';

/**
 * P26 — the surface teaches the contract where the operator speaks.
 *
 * The operator reported being lost about how to talk to the talker: what
 * happens to their sentence, whether the worker hears about them. The fix is
 * display and teaching only:
 *   req 1 — one short line by the mic stating the contract (words passed on,
 *           not re-invented; tidied when they ramble; the worker never knows
 *           the lane exists);
 *   req 2 — a CLEANED proposal reaches the card as "tidied", with the exact
 *           outgoing text and what was removed, driven through the REAL
 *           surface;
 *   req 3 — an uncleaned proposal (old server, no fields) keeps the
 *           exact-words claim — the card must not cry wolf.
 */

// --- Transport: capture outgoing socket messages ----------------------------
const sendMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock })),
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
  Eye: () => <span data-testid="icon-eye" />,
  EyeOff: () => <span data-testid="icon-eyeoff" />,
  Inbox: () => <span data-testid="icon-inbox" />,
}));

class StubAudioContext {
  state = 'running';
  resume = vi.fn(async () => {});
}

function makeSilentPlayer(): ArbiterPlayer {
  return {
    playChunk: () => new Promise<void>(() => {}),
    setVolume: () => {},
    stopCurrent: () => {},
  };
}

const WORKER = '/pi/worker.jsonl';

const RAW_WORDS = 'okay um ask the worker if it has enough materials to start';
const TIDIED_TEXT = 'if it has enough materials to start';
const REMOVED_TEXT = 'okay, um, ask the worker';

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

function renderSurface() {
  return render(surface() as ReactElement);
}

/** Feed one dictated utterance through the real capture → talker pipeline. */
function dictate(text: string): void {
  if (!capture.transcript) throw new Error('useDictation was never invoked');
  act(() => {
    capture.transcript?.(text);
  });
}

function propose(over: Record<string, unknown>): void {
  act(() => {
    emitTalkerTurnResult({
      type: 'talker_turn_result',
      workerSessionId: WORKER,
      runtime: 'pi',
      reply: 'Shall I send that?',
      phase: 'proposed',
      released: null,
      cancelled: false,
      ...over,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockReturnValue('sent');
  resetTalkerTurnBus();
  spokenLedger.clear();
  speechArbiter.stopAll();
  speechArbiter.attachPlayer(makeSilentPlayer());
  localStorage.clear();
  resetReadingLevelStore();
  capture.state = 'idle';
  capture.errorMessage = '';
  capture.transcript = null;
  sessionState.isStreaming = false;
  sessionState.messages = [];
  driveState.phase = 'dictate';
  vi.stubGlobal('AudioContext', StubAudioContext);
});

describe('P26 req 1 — the contract is taught where the operator speaks', () => {
  it('one short line by the mic states all three facts', () => {
    renderSurface();
    const hint = screen.getByTestId('voice-contract-hint');
    // Fact 1: the words are passed on (not re-invented).
    expect(hint.textContent).toMatch(/passed on/);
    expect(hint.textContent).toMatch(/never rewritten/);
    // Fact 2: they may be tidied.
    expect(hint.textContent).toMatch(/tidied/);
    // Fact 3: the worker does not know this lane exists.
    expect(hint.textContent).toMatch(/worker never knows/);
  });
});

describe('P26 req 2 — a cleaned proposal reaches the card as tidied, end to end', () => {
  it('the card says tidied, shows the exact outgoing text and the removal', () => {
    renderSurface();
    dictate(RAW_WORDS);
    propose({
      proposal: { text: TIDIED_TEXT, cleaned: true, removed: REMOVED_TEXT },
    });
    expect(screen.getByText('Ready to send — your words, tidied:')).toBeTruthy();
    expect(screen.getByTestId('pending-proposal-text').textContent).toBe(TIDIED_TEXT);
    expect(screen.getByTestId('relay-removed-text').textContent).toBe(REMOVED_TEXT);
  });
});

describe('P26 req 3 — an uncleaned proposal keeps the exact-words claim (no crying wolf)', () => {
  it('an old server result (no proposal fields) shows the verbatim card with no disclosure', () => {
    renderSurface();
    dictate(RAW_WORDS);
    propose({});
    expect(screen.getByText('Ready to send — your words, exactly:')).toBeTruthy();
    expect(screen.getByTestId('pending-proposal-text').textContent).toBe(RAW_WORDS);
    expect(screen.queryByTestId('relay-tidied-note')).toBeNull();
  });
});

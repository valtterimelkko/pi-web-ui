import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { DriveModeDictate } from '../../../../src/components/DriveMode/DriveModeDictate';
import { resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';

/**
 * SINGLE-LANE IDENTITY PIN (lane work, 2026-09-15).
 *
 * Shipped promise: single-lane use stays behaviourally identical to the
 * pre-lane surface — the strip collapses away, nothing subscribes anywhere
 * else, and the operator's words go to exactly one worker. This file pins
 * that with NO lane props at all; it must keep passing after every lane
 * change, and any diff here is a regression against the shipped surface.
 */

const sendMock = vi.fn();
const sendPromptMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock, sendPrompt: sendPromptMock })),
}));

const capture: {
  state: 'idle' | 'starting' | 'recording' | 'processing' | 'error';
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

function dictate(text: string): void {
  if (!capture.transcript) throw new Error('useDictation was never invoked');
  act(() => {
    capture.transcript?.(text);
  });
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
  speechArbiter.attachPlayer(makeBlockedPlayer().player);
});

afterEach(() => {
  speechArbiter.stopAll();
});

describe('single-lane identity — the surface the operator ships with', () => {
  it('renders NO lane strip and no lane rows', () => {
    renderSurface();
    expect(document.querySelector('[data-testid="lane-strip"]')).toBeNull();
    expect(document.querySelector('[data-testid="lane-row"]')).toBeNull();
    expect(screen.queryByText(/of 3/)).toBeNull();
  });

  it('renders exactly today\'s four-state banner and mic control', () => {
    renderSurface();
    expect(screen.getByTestId('floor-banner')).toBeInTheDocument();
    expect(screen.getByTestId('floor-state-label')).toHaveTextContent(/tap to speak/i);
    expect(screen.getByTestId('drive-mic')).toBeInTheDocument();
    expect(screen.getByTestId('voice-contract-hint')).toBeInTheDocument();
  });

  it('a dictated utterance sends exactly ONE talker_turn, addressed to this session only', () => {
    renderSurface();
    dictate('tell the worker to rerun the suite');
    const talkerSends = sendMock.mock.calls.filter(
      ([m]) => (m as { type?: string }).type === 'talker_turn'
    );
    expect(talkerSends).toHaveLength(1);
    for (const [m] of talkerSends) {
      expect((m as { workerSessionId?: string }).workerSessionId).toBe(WORKER);
    }
  });

  it('the floor signal flows straight to the arbiter — exactly as before lanes', () => {
    const { rerender } = renderSurface();
    expect(speechArbiter.isOperatorSpeaking()).toBe(false);

    capture.state = 'recording';
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

    capture.state = 'idle';
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
    expect(speechArbiter.isOperatorSpeaking()).toBe(false);
  });

  it('the surface sends no subscription or cross-lane socket messages of its own', () => {
    renderSurface();
    dictate('one utterance');
    fireEvent.click(screen.getByTestId('drive-mic'));
    const chatter = sendMock.mock.calls.filter(([m]) => {
      const type = (m as { type?: string }).type;
      return type === 'subscribe_session' || type === 'unsubscribe_session' || type === 'switch_session';
    });
    expect(chatter).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDriveModeDictation } from '../../../src/hooks/useDriveModeDictation';
import {
  speechArbiter,
  TIER_ANSWER,
  type ArbiterPlayer,
} from '../../../src/lib/speechArbiter';

// Mock useDictation
vi.mock('../../../src/hooks/useDictation', () => ({
  useDictation: vi.fn((onTranscript) => ({
    state: 'idle',
    errorMessage: '',
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggle: vi.fn(),
    // Simulate calling onTranscript when stopRecording is invoked
    __onTranscript: onTranscript,
  })),
}));

// Mock useWebSocket
vi.mock('../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({
    sendPrompt: vi.fn(),
  })),
}));

import { useDictation } from '../../../src/hooks/useDictation';
import { useWebSocket } from '../../../src/hooks/useWebSocket';


/** Extract the transcript callback the hook hands to useDictation. */
function getOnTranscript(): (text: string) => void {
  const lastCall = (useDictation as ReturnType<typeof vi.fn>).mock.lastCall;
  if (!lastCall) throw new Error('useDictation was not called');
  return lastCall[0] as (text: string) => void;
}

/** Point the useDictation mock at an arbitrary dictation state. */
function mockDictationState(state: string): void {
  (useDictation as ReturnType<typeof vi.fn>).mockImplementation((onTranscript) => ({
    state,
    errorMessage: '',
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggle: vi.fn(),
    __onTranscript: onTranscript,
  }));
}

/** Player whose chunk never finishes — pins the arbiter mid-playback. */
class NeverFinishingPlayer implements ArbiterPlayer {
  playChunk(): Promise<void> {
    return new Promise<void>(() => {});
  }
  setVolume(): void {}
  stopCurrent(): void {}
}

describe('useDriveModeDictation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dictation state and controls', () => {
    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    expect(result.current.state).toBe('idle');
    expect(result.current.errorMessage).toBe('');
    expect(typeof result.current.startRecording).toBe('function');
    expect(typeof result.current.stopRecording).toBe('function');
    expect(typeof result.current.toggle).toBe('function');
  });

  it('calls sendPrompt when transcript received with valid sessionId', () => {
    const mockSendPrompt = vi.fn();
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    renderHook(() => useDriveModeDictation('session-123'));

    const onTranscript = getOnTranscript();

    onTranscript('Hello agent');
    expect(mockSendPrompt).toHaveBeenCalledWith('Hello agent');
  });

  it('does not call sendPrompt when sessionId is null', () => {
    const mockSendPrompt = vi.fn();
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    renderHook(() => useDriveModeDictation(null));

    const onTranscript = getOnTranscript();

    onTranscript('Hello agent');
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  // RED 3: a transcript whose send fails must be preserved for retry, not lost.
  it('preserves the transcript when sendPrompt reports failure', () => {
    const mockSendPrompt = vi.fn(() => 'failed');
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    const onTranscript = getOnTranscript();

    act(() => {
      onTranscript('Hold this spoken instruction');
    });

    expect(result.current.pendingText).toBe('Hold this spoken instruction');
    expect(typeof result.current.retryLastSend).toBe('function');
  });

  it('keeps the transcript available for retry when the retry fails again', () => {
    const mockSendPrompt = vi.fn(() => 'failed');
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    const onTranscript = getOnTranscript();
    act(() => {
      onTranscript('Hold this spoken instruction');
    });

    act(() => {
      result.current.retryLastSend();
    });

    expect(mockSendPrompt).toHaveBeenCalledTimes(2);
    expect(mockSendPrompt).toHaveBeenLastCalledWith('Hold this spoken instruction');
    expect(result.current.pendingText).toBe('Hold this spoken instruction');
  });

  it('clears the preserved transcript when the retry succeeds', () => {
    const mockSendPrompt = vi.fn(() => 'failed');
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    const onTranscript = getOnTranscript();
    act(() => {
      onTranscript('Hold this spoken instruction');
    });

    mockSendPrompt.mockReturnValue('queued');
    act(() => {
      result.current.retryLastSend();
    });

    expect(result.current.pendingText).toBeNull();
  });

  it('does not preserve a transcript whose send was queued or sent', () => {
    const mockSendPrompt = vi.fn(() => 'queued');
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    const onTranscript = getOnTranscript();

    act(() => {
      onTranscript('Hello agent');
    });

    expect(result.current.pendingText).toBeNull();
  });

  it('allows discarding the preserved transcript', () => {
    const mockSendPrompt = vi.fn(() => 'failed');
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    const onTranscript = getOnTranscript();
    act(() => {
      onTranscript('Hold this spoken instruction');
    });

    act(() => {
      result.current.discardPending();
    });

    expect(result.current.pendingText).toBeNull();
  });
});

describe('useDriveModeDictation — operator floor signal (P4 speech arbiter)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    speechArbiter.setOperatorSpeaking(false);
  });

  afterEach(() => {
    speechArbiter.stopAll();
    speechArbiter.setOperatorSpeaking(false);
  });

  it('exposes operatorSpeaking while the dictation is recording', () => {
    mockDictationState('recording');
    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    expect(result.current.operatorSpeaking).toBe(true);
  });

  it('exposes operatorSpeaking false when idle, processing, or errored', () => {
    for (const state of ['idle', 'processing', 'error']) {
      mockDictationState(state);
      const { result, unmount } = renderHook(() => useDriveModeDictation('session-123'));
      expect(result.current.operatorSpeaking).toBe(false);
      unmount();
    }
  });

  it('reports the floor to the speech arbiter while recording and clears when it stops', () => {
    expect(speechArbiter.isOperatorSpeaking()).toBe(false);

    mockDictationState('recording');
    const { rerender } = renderHook(() => useDriveModeDictation('session-123'));
    rerender();
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);

    mockDictationState('idle');
    rerender();
    expect(speechArbiter.isOperatorSpeaking()).toBe(false);
  });

  // PINNED PROPERTY 3 — capture is unconditional; only playback is scheduled
  // (§4.1 invariant). With the arbiter mid-playback (a chunk that never
  // finishes), an operator utterance must still be captured and sent, and
  // the floor signal must reach the arbiter so playback ducks.
  it('captures an utterance even while the arbiter is mid-playback', async () => {
    const mockSendPrompt = vi.fn(() => 'sent');
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    speechArbiter.attachPlayer(new NeverFinishingPlayer());
    expect(
      speechArbiter.submit({ id: 'answer', tier: TIER_ANSWER, chunks: ['long answer.'] })
    ).toBe('queued');
    await act(async () => {
      await Promise.resolve();
    });
    expect(speechArbiter.getState().playing).toBe(true);

    mockDictationState('recording');
    const { result } = renderHook(() => useDriveModeDictation('session-123'));
    expect(result.current.operatorSpeaking).toBe(true);
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);

    const onTranscript = getOnTranscript();
    act(() => {
      onTranscript('Spoken while speech is playing');
    });

    // The capture path was not gated by playback state.
    expect(mockSendPrompt).toHaveBeenCalledWith('Spoken while speech is playing');
    // Playback ducked instead of being hard-stopped by the barge-in.
    expect(speechArbiter.getState().current).not.toBeNull();
  });
});

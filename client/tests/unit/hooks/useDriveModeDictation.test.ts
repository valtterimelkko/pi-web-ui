import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDriveModeDictation } from '../../../src/hooks/useDriveModeDictation';

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

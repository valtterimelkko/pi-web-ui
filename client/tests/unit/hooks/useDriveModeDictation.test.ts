import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
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

    // Extract the onTranscript callback passed to useDictation
    const lastCall = (useDictation as ReturnType<typeof vi.fn>).mock.lastCall;
    const onTranscript = lastCall![0] as (text: string) => void;

    onTranscript('Hello agent');
    expect(mockSendPrompt).toHaveBeenCalledWith('Hello agent');
  });

  it('does not call sendPrompt when sessionId is null', () => {
    const mockSendPrompt = vi.fn();
    (useWebSocket as ReturnType<typeof vi.fn>).mockReturnValue({ sendPrompt: mockSendPrompt });

    renderHook(() => useDriveModeDictation(null));

    const lastCall = (useDictation as ReturnType<typeof vi.fn>).mock.lastCall;
    const onTranscript = lastCall![0] as (text: string) => void;

    onTranscript('Hello agent');
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });
});

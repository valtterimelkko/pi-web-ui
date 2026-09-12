import { useCallback, useState } from 'react';
import { useDictation } from './useDictation';
import { useWebSocket } from './useWebSocket';

/**
 * Drive Mode dictation: turns a finished transcript into a prompt.
 *
 * A failed send must never discard the spoken instruction — on a phone the
 * socket is often down when the tab has been suspended, and a talker that
 * silently eats a spoken prompt is a broken talker. When sendPrompt reports
 * 'failed', the text is kept in `pendingText` and the UI offers an explicit
 * retry (`retryLastSend`). A 'queued' result is safe: the client holds the
 * message and flushes it automatically after reconnect.
 */
export function useDriveModeDictation(sessionId: string | null) {
  const { sendPrompt } = useWebSocket();
  const [pendingText, setPendingText] = useState<string | null>(null);

  const attemptSend = useCallback((text: string): boolean => {
    const result = sendPrompt(text);
    if (result === 'failed') {
      setPendingText(text);
      return false;
    }
    setPendingText(null);
    return true;
  }, [sendPrompt]);

  const handleTranscript = useCallback((text: string) => {
    if (sessionId) {
      attemptSend(text);
    }
  }, [sessionId, attemptSend]);

  const retryLastSend = useCallback((): boolean => {
    if (pendingText === null) return true;
    return attemptSend(pendingText);
  }, [pendingText, attemptSend]);

  const discardPending = useCallback((): void => {
    setPendingText(null);
  }, []);

  const dictation = useDictation(handleTranscript);

  return {
    state: dictation.state,
    errorMessage: dictation.errorMessage,
    startRecording: dictation.startRecording,
    stopRecording: dictation.stopRecording,
    toggle: dictation.toggle,
    /** Transcript whose send failed; kept until a retry succeeds or it is discarded. */
    pendingText,
    retryLastSend,
    discardPending,
  };
}

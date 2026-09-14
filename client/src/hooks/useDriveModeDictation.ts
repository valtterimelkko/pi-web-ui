import { useCallback, useEffect, useState } from 'react';
import { useDictation } from './useDictation';
import { useWebSocket } from './useWebSocket';
import { speechArbiter } from '../lib/speechArbiter';

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

  const dictation = useDictation(handleTranscript, { workerSessionId: sessionId ?? undefined });

  /** The operator holds the floor while the mic is capturing their voice
   *  (§4.1 rule 1). This signal only ever feeds playback scheduling — it is
   *  read by the speech arbiter to duck speech, never the other way round:
   *  capture is unconditional and must never be gated by playback state. */
  const operatorSpeaking = dictation.state === 'recording';

  useEffect(() => {
    speechArbiter.setOperatorSpeaking(operatorSpeaking);
    return () => {
      speechArbiter.setOperatorSpeaking(false);
    };
  }, [operatorSpeaking]);

  return {
    state: dictation.state,
    errorMessage: dictation.errorMessage,
    startRecording: dictation.startRecording,
    stopRecording: dictation.stopRecording,
    toggle: dictation.toggle,
    /** True while the operator holds the floor (dictation recording). */
    operatorSpeaking,
    /** Transcript whose send failed; kept until a retry succeeds or it is discarded. */
    pendingText,
    retryLastSend,
    discardPending,
  };
}

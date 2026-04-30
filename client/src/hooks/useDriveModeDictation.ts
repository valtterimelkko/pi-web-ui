import { useCallback } from 'react';
import { useDictation } from './useDictation';
import { useWebSocket } from './useWebSocket';

export function useDriveModeDictation(sessionId: string | null) {
  const { sendPrompt } = useWebSocket();

  const handleTranscript = useCallback((text: string) => {
    if (sessionId) {
      sendPrompt(text);
    }
  }, [sessionId, sendPrompt]);

  const dictation = useDictation(handleTranscript);

  return {
    state: dictation.state,
    errorMessage: dictation.errorMessage,
    startRecording: dictation.startRecording,
    stopRecording: dictation.stopRecording,
    toggle: dictation.toggle,
  };
}

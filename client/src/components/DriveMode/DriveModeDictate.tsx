import { useEffect, useCallback } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useDriveModeStore } from '../../store/driveModeStore';
import { useSessionStore } from '../../store/sessionStore';
import { useDriveModeDictation } from '../../hooks/useDriveModeDictation';
import { useReadAloud, stopCurrentAudio } from '../../hooks/useReadAloud';
import { getLastAssistantText } from '../../lib/driveModeUtils';

export interface DriveModeDictateProps {
  sessionId: string;
  modelName: string;
  sessionDisplayName: string;
  onExit: () => void;
}

export function DriveModeDictate({
  sessionId,
  modelName,
  sessionDisplayName,
  onExit,
}: DriveModeDictateProps) {
  const dictation = useDriveModeDictation(sessionId);
  const readAloud = useReadAloud('drive-mode');
  const phase = useDriveModeStore((s) => s.phase);
  const setPhase = useDriveModeStore((s) => s.setPhase);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const messages = useSessionStore((s) => s.messages);

  // Vibrate when recording starts
  useEffect(() => {
    if (dictation.state === 'recording') {
      navigator.vibrate?.(100);
    }
  }, [dictation.state]);

  // Keep phase in 'dictate' while dictating
  useEffect(() => {
    if (dictation.state === 'recording' || dictation.state === 'processing') {
      if (phase !== 'dictate') {
        setPhase('dictate');
      }
    }
  }, [dictation.state, phase, setPhase]);

  // Watch streaming state to transition between agent-working and read-aloud-ready
  useEffect(() => {
    if (isStreaming && phase !== 'agent-working') {
      setPhase('agent-working');
    }
    if (!isStreaming && phase === 'agent-working') {
      setPhase('read-aloud-ready');
    }
  }, [isStreaming, phase, setPhase]);

  // When audio finishes, return to dictate phase
  useEffect(() => {
    if (phase === 'audio-playing' && readAloud.state === 'idle') {
      setPhase('dictate');
    }
  }, [readAloud.state, phase, setPhase]);

  const handleMicClick = useCallback(() => {
    if (phase === 'read-aloud-ready' || phase === 'audio-playing') {
      stopCurrentAudio();
    }
    dictation.toggle();
  }, [phase, dictation]);

  const handleReadAloud = useCallback(() => {
    if (readAloud.state === 'playing') {
      readAloud.stop();
      setPhase('dictate');
      return;
    }
    const text = getLastAssistantText(messages);
    if (text) {
      readAloud.play(text);
      setPhase('audio-playing');
    }
  }, [readAloud, messages, setPhase]);

  const handleToggleSpeed = useCallback(() => {
    readAloud.toggleSpeed();
  }, [readAloud]);

  const getStatusText = () => {
    if (phase === 'dictate') {
      if (dictation.state === 'idle') return 'Tap to speak';
      if (dictation.state === 'recording') return 'Listening...';
      if (dictation.state === 'processing') return 'Processing...';
      if (dictation.state === 'error') return 'Tap to retry';
    }
    if (phase === 'agent-working') return 'Agent working...';
    if (phase === 'read-aloud-ready') return 'Done — listen or speak';
    if (phase === 'audio-playing') return 'Reading aloud...';
    return '';
  };

  const isRecording = dictation.state === 'recording';
  const showReadAloudControls = phase === 'read-aloud-ready' || phase === 'audio-playing';
  const lastAssistantText = getLastAssistantText(messages);

  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6 relative">
      {/* Exit button */}
      <button
        onClick={onExit}
        className="absolute top-4 right-4 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        type="button"
      >
        ✕ Exit
      </button>

      {/* Session info */}
      <div className="flex flex-col items-center mt-8 mb-8">
        <div className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {sessionDisplayName}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">{modelName}</div>
      </div>

      {/* Mic button */}
      <button
        onClick={handleMicClick}
        disabled={dictation.state === 'processing'}
        className={`w-28 h-28 rounded-full flex items-center justify-center transition-all duration-200 select-none touch-manipulation ${
          dictation.state === 'processing' ? 'cursor-not-allowed' : 'active:scale-95'
        } ${
          isRecording
            ? 'bg-red-50 dark:bg-red-950 border-4 border-red-500 animate-pulse'
            : 'bg-gray-100 dark:bg-gray-800 border-4 border-gray-200 dark:border-gray-700'
        }`}
        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
        type="button"
      >
        {dictation.state === 'error' ? (
          <MicOff
            className={`w-10 h-10 ${
              isRecording ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
            }`}
          />
        ) : (
          <Mic
            className={`w-10 h-10 ${
              isRecording ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
            }`}
          />
        )}
      </button>

      {/* Status text */}
      <div
        className="mt-6 text-lg text-gray-600 dark:text-gray-300 text-center"
        role="status"
        aria-live="polite"
      >
        {getStatusText()}
      </div>

      {/* Error message */}
      {dictation.state === 'error' && dictation.errorMessage && (
        <div
          className="mt-2 text-sm text-red-600 dark:text-red-400 text-center"
          role="alert"
        >
          {dictation.errorMessage}
        </div>
      )}

      {/* Read Aloud controls */}
      {showReadAloudControls && (
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleReadAloud}
            disabled={readAloud.state !== 'playing' && !lastAssistantText}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              readAloud.state === 'playing'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
            type="button"
          >
            {readAloud.state === 'playing' ? 'Stop Reading' : '🔊 Read Aloud'}
          </button>
          <button
            onClick={handleToggleSpeed}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            type="button"
          >
            {readAloud.speedEnabled ? '1.25x' : '1x'}
          </button>
        </div>
      )}
    </div>
  );
}

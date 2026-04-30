import { useEffect, useRef } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useDriveModeStore } from '../../store/driveModeStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionStore } from '../../store/sessionStore';
import { stopCurrentAudio } from '../../hooks/useReadAloud';
import { DRIVE_MODE_MODELS } from './driveModeModels';
import type { DriveModeModel } from '../../store/driveModeStore';
import { DriveModeEntry } from './DriveModeEntry';
import { DriveModeModelPicker } from './DriveModeModelPicker';
import { DriveModeSessionPicker } from './DriveModeSessionPicker';
import { DriveModeDictate } from './DriveModeDictate';

export function DriveModeOverlay() {
  const isOpen = useUIStore((s) => s.driveModeOpen);
  const closeDriveMode = useUIStore((s) => s.closeDriveMode);
  const { phase, close, selectedModelId, activeSessionId, setPhase, selectModel, setActiveSession, reset } = useDriveModeStore();
  const { createNewSession, switchSession, setModel } = useWebSocket();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentModel = useSessionStore((s) => s.currentModel);
  const prevSessionIdRef = useRef<string | null>(null);

  // Session creation flow: watch for new session after createNewSession
  useEffect(() => {
    if (phase === 'model-pick' && selectedModelId && currentSessionId && currentSessionId !== prevSessionIdRef.current) {
      // New session was created
      const model = DRIVE_MODE_MODELS.find(m => m.id === selectedModelId);
      if (model) {
        setModel(model.id);
      }
      setActiveSession(currentSessionId);
      setPhase('dictate');
    }
    prevSessionIdRef.current = currentSessionId;
  }, [currentSessionId, selectedModelId, phase, setModel, setActiveSession, setPhase]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleClose = () => {
    stopCurrentAudio();
    closeDriveMode();
    close();
  };

  const handleNewSession = () => {
    setPhase('model-pick');
  };

  const handleContinueSession = () => {
    setPhase('session-pick');
  };

  const handleSelectModel = (model: DriveModeModel) => {
    selectModel(model.id);
    createNewSession(undefined, model.sdkType);
    // Set a timeout; if session isn't created in 10s, show error
    setTimeout(() => {
      const store = useDriveModeStore.getState();
      if (store.phase === 'model-pick' && store.selectedModelId === model.id) {
        useUIStore.getState().addToast({ type: 'error', message: 'Failed to create session. Please try again.' });
      }
    }, 10000);
  };

  const handleSelectSession = (sessionId: string, sessionPath: string) => {
    setActiveSession(sessionId);
    switchSession(sessionPath);
    setPhase('dictate');
  };

  const handleBack = () => {
    reset();
  };

  if (!isOpen) return null;

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const sessionDisplayName = activeSession?.name || activeSession?.firstMessage?.slice(0, 50) || 'New Session';
  const modelName = activeSession?.model || currentModel || 'Default model';

  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-gray-950 flex flex-col overflow-hidden">
      {phase === 'entry' && (
        <DriveModeEntry
          onNewSession={handleNewSession}
          onContinueSession={handleContinueSession}
          onExit={handleClose}
        />
      )}
      {phase === 'model-pick' && (
        <DriveModeModelPicker
          onSelect={handleSelectModel}
          onBack={handleBack}
        />
      )}
      {phase === 'session-pick' && (
        <DriveModeSessionPicker
          onBack={handleBack}
          onSelectSession={handleSelectSession}
        />
      )}
      {(phase === 'dictate' || phase === 'agent-working' || phase === 'read-aloud-ready' || phase === 'audio-playing') && (
        <DriveModeDictate
          sessionId={activeSessionId || currentSessionId || ''}
          modelName={modelName}
          sessionDisplayName={sessionDisplayName}
          onExit={handleClose}
        />
      )}
    </div>
  );
}

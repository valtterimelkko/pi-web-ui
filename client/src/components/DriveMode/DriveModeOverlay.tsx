import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useDriveModeStore, MAX_VOICE_LANES } from '../../store/driveModeStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSessionStore } from '../../store/sessionStore';
import { stopCurrentAudio } from '../../hooks/useReadAloud';
import { DRIVE_MODE_MODELS } from './driveModeModels';
import type { DriveModeModel } from '../../store/driveModeStore';
import { DriveModeEntry } from './DriveModeEntry';
import { DriveModeModelPicker } from './DriveModeModelPicker';
import { DriveModeFolderPicker } from './DriveModeFolderPicker';
import { DriveModeSessionPicker } from './DriveModeSessionPicker';
import { DriveModeDictate } from './DriveModeDictate';
import { DriveModeSessionPane } from './DriveModeSessionPane';
import { LaneStrip } from './LaneStrip';
import { stopVoiceLaneForWorkerSwitch } from '../../hooks/useVoiceLiveLane';
import { laneFloor } from './voiceLanes';
import { useVoiceLayout } from './useVoiceLayout';

export function DriveModeOverlay() {
  const isOpen = useUIStore((s) => s.driveModeOpen);
  const closeDriveMode = useUIStore((s) => s.closeDriveMode);
  const {
    phase,
    close,
    selectedModelId,
    activeSessionId,
    lanes = [],
    addingLane = false,
    replacingLaneId = null,
    setPhase,
    selectModel,
    setActiveSession,
    openAddLane,
    cancelAddLane,
    beginLaneReplace,
    addVoiceLane,
    replaceVoiceLane,
    removeVoiceLane,
    reset,
  } = useDriveModeStore();
  const {
    createNewSession,
    switchSession,
    setModel,
    abortGeneration,
    subscribeToSession,
    unsubscribeFromSession,
  } = useWebSocket();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const currentModel = useSessionStore((s) => s.currentModel);
  const getSessionDisplayName = useSessionStore((s) => s.getSessionDisplayName);
  const prevSessionIdRef = useRef<string | null>(null);
  const layout = useVoiceLayout();
  /** The desktop arrangement: voice block + lane strip, with the live session
   *  as a bottom panel of the SAME column (operator, 2026-09-16). */
  const desktop = layout.layout === 'desktop';
  /** The cap-ask (replace-or-cancel) is overlay-local: it shows instead of
   *  the picker when "+" is pressed at the cap — never a silent fourth lane. */
  const [askReplace, setAskReplace] = useState(false);
  /** Single-lane switch: the picker opens OVER the surface with the phase
   *  untouched. Lane switches reuse the store's replace flow instead. */
  const [switchSingleLane, setSwitchSingleLane] = useState(false);

  // Session creation flow: watch for new session after createNewSession
  useEffect(() => {
    if ((phase === 'folder-pick' || phase === 'model-pick') && selectedModelId && currentSessionId && currentSessionId !== prevSessionIdRef.current) {
      // New session was created
      const model = DRIVE_MODE_MODELS.find(m => m.id === selectedModelId);
      if (model) {
        setModel(model.id);
      }
      setActiveSession(currentSessionId);
      setPhase('dictate');
      // Session created successfully
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
    setPhase('folder-pick');
  };

  const handleSelectFolder = (path: string) => {
    const model = DRIVE_MODE_MODELS.find(m => m.id === selectedModelId);
    if (!model) return;
    createNewSession(path, model.sdkType);
    // Set a timeout; if session isn't created in 10s, show error
    setTimeout(() => {
      const store = useDriveModeStore.getState();
      if ((store.phase === 'folder-pick' || store.phase === 'model-pick') && store.selectedModelId === model.id) {
        useUIStore.getState().addToast({ type: 'error', message: 'Failed to create session. Please try again.' });
        // Creation failed, stay in folder-pick
      }
    }, 10000);
  };

  const handleSelectSession = (sessionId: string, sessionPath: string) => {
    setActiveSession(sessionId);
    switchSession(sessionPath);
    setPhase('dictate');
  };

  // ---------------------------------------------------------------------------
  // Multi-lane: ONE tab holds the lanes. The picker and the cap-ask render
  // OVER the mounted lanes (the phase never leaves dictate, so no lane's
  // capture, card or focus is lost). Switching the addressed lane re-pins the
  // other lanes' subscriptions: the server's switch_session unsubscribes the
  // previous current session, so every other lane is re-subscribed after it.
  // The desktop arrangement (see voiceLayout) is the SAME block with the live
  // session as a bottom panel of the column — never a second voice surface.
  // ---------------------------------------------------------------------------
  const sessionById = (sessionId: string | null) => sessions.find((s) => s.id === sessionId);

  const handleAddressLane = (sessionId: string) => {
    setActiveSession(sessionId);
    const session = sessionById(sessionId);
    if (!session?.path) return;
    switchSession(session.path);
    for (const lane of lanes) {
      if (lane.sessionId === sessionId) continue;
      const other = sessionById(lane.sessionId);
      if (other?.path && other.path !== session.path) subscribeToSession(other.path);
    }
  };

  const handleAddLaneClick = () => {
    // A lane that is recording must not be remounted by the mode transition:
    // its words are finalised into its own talker first — never dropped.
    laneFloor.finaliseCapture(laneFloor.capturingLaneId() ?? '');
    openAddLane();
    // At the cap the "+" asks (replace one, or cancel) — it never adds.
    setAskReplace(lanes.length >= MAX_VOICE_LANES);
  };

  const closeAddFlow = () => {
    cancelAddLane();
    setAskReplace(false);
  };

  const handleAddLaneSession = (sessionId: string, sessionPath: string) => {
    const replacing = replacingLaneId;
    if (replacing) {
      const oldSession = sessionById(replacing);
      // The same refusal the store applies — checked here first so a refused
      // duplicate pick never stops the old lane (the asking rule: the pick
      // changed nothing, so nothing is retired).
      if (lanes.some((lane) => lane.sessionId === sessionId)) {
        useUIStore.getState().addToast({ type: 'error', message: 'That session is already a lane.' });
        return;
      }
      // C24 / contract §3.2 steps 1–2, in order: the lane's worker is about
      // to change, so the OLD lane's native session is stopped with reason
      // `worker_switch` (the server resolves any live proposal —
      // proposal_resolved `replaced` — before the swap takes effect, and a
      // pending confirmation can never follow the lane to the new worker);
      // then the store swaps the lane in place, and the new surface opens
      // its own generation when the operator next starts it. A no-op when
      // the old lane never opened.
      stopVoiceLaneForWorkerSwitch(replacing);
      replaceVoiceLane(replacing, sessionId);
      if (oldSession?.path) unsubscribeFromSession(oldSession.path);
      subscribeToSession(sessionPath);
      setAskReplace(false);
      handleAddressLane(sessionId);
      return;
    }
    const outcome = addVoiceLane(sessionId);
    if (outcome === 'duplicate') {
      useUIStore.getState().addToast({ type: 'error', message: 'That session is already a lane.' });
      return;
    }
    if (outcome === 'full') {
      // The cap refused: show the ask rather than a silent refusal.
      setAskReplace(true);
      return;
    }
    subscribeToSession(sessionPath);
    setAskReplace(false);
    handleAddressLane(sessionId);
  };

  const handleRemoveLane = (sessionId: string) => {
    // Finalise a capturing lane BEFORE its surface unmounts: the operator's
    // words are relayed to that lane's talker, never dropped.
    laneFloor.finaliseCapture(sessionId);
    const session = sessionById(sessionId);
    removeVoiceLane(sessionId);
    if (session?.path) unsubscribeFromSession(session.path);
    const after = useDriveModeStore.getState();
    if (sessionId === activeSessionId && after.lanes.length > 1) {
      // The removed lane was addressed and multi-lane continues: address the
      // first remaining lane.
      handleAddressLane(after.lanes[0].sessionId);
    }
  };

  const handleBack = () => {
    reset();
  };

  // ---------------------------------------------------------------------------
  // Switching the worker a voice surface is attached to, in place (operator,
  // 2026-09-16): "a 'switch session' button that would allow me to adjust
  // quickly (per lane) what session / worker the voice mode is attached to …
  // without having to exit the voice mode entirely and then rebuild the 3 lanes
  // view again from scratch".
  //
  // Lane mode reuses the replace flow: the picker opens over the mounted lanes
  // (phase untouched, nothing unmounts) and only that lane's session is
  // swapped — its order and slot stay. The switching lane's capture is
  // finalised into its own talker FIRST, exactly as add/remove already do, so
  // the operator's words are never dropped.
  //
  // Single-lane mode has no lane to replace: the picker opens over the surface
  // and re-points the addressed session — it never creates a lane.
  // ---------------------------------------------------------------------------
  const handleSwitchLane = (sessionId: string) => {
    laneFloor.finaliseCapture(sessionId);
    beginLaneReplace(sessionId);
  };

  const handleSwitchSingleLane = () => {
    setSwitchSingleLane(true);
  };

  const handleSwitchSinglePick = (sessionId: string, sessionPath: string) => {
    setSwitchSingleLane(false);
    const previous = activeSessionId || currentSessionId;
    if (sessionId === previous) return;
    // C24 / contract §3.2 step 1: single-lane has the same seam — the surface
    // is being handed to another worker, so its native session is stopped
    // (reason `worker_switch`) before the addressed session changes.
    if (previous) stopVoiceLaneForWorkerSwitch(previous);
    setActiveSession(sessionId);
    switchSession(sessionPath);
  };

  if (!isOpen) return null;

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const sessionDisplayName = (activeSession && getSessionDisplayName(activeSession.path)) || activeSession?.name || activeSession?.firstMessage?.slice(0, 50) || 'New Session';
  const selectedModel = DRIVE_MODE_MODELS.find(m => m.id === selectedModelId);
  const modelName = selectedModel?.displayName || activeSession?.model || currentModel || 'Default model';

  /** Multi-lane: the tab holds the lanes when at least one extra lane exists.
   *  Empty = the shipped single-lane surface, byte for byte. */
  const multiLane = lanes.length > 0;
  const laneLabels: Record<string, string> = {};
  if (multiLane) {
    for (const lane of lanes) {
      const session = sessions.find((s) => s.id === lane.sessionId);
      laneLabels[lane.sessionId] =
        (session && getSessionDisplayName(session.path)) ||
        session?.name ||
        session?.firstMessage?.slice(0, 50) ||
        'New Session';
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-canvas dark:bg-canvas-dark text-content-primary dark:text-content-primary-dark font-sans flex flex-col overflow-hidden">
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
      {phase === 'folder-pick' && (
        <DriveModeFolderPicker
          onSelectFolder={handleSelectFolder}
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
        // ONE column in both modes: the lane strip, then the addressed lane's
        // voice surface. In the desktop arrangement the live session is a
        // BOTTOM PANEL of this same column (operator, 2026-09-16) — that is
        // what leaves room for the maximum of three lanes while the session
        // stays visible. Mobile mode is unchanged: no pane, full height.
        <div data-testid="drive-mode-column" className="flex flex-col flex-1 min-h-0 w-full">
          <LaneStrip
            lanes={lanes}
            addressedSessionId={activeSessionId}
            labels={laneLabels}
            onAddress={handleAddressLane}
            onAdd={handleAddLaneClick}
            onRemove={handleRemoveLane}
            onSwitch={handleSwitchLane}
          />
          <div className="relative flex-1 min-h-0 w-full overflow-hidden">
            {multiLane ? (
              // Multi-lane: ONE tab holds the lanes. Every lane's surface stays
              // mounted (hidden when not addressed) so capture, cards and focus
              // live on per lane.
              lanes.map((lane) => {
                const laneSession = sessionById(lane.sessionId);
                const laneDisplayName =
                  (laneSession && getSessionDisplayName(laneSession.path)) ||
                  laneSession?.name ||
                  laneSession?.firstMessage?.slice(0, 50) ||
                  'New Session';
                return (
                  <div
                    key={lane.sessionId}
                    className={`absolute inset-0 flex flex-col ${
                      lane.sessionId === activeSessionId
                        ? 'z-10'
                        // Non-addressed wrappers must never intercept the
                        // addressed surface's clicks (real-browser hit
                        // testing, invisible to jsdom).
                        : 'invisible pointer-events-none'
                    }`}
                  >
                    <DriveModeDictate
                      sessionId={lane.sessionId}
                      sdkType={laneSession?.sdkType ?? null}
                      modelName={laneSession?.model || currentModel || 'Default model'}
                      sessionDisplayName={laneDisplayName}
                      onExit={handleClose}
                      onAbort={abortGeneration}
                      onSwitchSession={() => handleSwitchLane(lane.sessionId)}
                      compact={desktop}
                      laneEnabled
                      addressed={lane.sessionId === activeSessionId}
                    />
                  </div>
                );
              })
            ) : (
              // Single-lane: today's surface, plus the in-place switch control
              // and (in desktop) the compact variant.
              <DriveModeDictate
                sessionId={activeSessionId || currentSessionId || ''}
                sdkType={activeSession?.sdkType ?? selectedModel?.sdkType ?? null}
                modelName={modelName}
                sessionDisplayName={sessionDisplayName}
                onExit={handleClose}
                onAbort={abortGeneration}
                onSwitchSession={handleSwitchSingleLane}
                compact={desktop}
              />
            )}
          </div>
          {desktop && (
            // The live session, a quarter of the window at the bottom of this
            // column. The REAL session view: same store, same shared list as
            // the chat screen — never a raw event dump.
            <div
              data-testid="drive-session-panel"
              className="flex-shrink-0 basis-1/4 grow-0 shrink-0 min-h-[150px] max-h-[45%] border-t border-outline-default dark:border-outline-default-dark overflow-hidden"
            >
              <DriveModeSessionPane
                sessionDisplayName={sessionDisplayName}
                modelName={modelName}
                sessionId={activeSessionId || currentSessionId}
              />
            </div>
          )}
        </div>
      )}

      {/* The add-lane flow renders OVER the whole overlay — in BOTH single-lane
          and multi-lane — so the dictate surfaces never unmount (their capture,
          cards and focus live on). The phase never leaves dictate. */}
      {addingLane && !askReplace && (
        <div className="absolute inset-0 z-20 bg-canvas dark:bg-canvas-dark overflow-y-auto">
          <DriveModeSessionPicker
            // The same picker serves two flows and says which one it is: adding
            // a new lane, or handing an existing lane to another worker.
            title={replacingLaneId ? 'Switch session' : 'Add a lane'}
            onBack={closeAddFlow}
            onSelectSession={handleAddLaneSession}
          />
        </div>
      )}
      {switchSingleLane && (
        <div className="absolute inset-0 z-20 bg-canvas dark:bg-canvas-dark overflow-y-auto">
          <DriveModeSessionPicker
            title="Switch session"
            onBack={() => setSwitchSingleLane(false)}
            onSelectSession={handleSwitchSinglePick}
          />
        </div>
      )}
      {askReplace && (
        <div
          data-testid="lane-cap-ask"
          className="absolute inset-0 z-20 bg-canvas dark:bg-canvas-dark flex flex-col items-center justify-center gap-4 px-6"
        >
          <p className="text-lg font-medium text-content-primary dark:text-content-primary-dark text-center">
            Voice Mode holds {lanes.length} of {MAX_VOICE_LANES} lanes.
          </p>
          <p className="text-sm text-content-muted dark:text-content-muted-dark text-center max-w-md">
            Replace one of the lanes with the session you pick, or cancel. A fourth lane is never added silently.
          </p>
          <div className="w-full max-w-md flex flex-col gap-2">
            {lanes.map((lane) => (
              <button
                key={lane.sessionId}
                onClick={() => {
                  beginLaneReplace(lane.sessionId);
                  setAskReplace(false);
                }}
                aria-label={`Replace ${laneLabels[lane.sessionId] ?? lane.sessionId}`}
                className="w-full rounded-lg border border-gray-200 dark:border-gray-700 p-3 text-left font-medium text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                type="button"
              >
                Replace {laneLabels[lane.sessionId] ?? lane.sessionId}
              </button>
            ))}
          </div>
          <button
            onClick={closeAddFlow}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            type="button"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

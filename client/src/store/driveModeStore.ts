import { create } from 'zustand';
import { DRIVE_MODE_MODELS as _DRIVE_MODE_MODELS } from '../components/DriveMode/driveModeModels';

export { _DRIVE_MODE_MODELS as DRIVE_MODE_MODELS };

export type DriveModePhase =
  | 'entry'
  | 'model-pick'
  | 'folder-pick'
  | 'session-pick'
  | 'dictate'
  | 'agent-working'
  | 'read-aloud-ready'
  | 'audio-playing';

/**
 * How many voice lanes ONE tab holds (owner decision, 2026-09-15: cap 3;
 * a fourth lane asks — replace or choose — and never appears silently).
 */
export const MAX_VOICE_LANES = 3;

/** One voice lane: a worker session held by this Voice Mode surface.
 *  The lane set is EMPTY in single-lane use — that is today's surface,
 *  byte for byte; lanes exist only once the operator adds a second. */
export interface DriveModeLane {
  sessionId: string;
}

export interface DriveModeModel {
  id: string;
  displayName: string;
  sdkType: 'pi' | 'claude' | 'opencode';
}

interface DriveModeState {
  isOpen: boolean;
  phase: DriveModePhase;
  selectedModelId: string | null;
  activeSessionId: string | null;
  lastAssistantText: string | null;
  /** The lanes this tab holds. Empty = single-lane (the shipped surface). */
  lanes: DriveModeLane[];
  /** The in-place add-lane picker is open over the mounted lanes. */
  addingLane: boolean;
  /** Set when the pick flow must REPLACE this lane (the cap was reached):
  *  the asking rule — a fourth lane never appears silently. */
  replacingLaneId: string | null;

  open: () => void;
  close: () => void;
  setPhase: (phase: DriveModePhase) => void;
  selectModel: (modelId: string) => void;
  setActiveSession: (sessionId: string) => void;
  setLastAssistantText: (text: string | null) => void;
  reset: () => void;

  /** In-place add-lane flow: opens the session picker OVER the mounted
   *  lanes (the dictate phase never changes, so no lane unmounts). */
  openAddLane: () => void;
  cancelAddLane: () => void;
  /** Mark the picked session as a REPLACEMENT for this lane (cap reached). */
  beginLaneReplace: (sessionId: string) => void;
  /** Add a lane for this session. Seeds the addressed session as lane 1
   *  when the set is empty. Returns 'added', 'duplicate', or 'full' — at
   *  the cap it refuses rather than adding a silent fourth lane. */
  addVoiceLane: (sessionId: string) => 'added' | 'duplicate' | 'full';
  /** Swap one lane's session in place, preserving lane order. */
  replaceVoiceLane: (oldSessionId: string, newSessionId: string) => 'replaced' | 'duplicate';
  /** Remove a lane. Down to one lane the set collapses to empty — the
   *  single-lane surface again. */
  removeVoiceLane: (sessionId: string) => void;
}

export const useDriveModeStore = create<DriveModeState>()((set, get) => ({
  isOpen: false,
  phase: 'entry',
  selectedModelId: null,
  activeSessionId: null,
  lastAssistantText: null,
  lanes: [],
  addingLane: false,
  replacingLaneId: null,

  open: () =>
    set({
      isOpen: true,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
      lanes: [],
      addingLane: false,
      replacingLaneId: null,
    }),

  close: () =>
    set({
      isOpen: false,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
      lanes: [],
      addingLane: false,
      replacingLaneId: null,
    }),

  setPhase: (phase) => set({ phase }),

  selectModel: (modelId) => set({ selectedModelId: modelId }),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setLastAssistantText: (text) => set({ lastAssistantText: text }),

  openAddLane: () => set({ addingLane: true, replacingLaneId: null }),

  cancelAddLane: () => set({ addingLane: false, replacingLaneId: null }),

  beginLaneReplace: (sessionId) => set({ addingLane: true, replacingLaneId: sessionId }),

  addVoiceLane: (sessionId) => {
    const state = get();
    if (state.lanes.some((lane) => lane.sessionId === sessionId)) return 'duplicate';
    const seeded = state.lanes.length === 0 && state.activeSessionId && state.activeSessionId !== sessionId;
    const current = seeded ? [{ sessionId: state.activeSessionId as string }] : state.lanes;
    if (current.length >= MAX_VOICE_LANES) return 'full';
    set({
      lanes: [...current, { sessionId }],
      addingLane: false,
      replacingLaneId: null,
    });
    return 'added';
  },

  replaceVoiceLane: (oldSessionId, newSessionId) => {
    const state = get();
    if (state.lanes.some((lane) => lane.sessionId === newSessionId)) return 'duplicate';
    set({
      lanes: state.lanes.map((lane) => (lane.sessionId === oldSessionId ? { sessionId: newSessionId } : lane)),
      addingLane: false,
      replacingLaneId: null,
    });
    return 'replaced';
  },

  removeVoiceLane: (sessionId) => {
    const state = get();
    const remaining = state.lanes.filter((lane) => lane.sessionId !== sessionId);
    // One lane left is the operator's original single-lane surface: collapse
    // to the empty set (and keep that survivor as the addressed session).
    if (remaining.length === 1) {
      set({ lanes: [], activeSessionId: remaining[0].sessionId });
      return;
    }
    set({ lanes: remaining });
  },

  reset: () =>
    set({
      isOpen: true,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
      lanes: [],
      addingLane: false,
      replacingLaneId: null,
    }),
}));

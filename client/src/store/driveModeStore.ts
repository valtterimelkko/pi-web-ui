import { create } from 'zustand';

export type DriveModePhase =
  | 'entry'
  | 'model-pick'
  | 'session-pick'
  | 'dictate'
  | 'agent-working'
  | 'read-aloud-ready'
  | 'audio-playing';

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

  open: () => void;
  close: () => void;
  setPhase: (phase: DriveModePhase) => void;
  selectModel: (modelId: string) => void;
  setActiveSession: (sessionId: string) => void;
  setLastAssistantText: (text: string | null) => void;
  reset: () => void;
}

export const useDriveModeStore = create<DriveModeState>()((set) => ({
  isOpen: false,
  phase: 'entry',
  selectedModelId: null,
  activeSessionId: null,
  lastAssistantText: null,

  open: () =>
    set({
      isOpen: true,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
    }),

  close: () =>
    set({
      isOpen: false,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
    }),

  setPhase: (phase) => set({ phase }),

  selectModel: (modelId) => set({ selectedModelId: modelId }),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setLastAssistantText: (text) => set({ lastAssistantText: text }),

  reset: () =>
    set({
      isOpen: true,
      phase: 'entry',
      selectedModelId: null,
      activeSessionId: null,
      lastAssistantText: null,
    }),
}));

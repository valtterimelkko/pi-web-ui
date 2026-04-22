import { create } from 'zustand';

export type TransferScope = 'visible_recent' | 'visible_full';

export interface TransferSourceMeta {
  sessionId: string;
  displayName: string;
  sdkType: 'pi' | 'claude' | 'opencode';
  cwd: string;
}

export interface TransferTargetMeta {
  sessionId?: string;
  displayName?: string;
  sdkType?: 'pi' | 'claude' | 'opencode';
  cwd?: string;
}

export type TransferTargetMode = 'existing' | 'new';

export type TransferStatus = 'idle' | 'confirming' | 'submitting' | 'succeeded' | 'failed';

export interface TransferError {
  code: string;
  message: string;
}

export interface TransferState {
  isDragging: boolean;
  source: TransferSourceMeta | null;
  hoverTargetId: string | null;
  status: TransferStatus;
  targetMode: TransferTargetMode;
  existingTarget: TransferTargetMeta | null;
  newTargetRuntime: 'pi' | 'claude' | 'opencode';
  newTargetCwd: string;
  scope: TransferScope;
  error: TransferError | null;
  createdSessionId: string | null;
}

export interface TransferActions {
  startDrag: (source: TransferSourceMeta) => void;
  endDrag: () => void;
  setHoverTarget: (targetId: string | null) => void;
  openConfirmExisting: (source: TransferSourceMeta, target: TransferTargetMeta) => void;
  openConfirmNew: (source: TransferSourceMeta) => void;
  cancel: () => void;
  setScope: (scope: TransferScope) => void;
  setNewTargetRuntime: (runtime: 'pi' | 'claude' | 'opencode') => void;
  setNewTargetCwd: (cwd: string) => void;
  setSubmitting: () => void;
  setSucceeded: (targetSessionId: string) => void;
  setFailed: (code: string, message: string) => void;
  reset: () => void;
}

const initialState: TransferState = {
  isDragging: false,
  source: null,
  hoverTargetId: null,
  status: 'idle',
  targetMode: 'existing',
  existingTarget: null,
  newTargetRuntime: 'pi',
  newTargetCwd: '/root',
  scope: 'visible_recent',
  error: null,
  createdSessionId: null,
};

export const useTransferStore = create<TransferState & TransferActions>()((set) => ({
  ...initialState,

  startDrag: (source) => set({
    isDragging: true,
    source,
    hoverTargetId: null,
    status: 'idle',
    error: null,
    createdSessionId: null,
  }),

  endDrag: () => set((state) => {
    if (state.status === 'confirming' || state.status === 'submitting') {
      return { isDragging: false, hoverTargetId: null };
    }
    return { ...initialState };
  }),

  setHoverTarget: (targetId) => set({ hoverTargetId: targetId }),

  openConfirmExisting: (source, target) => set({
    isDragging: false,
    hoverTargetId: null,
    status: 'confirming',
    targetMode: 'existing',
    source,
    existingTarget: target,
    scope: 'visible_recent',
    error: null,
    createdSessionId: null,
  }),

  openConfirmNew: (source) => set({
    isDragging: false,
    hoverTargetId: null,
    status: 'confirming',
    targetMode: 'new',
    source,
    existingTarget: null,
    newTargetRuntime: 'pi',
    newTargetCwd: source.cwd || '/root',
    scope: 'visible_recent',
    error: null,
    createdSessionId: null,
  }),

  cancel: () => set({ ...initialState }),

  setScope: (scope) => set({ scope }),

  setNewTargetRuntime: (runtime) => set({ newTargetRuntime: runtime }),

  setNewTargetCwd: (cwd) => set({ newTargetCwd: cwd }),

  setSubmitting: () => set({ status: 'submitting', error: null }),

  setSucceeded: (targetSessionId) => set({
    status: 'succeeded',
    createdSessionId: targetSessionId,
    error: null,
  }),

  setFailed: (code, message) => set({
    status: 'failed',
    error: { code, message },
  }),

  reset: () => set({ ...initialState }),
}));

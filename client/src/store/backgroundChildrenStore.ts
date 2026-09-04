import { create } from 'zustand';
import type { ChildCardProjection } from '@pi-web-ui/shared';

/**
 * Per-session registry of background children (contract 1.34.0 child
 * surfacing). Populated by `background_child_state` broadcasts — the server
 * synthesizes these from the subagent extension's on-disk snapshot (the truth
 * channel) and pushes them on every state transition.
 *
 * The store keeps only the LATEST list per session: settled children disappear
 * from the snapshot when the extension prunes them, by design — the durable
 * transcript card in the message list carries the final state.
 */
interface BackgroundChildrenState {
  bySession: Record<string, ChildCardProjection[]>;
  applyChildren: (sessionId: string, children: ChildCardProjection[]) => void;
  clear: (sessionId: string) => void;
  /** Resolve one child by its stable id (background taskId / child session id). */
  getChild: (sessionId: string, childId: string) => ChildCardProjection | undefined;
}

export const useBackgroundChildrenStore = create<BackgroundChildrenState>()((set, get) => ({
  bySession: {},
  applyChildren: (sessionId, children) => {
    set((state) => ({ bySession: { ...state.bySession, [sessionId]: children } }));
  },
  clear: (sessionId) => {
    set((state) => {
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
  getChild: (sessionId, childId) => {
    return get().bySession[sessionId]?.find((c) => c.id === childId);
  },
}));

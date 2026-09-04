import { create } from 'zustand';
import type { WatchCardProjection } from '@pi-web-ui/shared';

/**
 * Per-session registry of watch cards (contract 1.34.0 watch surfacing).
 * Populated by `watch_registered` / `watch_fired` broadcasts the server
 * synthesizes for the arming (parent) session. Presentation only — the
 * durable watch ledger on the server remains the truth channel.
 */
interface WatchSurfacingState {
  bySession: Record<string, WatchCardProjection[]>;
  upsert: (sessionId: string, watch: WatchCardProjection) => void;
  markFired: (sessionId: string, watchId: string, deliveryKind?: string) => void;
  clear: (sessionId: string) => void;
  getWatch: (sessionId: string, watchId: string) => WatchCardProjection | undefined;
}

export const useWatchSurfacingStore = create<WatchSurfacingState>()((set, get) => ({
  bySession: {},
  upsert: (sessionId, watch) => {
    set((state) => {
      const existing = state.bySession[sessionId] ?? [];
      const idx = existing.findIndex((w) => w.watchId === watch.watchId);
      const next = idx >= 0
        ? existing.map((w) => (w.watchId === watch.watchId ? watch : w))
        : [...existing, watch];
      return { bySession: { ...state.bySession, [sessionId]: next } };
    });
  },
  markFired: (sessionId, watchId, deliveryKind) => {
    set((state) => {
      const existing = state.bySession[sessionId];
      if (!existing) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: existing.map((w) => (w.watchId === watchId
            ? { ...w, status: 'fired' as const, ...(deliveryKind ? { deliveryKind } : {}) }
            : w)),
        },
      };
    });
  },
  clear: (sessionId) => {
    set((state) => {
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
  getWatch: (sessionId, watchId) => {
    return get().bySession[sessionId]?.find((w) => w.watchId === watchId);
  },
}));

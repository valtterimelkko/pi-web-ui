import { create } from 'zustand';

interface TerminalState {
  connected: boolean;
  error: string | null;
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  connected: false,
  error: null,
  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),
}));

import { create } from 'zustand';

interface UIState {
  // Theme
  theme: 'dark' | 'light';

  // Modals
  settingsOpen: boolean;
  modelSelectorOpen: boolean;

  // Notifications
  toasts: Array<{
    id: string;
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
  }>;

  // Actions
  toggleTheme: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  openSettings: () => void;
  closeSettings: () => void;
  openModelSelector: () => void;
  closeModelSelector: () => void;
  addToast: (toast: Omit<UIState['toasts'][0], 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: 'light',
  settingsOpen: false,
  modelSelectorOpen: false,
  toasts: [],

  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
  setTheme: (theme) => set({ theme }),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  openModelSelector: () => set({ modelSelectorOpen: true }),
  closeModelSelector: () => set({ modelSelectorOpen: false }),

  addToast: (toast) => set((state) => ({
    toasts: [...state.toasts, { ...toast, id: `toast_${Date.now()}` }],
  })),

  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id),
  })),
}));

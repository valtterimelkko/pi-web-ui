import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RecentFolder {
  path: string;
  label: string;
  count: number;
  lastUsed: number;
}

interface UIState {
  // Theme
  theme: 'dark' | 'light';

  // Modals
  settingsOpen: boolean;
  modelSelectorOpen: boolean;
  sessionInfoOpen: boolean;
  treeViewOpen: boolean;
  driveModeOpen: boolean;

  // Notifications
  toasts: Array<{
    id: string;
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
  }>;

  // Recent folders for session creation
  recentFolders: RecentFolder[];

  // Actions
  toggleTheme: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  openSettings: () => void;
  closeSettings: () => void;
  openModelSelector: () => void;
  closeModelSelector: () => void;
  openSessionInfo: () => void;
  closeSessionInfo: () => void;
  openTreeView: () => void;
  closeTreeView: () => void;
  openDriveMode: () => void;
  closeDriveMode: () => void;
  addToast: (toast: Omit<UIState['toasts'][0], 'id'>) => void;
  removeToast: (id: string) => void;
  addRecentFolder: (path: string) => void;
  getRecentFolders: (limit?: number) => RecentFolder[];
  clearRecentFolders: () => void;
}

// Extract label from path (last part of the path)
const extractLabelFromPath = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      settingsOpen: false,
      modelSelectorOpen: false,
      sessionInfoOpen: false,
      treeViewOpen: false,
      driveModeOpen: false,
      toasts: [],
      recentFolders: [],

      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setTheme: (theme) => set({ theme }),

      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),

      openModelSelector: () => set({ modelSelectorOpen: true }),
      closeModelSelector: () => set({ modelSelectorOpen: false }),

      openSessionInfo: () => set({ sessionInfoOpen: true }),
      closeSessionInfo: () => set({ sessionInfoOpen: false }),

      openTreeView: () => set({ treeViewOpen: true }),
      closeTreeView: () => set({ treeViewOpen: false }),

      openDriveMode: () => set({ driveModeOpen: true }),
      closeDriveMode: () => set({ driveModeOpen: false }),

      addToast: (toast) => set((state) => ({
        toasts: [...state.toasts, { ...toast, id: `toast_${Date.now()}` }],
      })),

      removeToast: (id) => set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      })),

      addRecentFolder: (path: string) => {
        const label = extractLabelFromPath(path);
        set((state) => {
          const existingIndex = state.recentFolders.findIndex((f) => f.path === path);
          let newFolders: RecentFolder[];

          if (existingIndex >= 0) {
            // Update existing folder
            newFolders = state.recentFolders.map((f, index) =>
              index === existingIndex
                ? { ...f, count: f.count + 1, lastUsed: Date.now() }
                : f
            );
          } else {
            // Add new folder
            newFolders = [
              ...state.recentFolders,
              { path, label, count: 1, lastUsed: Date.now() },
            ];
          }

          // Sort by count (popularity) descending, then by lastUsed
          newFolders.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return b.lastUsed - a.lastUsed;
          });

          // Keep only top 20 folders
          return { recentFolders: newFolders.slice(0, 20) };
        });
      },

      getRecentFolders: (limit = 10) => {
        return get().recentFolders.slice(0, limit);
      },

      clearRecentFolders: () => set({ recentFolders: [] }),
    }),
    {
      name: 'pi-web-ui-ui-store',
      partialize: (state) => ({
        theme: state.theme,
        recentFolders: state.recentFolders,
      }),
    }
  )
);

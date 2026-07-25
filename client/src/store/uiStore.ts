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
    /** Long, multi-line payloads (e.g. `/goal report`) wait for a dismissal. */
    sticky?: boolean;
  }>;

  /**
   * Recent notifications, newest first. Extensions deliver reports and warnings
   * as one-shot notifications; without a log a `/goal report` is gone in five
   * seconds and cannot be read back.
   */
  notificationLog: Array<{
    id: string;
    type: 'info' | 'success' | 'warning' | 'error';
    message: string;
    sessionId: string | null;
    at: number;
    read: boolean;
  }>;
  notificationTrayOpen: boolean;

  /** Per-session expand/collapse choice for the goal panel. */
  goalPanelExpanded: Record<string, boolean>;

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
  logNotification: (entry: { type: 'info' | 'success' | 'warning' | 'error'; message: string; sessionId: string | null }) => void;
  openNotificationTray: () => void;
  closeNotificationTray: () => void;
  markNotificationsRead: () => void;
  clearNotificationLog: () => void;
  setGoalPanelExpanded: (sessionId: string, expanded: boolean) => void;
  addRecentFolder: (path: string) => void;
  getRecentFolders: (limit?: number) => RecentFolder[];
  clearRecentFolders: () => void;
}

/** Monotonic suffix so ids minted in the same millisecond stay unique. */
let toastSequence = 0;

/** How many notifications the tray keeps. */
const NOTIFICATION_LOG_LIMIT = 50;

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
      notificationLog: [],
      notificationTrayOpen: false,
      goalPanelExpanded: {},
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

      // Two notifications can land in the same millisecond (the goal extension
      // emits several at a run boundary), so the id needs a counter to stay
      // unique — a duplicate React key silently drops a toast.
      addToast: (toast) => set((state) => ({
        toasts: [...state.toasts, { ...toast, id: `toast_${Date.now()}_${toastSequence++}` }],
      })),

      removeToast: (id) => set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      })),

      logNotification: (entry) => set((state) => ({
        notificationLog: [
          { ...entry, id: `notif_${Date.now()}_${toastSequence++}`, at: Date.now(), read: false },
          ...state.notificationLog,
        ].slice(0, NOTIFICATION_LOG_LIMIT),
      })),

      openNotificationTray: () => set((state) => ({
        notificationTrayOpen: true,
        notificationLog: state.notificationLog.map((entry) => ({ ...entry, read: true })),
      })),
      closeNotificationTray: () => set({ notificationTrayOpen: false }),
      markNotificationsRead: () => set((state) => ({
        notificationLog: state.notificationLog.map((entry) => ({ ...entry, read: true })),
      })),
      clearNotificationLog: () => set({ notificationLog: [] }),

      setGoalPanelExpanded: (sessionId, expanded) => set((state) => ({
        goalPanelExpanded: { ...state.goalPanelExpanded, [sessionId]: expanded },
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
        goalPanelExpanded: state.goalPanelExpanded,
      }),
    }
  )
);

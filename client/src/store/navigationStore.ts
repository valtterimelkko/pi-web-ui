import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Tab = 'chat' | 'shell' | 'files' | 'git' | 'tasks';

interface NavigationState {
  activeTab: Tab;
  isMobile: boolean;
  setActiveTab: (tab: Tab) => void;
  setIsMobile: (isMobile: boolean) => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set) => ({
      activeTab: 'chat',
      isMobile: typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false,
      setActiveTab: (tab) => set({ activeTab: tab }),
      setIsMobile: (isMobile) => set({ isMobile }),
    }),
    {
      name: 'pi-navigation',
      partialize: (state) => ({ activeTab: state.activeTab }),
    }
  )
);

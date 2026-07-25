import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useSessionStore } from './sessionStore';
import { isPiSlashCommandAllowedWhileStreaming } from '../lib/piExtensionControls';

interface DraftState {
  drafts: Record<string, string>;
  currentDraft: string;
  sendCallback?: (content: string, sessionPath?: string) => Promise<boolean>;
}

interface DraftActions {
  setDraft: (sessionId: string, content: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;
  syncCurrentDraft: () => void;
  sendDraft: (sessionId: string) => Promise<boolean>;
  setSendCallback: (callback: (content: string, sessionPath?: string) => Promise<boolean>) => void;
}

export type DraftStore = DraftState & DraftActions;

export const useDraftStore = create<DraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      currentDraft: '',
      sendCallback: undefined,

      setDraft: (sessionId, content) => {
        set((state) => {
          const currentSessionId = useSessionStore.getState().currentSessionId;
          const isCurrentSession = currentSessionId === sessionId;
          
          return {
            drafts: {
              ...state.drafts,
              [sessionId]: content,
            },
            // Update currentDraft if this is the current session
            ...(isCurrentSession ? { currentDraft: content } : {}),
          };
        });
      },

      getDraft: (sessionId) => {
        const state = get();
        return state.drafts[sessionId] ?? '';
      },

      clearDraft: (sessionId) => {
        set((state) => {
          const currentSessionId = useSessionStore.getState().currentSessionId;
          const isCurrentSession = currentSessionId === sessionId;
          
          // Remove the session key from drafts object
          const newDrafts = { ...state.drafts };
          delete newDrafts[sessionId];
          
          return {
            drafts: newDrafts,
            // Clear currentDraft if this is the current session
            ...(isCurrentSession ? { currentDraft: '' } : {}),
          };
        });
      },

      syncCurrentDraft: () => {
        const currentSessionId = useSessionStore.getState().currentSessionId;
        
        if (!currentSessionId) {
          set({ currentDraft: '' });
          return;
        }
        
        const drafts = get().drafts;
        set({ currentDraft: drafts[currentSessionId] ?? '' });
      },

      sendDraft: async (sessionId) => {
        const state = get();
        const sessionState = useSessionStore.getState();
        
        // Get the draft content
        const content = (state.drafts[sessionId] ?? '').trim();
        
        // Don't send if empty or whitespace only
        if (!content) {
          return false;
        }
        
        // Don't send while that session is streaming — except for Pi extension
        // slash commands. AgentSession.prompt() resolves extension commands
        // before its own streaming guard, which is what makes /goal pause-now
        // (and the rest of the goal controls) usable mid-run; the composer keeps
        // them enabled for exactly that reason, so this guard has to agree or
        // the command is dropped silently in the browser.
        // `isStreaming` tracks the viewed session, so a background session is
        // judged by its own entry in streamingSessions.
        const isViewedSession = sessionState.currentSessionId === sessionId;
        const sessionIsStreaming = sessionState.streamingSessions[sessionId]
          ?? (isViewedSession ? sessionState.isStreaming : false);
        if (
          sessionIsStreaming
          && !isPiSlashCommandAllowedWhileStreaming(
            content,
            true,
            isViewedSession ? sessionState.currentSessionSdkType : sessionState.sessions.find((s) => s.id === sessionId)?.sdkType,
          )
        ) {
          return false;
        }
        
        // Don't send if no callback is registered
        if (!state.sendCallback) {
          return false;
        }
        
        // Find session path for the callback
        const session = sessionState.sessions.find(s => s.id === sessionId);
        const sessionPath = session?.path;
        
        // Send the message
        try {
          await state.sendCallback(content, sessionPath);
          
          // Clear the draft after successful send
          set((s) => {
            const currentSessionId = useSessionStore.getState().currentSessionId;
            const isCurrentSession = currentSessionId === sessionId;
            
            const newDrafts = { ...s.drafts };
            delete newDrafts[sessionId];
            
            return {
              drafts: newDrafts,
              ...(isCurrentSession ? { currentDraft: '' } : {}),
            };
          });
          
          return true;
        } catch (error) {
          console.error('Failed to send draft:', error);
          return false;
        }
      },

      setSendCallback: (callback) => {
        set({ sendCallback: callback });
      },
    }),
    {
      name: 'pi-web-ui-drafts',
      partialize: (state) => ({
        drafts: state.drafts,
        currentDraft: state.currentDraft,
      }),
    }
  )
);

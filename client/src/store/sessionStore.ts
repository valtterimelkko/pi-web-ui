import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Session {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  createdAt?: string;
  lastActivity?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; thinking?: string }>;
  timestamp: number;
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  toolResult?: {
    output: string;
    isError: boolean;
  };
}

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  messages: Message[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setCurrentSession: (sessionId: string | null) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setStreaming: (isStreaming: boolean) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  
  // WebSocket event handlers
  handleServerMessage: (message: unknown) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,

      setSessions: (sessions) => set({ sessions }),

      setCurrentSession: (sessionId) => {
        set({ 
          currentSessionId: sessionId,
          messages: [], // Clear messages when switching
        });
      },

      addMessage: (message) => {
        set((state) => ({
          messages: [...state.messages, message],
        }));
      },

      updateMessage: (id, updates) => {
        set((state) => ({
          messages: state.messages.map((msg) =>
            msg.id === id ? { ...msg, ...updates } : msg
          ),
        }));
      },

      setStreaming: (isStreaming) => set({ isStreaming }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error }),

      clearMessages: () => set({ messages: [] }),

      handleServerMessage: (message: unknown) => {
        const msg = message as { type: string; [key: string]: unknown };

        switch (msg.type) {
          case 'sessions_list':
            set({ sessions: (msg.sessions as Session[]) || [] });
            break;

          case 'session_created':
            set({ currentSessionId: msg.sessionId as string });
            break;

          case 'session_switched':
            set({ 
              currentSessionId: msg.sessionId as string,
              messages: [],
            });
            break;

          case 'agent_start':
            set({ isStreaming: true, isLoading: false });
            break;

          case 'agent_end':
            set({ isStreaming: false });
            break;

          case 'message_start': {
            const messageData = (msg.message as { id: string; role: string; content: unknown }) || {};
            const newMessage: Message = {
              id: messageData.id || `msg_${Date.now()}`,
              role: messageData.role as 'user' | 'assistant' | 'tool',
              content: messageData.content as string,
              timestamp: Date.now(),
            };
            get().addMessage(newMessage);
            break;
          }

          case 'message_update': {
            // Update streaming content
            const { message: msgData, assistantMessageEvent } = msg as {
              message?: { id: string };
              assistantMessageEvent?: { type: string; delta?: string };
            };
            
            if (msgData?.id && assistantMessageEvent?.type === 'text_delta') {
              const existingMsg = get().messages.find(m => m.id === msgData.id);
              if (existingMsg) {
                const currentContent = typeof existingMsg.content === 'string' 
                  ? existingMsg.content 
                  : '';
                get().updateMessage(msgData.id, {
                  content: currentContent + (assistantMessageEvent.delta || ''),
                });
              }
            }
            break;
          }

          case 'tool_execution_start': {
            const { toolCallId, toolName, args } = msg as unknown as {
              toolCallId: string;
              toolName: string;
              args: unknown;
            };
            const toolMessage: Message = {
              id: toolCallId,
              role: 'tool',
              content: '',
              timestamp: Date.now(),
              toolCall: { id: toolCallId, name: toolName, args },
            };
            get().addMessage(toolMessage);
            break;
          }

          case 'tool_execution_update': {
            const { toolCallId, partialResult } = msg as unknown as {
              toolCallId: string;
              partialResult?: { content: Array<{ type: string; text?: string }> };
            };
            const content = partialResult?.content?.[0]?.text || '';
            get().updateMessage(toolCallId, { 
              content,
              toolResult: { output: content, isError: false },
            });
            break;
          }

          case 'tool_execution_end': {
            const { toolCallId, result, isError } = msg as unknown as {
              toolCallId: string;
              result?: { content: Array<{ type: string; text?: string }> };
              isError: boolean;
            };
            const content = result?.content?.[0]?.text || '';
            get().updateMessage(toolCallId, {
              content,
              toolResult: { output: content, isError },
            });
            break;
          }

          case 'error':
            set({ 
              error: (msg.message as string) || 'Unknown error',
              isStreaming: false,
              isLoading: false,
            });
            break;

          case 'session_update': {
            const { type, sessionId, info } = msg as {
              type: 'add' | 'change' | 'unlink';
              sessionId: string;
              info?: Session;
            };
            
            if (type === 'unlink') {
              // Remove deleted session
              set((state) => ({
                sessions: state.sessions.filter((s) => s.id !== sessionId),
              }));
            } else if (info) {
              // Add or update session
              set((state) => {
                const existingIndex = state.sessions.findIndex((s) => s.id === info.id);
                if (existingIndex >= 0) {
                  // Update existing
                  const newSessions = [...state.sessions];
                  newSessions[existingIndex] = info;
                  return { sessions: newSessions };
                } else {
                  // Add new
                  return { sessions: [info, ...state.sessions] };
                }
              });
            }
            break;
          }
        }
      },
    }),
    {
      name: 'pi-web-ui-session',
      partialize: (state) => ({ 
        currentSessionId: state.currentSessionId,
        sessions: state.sessions,
      }),
    }
  )
);

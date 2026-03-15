import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useUIStore } from './uiStore';

export interface Session {
  id: string;
  path: string;
  firstMessage: string;
  messageCount: number;
  cwd: string;
  name?: string;
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

interface ExtensionUIRequest {
  id: string;
  type: 'confirm' | 'select' | 'input' | 'editor';
  method: string;
  params: Record<string, unknown>;
  timeout: number;
}

export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  model?: string;
  contextWindow?: number;
  contextUsed?: number;
  contextPercent?: number;
}

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  currentModel: string | null;
  messages: Message[];
  isStreaming: boolean;
  isLoading: boolean;
  error: string | null;
  extensionUIRequest: ExtensionUIRequest | null;
  sessionInfo: SessionStats | null;
  // Context usage tracking
  contextPercent: number;
  contextUsed: number;
  contextWindow: number;

  // Actions
  setSessions: (sessions: Session[]) => void;
  setCurrentSession: (sessionId: string | null) => void;
  setCurrentModel: (modelId: string) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setStreaming: (isStreaming: boolean) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearMessages: () => void;
  setExtensionUIRequest: (request: ExtensionUIRequest | null) => void;
  setSessionInfo: (info: SessionStats | null) => void;
  
  // WebSocket event handlers
  handleServerMessage: (message: unknown) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      currentSessionId: null,
      currentModel: null,
      messages: [],
      isStreaming: false,
      isLoading: false,
      error: null,
      extensionUIRequest: null,
      sessionInfo: null,
      contextPercent: 0,
      contextUsed: 0,
      contextWindow: 0,

      setExtensionUIRequest: (request) => set({ extensionUIRequest: request }),
      setSessionInfo: (info) => set({ sessionInfo: info }),
      setCurrentModel: (modelId) => set({ currentModel: modelId }),

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
            set({ 
              currentSessionId: msg.sessionId as string,
              messages: [], // Clear messages for new session
              contextPercent: 0,
              contextUsed: 0,
              contextWindow: 0,
              sessionInfo: null,
            });
            break;

          case 'session_switched': {
            const switchMsg = msg as unknown as {
              sessionId: string;
              model?: string;
              contextWindow?: number;
              contextUsed?: number;
              contextPercent?: number;
              messages?: Array<{
                id: string;
                role: 'user' | 'assistant';
                content: string | Array<{ type: string; text?: string; thinking?: string }>;
                timestamp: number;
              }>;
            };
            
            // Transform server messages to client Message format
            const serverMessages = switchMsg.messages || [];
            const clientMessages: Message[] = serverMessages.map((serverMsg) => ({
              id: serverMsg.id,
              role: serverMsg.role,
              content: serverMsg.content,
              timestamp: serverMsg.timestamp,
            }));
            
            set({ 
              currentSessionId: switchMsg.sessionId,
              currentModel: switchMsg.model ?? null,
              messages: clientMessages,
              contextPercent: switchMsg.contextPercent ?? 0,
              contextUsed: switchMsg.contextUsed ?? 0,
              contextWindow: switchMsg.contextWindow ?? 0,
            });
            break;
          }

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
              content: messageData.content as Message['content'],
              timestamp: Date.now(),
            };
            get().addMessage(newMessage);
            break;
          }

          case 'message_update': {
            // Update streaming content
            const { message: msgData, assistantMessageEvent } = msg as {
              message?: { id: string; content?: Message['content'] };
              assistantMessageEvent?: { type: string; delta?: string };
            };
            
            if (msgData?.id && assistantMessageEvent) {
              const existingMsg = get().messages.find(m => m.id === msgData.id);
              if (existingMsg) {
                // Get existing content array or create new one
                let contentArray: Array<{ type: string; text?: string; thinking?: string }>;
                if (Array.isArray(existingMsg.content)) {
                  contentArray = [...existingMsg.content];
                } else if (typeof existingMsg.content === 'string') {
                  contentArray = existingMsg.content ? [{ type: 'text', text: existingMsg.content }] : [];
                } else {
                  contentArray = [];
                }

                const eventType = assistantMessageEvent.type;
                const delta = assistantMessageEvent.delta;

                // Handle text content (text_delta)
                if (eventType === 'text_delta') {
                  const lastEntry = contentArray[contentArray.length - 1];
                  if (lastEntry && lastEntry.type === 'text') {
                    lastEntry.text = (lastEntry.text || '') + delta;
                  } else {
                    contentArray.push({ type: 'text', text: delta });
                  }
                  get().updateMessage(msgData.id, { content: contentArray });
                }
                // Handle thinking content (thinking_delta)
                else if (eventType === 'thinking_delta') {
                  const lastEntry = contentArray[contentArray.length - 1];
                  if (lastEntry && lastEntry.type === 'thinking') {
                    lastEntry.thinking = (lastEntry.thinking || '') + delta;
                  } else {
                    contentArray.push({ type: 'thinking', thinking: delta });
                  }
                  get().updateMessage(msgData.id, { content: contentArray });
                }
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

          case 'extension_ui_request': {
            set({ extensionUIRequest: msg.request as ExtensionUIRequest });
            break;
          }

          case 'notification': {
            const { notification } = msg as unknown as {
              notification: { message: string; type: 'info' | 'warning' | 'error' };
            };
            useUIStore.getState().addToast({
              type: notification.type,
              message: notification.message,
            });
            break;
          }

          case 'model_changed': {
            const modelId = msg.modelId as string;
            const modelName = modelId.split('/').pop()?.replace(/-/g, ' ') || modelId;
            set({ currentModel: modelId });
            // Show success toast
            useUIStore.getState().addToast({
              type: 'success',
              message: `Model changed to ${modelName}`,
            });
            break;
          }

          case 'session_info': {
            const { stats } = msg as unknown as { stats: SessionStats };
            set({ sessionInfo: stats });
            break;
          }

          case 'compaction_result': {
            const { tokensBefore } = msg as unknown as { summary: string; tokensBefore: number };
            // Show toast notification
            useUIStore.getState().addToast({
              type: 'success',
              message: `Context compacted successfully! ${tokensBefore} tokens summarized.`,
            });
            break;
          }

          case 'session_name_updated':
          case 'session_name_changed': {
            const nameMsg = msg as unknown as { sessionId: string; name: string };
            set((state) => ({
              sessions: state.sessions.map((s) =>
                s.id === nameMsg.sessionId ? { ...s, name: nameMsg.name } : s
              ),
            }));
            break;
          }
        }
      },
    }),
    {
      name: 'pi-web-ui-session',
      partialize: (state) => ({ 
        sessions: state.sessions,
      }),
    }
  )
);

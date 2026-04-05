/**
 * useSessionStream Hook - Ref-Based Streaming for Mobile Performance
 *
 * This hook implements a ref-based streaming pattern that minimizes re-renders
 * during content accumulation. All streaming content is accumulated in refs
 * and only committed to state when turns complete.
 *
 * IMPORTANT: This hook does NOT create its own WebSocket connection. It
 * subscribes to the EXISTING singleton WebSocket managed by useWebSocket
 * via getWebSocketInstance().addMessageListener().
 *
 * Key Features:
 * - Subscribes to global singleton WebSocket (no separate connection)
 * - Ref-based accumulation (no re-renders during streaming)
 * - Identity guards prevent stale callbacks after session switches
 * - Atomic teardown with useLayoutEffect (runs before paint)
 * - History replay handling for session switching
 * - Single dependency effect (only sessionId)
 *
 * Event Processing:
 *   agent_start           → setStatus('streaming')
 *   agent_end             → commitStreamingMessage(), setStatus('idle')
 *   message_start(user)   → add to messages immediately
 *   message_start(assist) → track ID, start accumulating
 *   message_update(text)  → accumulate in textRef (NO state update)
 *   message_update(think) → accumulate in thinkingRef (NO state update)
 *   message_end           → commitStreamingMessage()
 *   tool_execution_start  → add tool message to messages
 *   tool_execution_update → update partial tool result
 *   tool_execution_end    → update tool message with result
 *   history_start         → clear messages, set isReplaying
 *   history_end           → setIsReplaying(false)
 *
 * CRITICAL: This is the MOST CRITICAL module for mobile performance.
 */

import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { getWebSocketInstance } from '../lib/websocket.js';
import type { Attachment } from '@pi-web-ui/shared';

// ============================================================================
// Types
// ============================================================================

/**
 * Content part types for live messages
 */
export type ContentPartType = 'text' | 'thinking';

/**
 * A content part in a live message
 */
export interface ContentPart {
  type: ContentPartType;
  text?: string;
  thinking?: string;
}

/**
 * Tool call state during streaming
 */
export interface ToolCallState {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  status: 'pending' | 'success' | 'error';
}

/**
 * A live message being streamed or completed
 */
export interface LiveMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  toolResult?: {
    output: string;
    isError: boolean;
  };
  timestamp: number;
  isComplete: boolean;
}

/**
 * Chat status for the session
 */
export type ChatStatus = 'idle' | 'busy' | 'streaming' | 'error';

/**
 * Result type for the useSessionStream hook
 */
export interface UseSessionStreamResult {
  /** All complete messages in the session */
  messages: LiveMessage[];
  /** Current chat status */
  status: ChatStatus;
  /** Context usage percentage (0-100) */
  contextPercent: number;
  /** Current step number for multi-step operations */
  currentStep: number;
  /** Whether the session is replaying history */
  isReplaying: boolean;
  /** Streaming content for the current message (updated frequently) */
  streamingContent: ContentPart[];
  /** Active tool calls in progress */
  activeToolCalls: ToolCallState[];

  // Actions
  /** Send a prompt to the agent */
  sendPrompt: (content: string, attachments?: Attachment[]) => Promise<void>;
  /** Cancel the current turn */
  cancelCurrentTurn: () => void;
  /** Clear all messages */
  clearMessages: () => void;
}

/**
 * Options for the useSessionStream hook
 */
export interface UseSessionStreamOptions {
  /** Enable debug logging */
  debug?: boolean;
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an empty message
 */
function createEmptyMessage(role: 'user' | 'assistant' | 'tool'): LiveMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    role,
    content: [],
    timestamp: Date.now(),
    isComplete: false,
  };
}

/**
 * Build content parts from refs
 */
function buildContentParts(
  text: string,
  thinking: string,
): ContentPart[] {
  const parts: ContentPart[] = [];

  // Add thinking content first (shown before text)
  if (thinking) {
    parts.push({ type: 'thinking', thinking });
  }

  // Add text content
  if (text) {
    parts.push({ type: 'text', text });
  }

  return parts;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * useSessionStream Hook
 *
 * Implements ref-based streaming for optimal mobile performance.
 * Subscribes to the global singleton WebSocket — does NOT create its own connection.
 * All content accumulation happens in refs to avoid re-renders.
 * State is only updated when complete messages are ready.
 *
 * @param sessionId - The session ID to connect to (null to disconnect)
 * @param options - Configuration options
 * @returns UseSessionStreamResult with messages, status, and actions
 *
 * @example
 * ```typescript
 * function ChatView({ sessionId }: { sessionId: string }) {
 *   const {
 *     messages,
 *     status,
 *     streamingContent,
 *     sendPrompt,
 *     cancelCurrentTurn,
 *   } = useSessionStream(sessionId);
 *
 *   const handleSubmit = async (text: string) => {
 *     await sendPrompt(text);
 *   };
 *
 *   return (
 *     <div>
 *       {messages.map(msg => <Message key={msg.id} message={msg} />)}
 *       {status === 'streaming' && (
 *         <StreamingContent content={streamingContent} />
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSessionStream(
  sessionId: string | null,
  options: UseSessionStreamOptions = {}
): UseSessionStreamResult {
  const {
    debug = false,
    autoConnect = true,
  } = options;

  // ========================================
  // REFS FOR ACCUMULATION (NO RE-RENDERS)
  // ========================================

  // Text accumulation - updated frequently during streaming
  const textRef = useRef<string>('');

  // Thinking accumulation - updated during thinking blocks
  const thinkingRef = useRef<string>('');

  // Tool calls in progress - map by tool call ID
  const toolCallsRef = useRef<Map<string, ToolCallState>>(new Map());

  // Current message being built
  const currentMessageRef = useRef<LiveMessage | null>(null);

  // Current streaming message ID (for matching message_update events)
  const currentMessageIdRef = useRef<string>('');

  // Identity guard ref — incremented on each session change
  const identityRef = useRef<number>(0);

  // Active session ID ref — updated SYNCHRONOUSLY on session_switched
  // so that subsequent session_event messages in the same WS batch pass the filter
  const activeSessionIdRef = useRef<string | null>(sessionId);

  // Unsubscribe function for the WebSocket listener
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ========================================
  // STATE ONLY FOR COMPLETE MESSAGES / UI
  // ========================================

  // Complete messages (only updated when turn ends)
  const [messages, setMessages] = useState<LiveMessage[]>([]);

  // Status
  const [status, setStatus] = useState<ChatStatus>('idle');

  // Context tracking
  const [contextPercent, setContextPercent] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);

  // Replay state
  const [isReplaying, setIsReplaying] = useState(false);

  // Streaming content for UI (updated via forceUpdate mechanism)
  const [, forceUpdate] = useState(0);
  const streamingUpdateTimerRef = useRef<number>(0);
  const lastStreamingUpdateRef = useRef<number>(0);

  // ========================================
  // DEBUG LOGGING
  // ========================================

  const log = useCallback(
    (...args: unknown[]) => {
      if (debug) {
        console.log(
          '[useSessionStream]',
          `[session:${sessionId?.slice(0, 8)}]`,
          ...args
        );
      }
    },
    [debug, sessionId]
  );

  // ========================================
  // STREAMING UPDATE OPTIMIZATION
  // ========================================

  /**
   * Request a streaming content update.
   * Throttled to max 60fps (16ms intervals).
   */
  const requestStreamingUpdate = useCallback(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastStreamingUpdateRef.current;

    if (timeSinceLastUpdate < 16) {
      if (streamingUpdateTimerRef.current === 0) {
        streamingUpdateTimerRef.current = window.setTimeout(() => {
          streamingUpdateTimerRef.current = 0;
          lastStreamingUpdateRef.current = Date.now();
          forceUpdate((n) => n + 1);
        }, 16 - timeSinceLastUpdate);
      }
    } else {
      lastStreamingUpdateRef.current = now;
      forceUpdate((n) => n + 1);
    }
  }, []);

  // ========================================
  // COMMIT STREAMING MESSAGE
  // ========================================

  /**
   * Commit the accumulated streaming content to the messages state.
   * This is the ONLY place where streaming content becomes a message.
   */
  const commitStreamingMessage = useCallback(() => {
    if (currentMessageRef.current) {
      const finalContent = buildContentParts(
        textRef.current,
        thinkingRef.current,
      );

      currentMessageRef.current.content = finalContent;
      currentMessageRef.current.isComplete = true;

      // Capture in local variable BEFORE nulling the ref,
      // because React may defer the setMessages callback.
      const msg = currentMessageRef.current;
      setMessages((prev) => [...prev, msg]);
    }

    // Reset accumulation refs for next message
    textRef.current = '';
    thinkingRef.current = '';
    currentMessageRef.current = null;
    currentMessageIdRef.current = '';
  }, []);

  // ========================================
  // MESSAGE HANDLER (subscribes to global WebSocket)
  // ========================================

  /**
   * Process a single incoming message from the global WebSocket.
   * Uses identityRef to guard against stale callbacks.
   */
  const processMessage = useCallback((rawMessage: unknown, identity: number) => {
    // Identity guard: bail if session has changed
    if (identityRef.current !== identity) return;

    const msg = rawMessage as { type: string; sessionId?: string; event?: { type: string; [key: string]: unknown }; [key: string]: unknown };

    // Handle top-level messages (type is direct)
    // and session_event messages (event wrapper from multi-session routing)
    let eventType: string;
    let eventData: Record<string, unknown>;
    let eventSessionId: string | undefined;

    if (msg.type === 'session_event' && msg.event) {
      // Multi-session event wrapper
      const sessionEvent = msg as { sessionId: string; event: { type: string; [key: string]: unknown } };
      eventType = sessionEvent.event.type;
      eventData = sessionEvent.event;
      eventSessionId = sessionEvent.sessionId;
    } else {
      // Direct top-level message
      eventType = msg.type;
      eventData = msg as Record<string, unknown>;
      eventSessionId = msg.sessionId as string | undefined;
    }

    // Filter: only process events for our session
    // For session_event: match activeSessionIdRef (updated synchronously on session_switched)
    // For top-level events (history_start/end, session_switched): always process
    if (msg.type === 'session_event' && eventSessionId && 
        activeSessionIdRef.current && eventSessionId !== activeSessionIdRef.current) {
      return; // Not for our session
    }

    switch (eventType) {
      // ---- Session switched (Pi SDK embeds messages, Claude uses history replay) ----
      case 'session_switched': {
        const switchMsg = eventData as {
          sessionId?: string;
          messages?: Array<{
            id: string;
            role: string;
            content: string | Array<{ type: string; text?: string; thinking?: string }>;
            timestamp: number;
          }>;
        };

        // Update active session ref SYNCHRONOUSLY so subsequent session_events
        // in the same WebSocket message batch pass the filter
        if (switchMsg.sessionId) {
          activeSessionIdRef.current = switchMsg.sessionId;
        }

        // Load embedded messages (Pi SDK path)
        if (switchMsg.messages && switchMsg.messages.length > 0) {
          const loaded: LiveMessage[] = switchMsg.messages.map((m) => {
            let content: ContentPart[];
            if (typeof m.content === 'string') {
              content = m.content ? [{ type: 'text' as const, text: m.content }] : [];
            } else if (Array.isArray(m.content)) {
              content = m.content.map((p) => {
                if (p.type === 'thinking') return { type: 'thinking' as const, thinking: p.thinking || p.text || '' };
                return { type: 'text' as const, text: p.text || '' };
              });
            } else {
              content = [];
            }
            return {
              id: m.id,
              role: m.role as 'user' | 'assistant' | 'tool',
              content,
              timestamp: m.timestamp,
              isComplete: true,
            };
          });
          setMessages(loaded);
          setIsReplaying(false);
        } else {
          // No embedded messages — history replay will follow (Claude path)
          // or session is empty
          setMessages([]);
        }
        break;
      }

      // ---- Agent lifecycle ----
      case 'agent_start':
        setStatus('streaming');
        break;

      case 'agent_end':
        commitStreamingMessage();
        setStatus('idle');
        break;

      // ---- Message streaming ----
      case 'message_start': {
        const messageData = (eventData.message as { id?: string; role?: string; content?: unknown }) || {};
        const messageId = messageData.id || `msg_${Date.now()}`;
        const role = messageData.role as string;

        if (role === 'user') {
          // User messages are complete — add immediately
          const userMessage: LiveMessage = {
            id: messageId,
            role: 'user',
            content: typeof messageData.content === 'string' && messageData.content
              ? [{ type: 'text' as const, text: messageData.content }]
              : Array.isArray(messageData.content)
                ? messageData.content as ContentPart[]
                : [],
            timestamp: Date.now(),
            isComplete: true,
          };
          setMessages((prev) => [...prev, userMessage]);
        } else if (role === 'assistant') {
          // Assistant message — start accumulating
          currentMessageIdRef.current = messageId;
          textRef.current = '';
          thinkingRef.current = '';
          currentMessageRef.current = createEmptyMessage('assistant');
          currentMessageRef.current.id = messageId;
        }
        break;
      }

      case 'message_update': {
        const assistantEvent = eventData.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (!assistantEvent) break;

        if (assistantEvent.type === 'text_delta') {
          textRef.current += (assistantEvent.delta || '');
        } else if (assistantEvent.type === 'thinking_delta') {
          thinkingRef.current += (assistantEvent.delta || '');
        }

        // Update current message ref content (NO state update)
        if (currentMessageRef.current) {
          currentMessageRef.current.content = buildContentParts(
            textRef.current,
            thinkingRef.current,
          );
        }

        // Request throttled UI update for streaming display
        requestStreamingUpdate();
        break;
      }

      case 'message_end':
        commitStreamingMessage();
        break;

      // ---- Tool execution ----
      case 'tool_execution_start': {
        const { toolCallId, toolName, args } = eventData as unknown as {
          toolCallId: string;
          toolName: string;
          args: unknown;
        };
        const toolId = toolCallId || `tool_${Date.now()}`;

        toolCallsRef.current.set(toolId, {
          id: toolId,
          name: toolName,
          args,
          status: 'pending',
        });

        const toolMessage: LiveMessage = {
          id: toolId,
          role: 'tool',
          content: [],
          toolCall: {
            id: toolId,
            name: toolName,
            args,
          },
          timestamp: Date.now(),
          isComplete: false,
        };

        setMessages((prev) => [...prev, toolMessage]);
        break;
      }

      case 'tool_execution_update': {
        const { toolCallId, partialResult } = eventData as unknown as {
          toolCallId: string;
          partialResult?: { content: Array<{ type: string; text?: string }> };
        };
        const content = partialResult?.content?.[0]?.text || '';

        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id === toolCallId) {
              return {
                ...msg,
                content: content ? [{ type: 'text' as const, text: content }] : msg.content,
                toolResult: { output: content, isError: false },
              };
            }
            return msg;
          })
        );
        break;
      }

      case 'tool_execution_end': {
        const { toolCallId, result, isError } = eventData as unknown as {
          toolCallId: string;
          result?: { content: Array<{ type: string; text?: string }> };
          isError: boolean;
        };
        const content = result?.content?.[0]?.text || '';

        const toolCall = toolCallsRef.current.get(toolCallId);
        if (toolCall) {
          toolCall.result = content;
          toolCall.status = isError ? 'error' : 'success';
        }

        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id === toolCallId) {
              return {
                ...msg,
                content: content ? [{ type: 'text' as const, text: content }] : msg.content,
                toolResult: { output: content, isError },
                isComplete: true,
              };
            }
            return msg;
          })
        );
        break;
      }

      // ---- History replay ----
      case 'history_start':
        setMessages([]);
        setIsReplaying(true);
        break;

      case 'history_end':
        setIsReplaying(false);
        break;
    }
  }, [sessionId, commitStreamingMessage, requestStreamingUpdate]);

  // ========================================
  // SUBSCRIBE TO GLOBAL WEBSOCKET
  // ========================================

  useLayoutEffect(() => {
    if (!sessionId || !autoConnect) {
      // No session: ensure cleaned up
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      // Clear messages when no session
      setMessages([]);
      setStatus('idle');
      return;
    }

    // Increment identity to invalidate any stale callbacks
    const identity = ++identityRef.current;

    // Sync active session ref with the new sessionId
    activeSessionIdRef.current = sessionId;

    // Clear state for the new session UNLESS session_switched already loaded messages
    // (session_switched fires synchronously before React re-render, so activeSessionIdRef
    // already points to the new session and messages may already be loaded)
    // We only clear if the activeSessionIdRef was changed by this effect, not by session_switched
    // Check: if messages exist and were loaded for this sessionId, don't clear
    // Simple approach: always clear refs (streaming state), but DON'T clear messages here
    // — session_switched or history_start handlers manage message clearing
    textRef.current = '';
    thinkingRef.current = '';
    toolCallsRef.current.clear();
    currentMessageRef.current = null;
    currentMessageIdRef.current = '';
    setStatus('idle');

    log('Subscribing to global WebSocket, identity=', identity);

    // Get the global WebSocket instance
    const ws = getWebSocketInstance();

    if (ws) {
      // Subscribe to messages with identity guard
      const unsubscribe = ws.addMessageListener((message) => {
        processMessage(message, identity);
      });
      unsubscribeRef.current = unsubscribe;
    } else {
      // No WebSocket yet — retry after a short delay
      // (The WebSocket singleton is created by useWebSocket on mount)
      log('No WebSocket instance yet, will retry subscription');
      const timer = setTimeout(() => {
        if (identityRef.current !== identity) return;
        const retryWs = getWebSocketInstance();
        if (retryWs) {
          const unsubscribe = retryWs.addMessageListener((message) => {
            processMessage(message, identity);
          });
          unsubscribeRef.current = unsubscribe;
          log('WebSocket subscription established (retry)');
        } else {
          log('Still no WebSocket instance after retry');
        }
      }, 100);
      // Clean up retry timer on teardown
      return () => clearTimeout(timer);
    }

    // ATOMIC TEARDOWN - runs before paint, prevents stale callbacks
    return () => {
      log('Cleanup: invalidating all callbacks');

      // Invalidate identity FIRST
      identityRef.current++;

      // Unsubscribe from WebSocket
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      // Clear streaming update timer
      if (streamingUpdateTimerRef.current) {
        clearTimeout(streamingUpdateTimerRef.current);
        streamingUpdateTimerRef.current = 0;
      }

      // Clear streaming refs (but NOT messages — session_switched may have loaded them)
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current.clear();
      currentMessageRef.current = null;
      currentMessageIdRef.current = '';

      // Don't clear messages here! session_switched handler manages message loading.
      // Clearing here would wipe messages loaded synchronously by session_switched
      // before this cleanup runs.
      setStatus('idle');
      setIsReplaying(false);
    };
  }, [sessionId]); // ONLY sessionId — handlers use refs

  // ========================================
  // ACTIONS
  // ========================================

  /**
   * Send a prompt to the agent via the global WebSocket
   */
  const sendPrompt = useCallback(
    async (content: string, images?: unknown[]): Promise<void> => {
      const ws = getWebSocketInstance();
      if (!ws) {
        log('Cannot send prompt, no WebSocket instance');
        return;
      }

      setStatus('busy');

      const sent = ws.send({
        type: 'prompt',
        sessionId,
        message: content,
        images,
      });

      if (!sent) {
        log('Failed to send prompt, WebSocket not connected');
        setStatus('error');
      }
    },
    [sessionId, log]
  );

  /**
   * Cancel the current turn via the global WebSocket
   */
  const cancelCurrentTurn = useCallback(() => {
    const ws = getWebSocketInstance();
    if (!ws) {
      log('Cannot cancel, no WebSocket instance');
      return;
    }

    ws.send({ type: 'abort' });
    setStatus('idle');
  }, [log]);

  /**
   * Clear all messages
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
    textRef.current = '';
    thinkingRef.current = '';
    toolCallsRef.current.clear();
    currentMessageRef.current = null;
    currentMessageIdRef.current = '';
  }, []);

  // ========================================
  // COMPUTED STREAMING STATE
  // ========================================

  // Get current streaming content from refs
  const streamingContent: ContentPart[] =
    status === 'streaming' && currentMessageRef.current
      ? currentMessageRef.current.content
      : [];

  // Get active tool calls
  const activeToolCalls: ToolCallState[] = Array.from(
    toolCallsRef.current.values()
  ).filter((tc) => tc.status === 'pending');

  // ========================================
  // RETURN
  // ========================================

  return {
    messages,
    status,
    contextPercent,
    currentStep,
    isReplaying,
    streamingContent,
    activeToolCalls,
    sendPrompt,
    cancelCurrentTurn,
    clearMessages,
  };
}

export default useSessionStream;

/**
 * useSessionStream Hook - Ref-Based Streaming for Mobile Performance
 *
 * This hook implements a ref-based streaming pattern that minimizes re-renders
 * during content accumulation. All streaming content is accumulated in refs
 * and only committed to state when turns complete.
 *
 * Key Features:
 * - Ref-based accumulation (no re-renders during streaming)
 * - Identity guards prevent stale callbacks after session switches
 * - Atomic teardown with useLayoutEffect (runs before paint)
 * - History replay handling for session switching
 * - Single dependency effect (only sessionId)
 *
 * CRITICAL: This is the MOST CRITICAL module for mobile performance.
 */

import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { JSONRPCClient } from '../lib/jsonrpc-client.js';
import type {
  ContentPartEvent,
  ToolCallEvent,
  ToolResultEvent,
  Attachment,
  StatusEvent,
  SubagentToolSummary,
} from '@pi-web-ui/shared';

// Use Vite proxy in development, or direct URL in production
const WS_URL = import.meta.env.VITE_WS_URL || '/ws';

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
    summary?: SubagentToolSummary;
  };
  timestamp: number;
  isComplete: boolean;
  error?: {
    message: string;
    provider?: string;
    model?: string;
  };
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
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Base reconnection delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the WebSocket base URL
 */
function getWebSocketBase(): string {
  // In browser, construct WebSocket URL from current location
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${WS_URL}`;
}

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
  toolCalls: Map<string, ToolCallState>
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
    maxReconnectAttempts = 5,
    reconnectDelay = 1000,
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

  // WebSocket identity for guard checks
  const wsIdentityRef = useRef<string>('');

  // JSON-RPC client
  const clientRef = useRef<JSONRPCClient | null>(null);

  // Connection state refs (not state - we use connectionState from client)
  const isConnectingRef = useRef<boolean>(false);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const streamingUpdateRef = useRef<number>(0);
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
  // IDENTITY GUARD HELPER
  // ========================================

  /**
   * Wrap a callback with an identity guard
   * Returns a wrapped function that checks identity before executing
   */
  const withIdentityGuard = useCallback(
    <T extends (...args: any[]) => any>(callback: T): T => {
      // This handler belongs to the session that was active when it was created
      // (the `sessionId` closed over here). Block it whenever the live connection
      // is bound to a different (or no) session — i.e. after a session switch or
      // teardown. wsIdentityRef is set to the connected sessionId by connect()
      // and cleared on disconnect. Comparing against the closed-over sessionId
      // (rather than a value captured at wrap time) is what makes the guard let
      // the active session's events through while still blocking stale ones.
      return ((...args: Parameters<T>) => {
        if (wsIdentityRef.current !== sessionId) {
          log('Stale callback blocked');
          return;
        }
        return callback(...args) as ReturnType<T>;
      }) as T;
    },
    [log, sessionId]
  );

  /**
   * Check if identity is valid for async operations
   */
  const checkIdentity = useCallback((expectedIdentity: string): boolean => {
    return wsIdentityRef.current === expectedIdentity && wsIdentityRef.current !== '';
  }, []);

  // ========================================
  // STREAMING UPDATE OPTIMIZATION
  // ========================================

  /**
   * Request a streaming content update
   * Throttled to max 60fps (16ms intervals)
   */
  const requestStreamingUpdate = useCallback(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastStreamingUpdateRef.current;

    // Throttle to ~60fps
    if (timeSinceLastUpdate < 16) {
      // Schedule update for later
      if (streamingUpdateRef.current === 0) {
        streamingUpdateRef.current = window.setTimeout(() => {
          streamingUpdateRef.current = 0;
          lastStreamingUpdateRef.current = Date.now();
          forceUpdate((n) => n + 1);
        }, 16 - timeSinceLastUpdate);
      }
    } else {
      // Update immediately
      lastStreamingUpdateRef.current = now;
      forceUpdate((n) => n + 1);
    }
  }, []);

  // ========================================
  // EVENT HANDLERS WITH IDENTITY GUARDS
  // ========================================

  /**
   * Handle content part streaming events
   */
  const handleContentPart = useCallback(
    withIdentityGuard((params: unknown) => {
      const event = params as ContentPartEvent;
      if (event.type === 'text') {
        if (event.isDelta) {
          textRef.current += event.content;
        } else {
          textRef.current = event.content;
        }
      } else if (event.type === 'thinking') {
        if (event.isDelta) {
          thinkingRef.current += event.content;
        } else {
          thinkingRef.current = event.content;
        }
      }

      // Update current message ref
      if (currentMessageRef.current) {
        currentMessageRef.current.content = buildContentParts(
          textRef.current,
          thinkingRef.current,
          toolCallsRef.current
        );
      }

      // Request UI update (throttled)
      requestStreamingUpdate();
    }),
    [withIdentityGuard, requestStreamingUpdate]
  );

  /**
   * Handle tool call start events
   */
  const handleToolCall = useCallback(
    withIdentityGuard((params: unknown) => {
      const event = params as ToolCallEvent;
      toolCallsRef.current.set(event.id, {
        id: event.id,
        name: event.name,
        args: event.args,
        status: 'pending',
      });

      // Create a tool message
      const toolMessage: LiveMessage = {
        id: event.id,
        role: 'tool',
        content: [],
        toolCall: {
          id: event.id,
          name: event.name,
          args: event.args,
        },
        timestamp: Date.now(),
        isComplete: false,
      };

      setMessages((prev) => [...prev, toolMessage]);
    }),
    [withIdentityGuard]
  );

  /**
   * Handle tool result events
   */
  const handleToolResult = useCallback(
    withIdentityGuard((params: unknown) => {
      const event = params as ToolResultEvent;
      const toolCall = toolCallsRef.current.get(event.id);
      if (toolCall) {
        toolCall.result = event.result;
        toolCall.status = event.isError ? 'error' : 'success';
      }

      // Update the tool message
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id === event.id) {
            const resultText =
              typeof event.result === 'string'
                ? event.result
                : JSON.stringify(event.result);
            return {
              ...msg,
              content: [{ type: 'text' as const, text: resultText }],
              toolResult: {
                output: resultText,
                isError: event.isError,
              },
              isComplete: true,
            };
          }
          return msg;
        })
      );
    }),
    [withIdentityGuard]
  );

  /**
   * Handle turn begin events
   */
  const handleTurnBegin = useCallback(
    withIdentityGuard((params: unknown) => {
      // Reset refs for new turn
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current.clear();

      // Create new message for this turn
      currentMessageRef.current = createEmptyMessage('assistant');

      setStatus('streaming');
    }),
    [withIdentityGuard]
  );

  /**
   * Handle turn end events
   */
  const handleTurnEnd = useCallback(
    withIdentityGuard(() => {
      // Commit accumulated content to state
      if (currentMessageRef.current) {
        const finalContent = buildContentParts(
          textRef.current,
          thinkingRef.current,
          toolCallsRef.current
        );

        // Capture the completed message in a local: the setMessages updater runs
        // asynchronously, after currentMessageRef.current is reset to null below,
        // so reading the ref inside the updater would push a null message.
        const completedMessage = currentMessageRef.current;
        completedMessage.content = finalContent;
        completedMessage.isComplete = true;

        setMessages((prev) => [...prev, completedMessage]);
      }

      // Reset refs for next turn
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current.clear();
      currentMessageRef.current = null;

      setStatus('idle');
    }),
    [withIdentityGuard]
  );

  /**
   * Handle status change events
   */
  const handleStatus = useCallback(
    withIdentityGuard((params: unknown) => {
      const event = params as StatusEvent;
      setStatus(event.status);

      if (event.status === 'error' && event.message) {
        log('Agent error:', event.message);
      }
    }),
    [withIdentityGuard, log]
  );

  /**
   * Handle replay start
   */
  const handleReplayStart = useCallback(
    withIdentityGuard(() => {
      setIsReplaying(true);
      log('Replay started');
    }),
    [withIdentityGuard, log]
  );

  /**
   * Handle replay complete
   */
  const handleReplayComplete = useCallback(
    withIdentityGuard(() => {
      setIsReplaying(false);
      log('Replay complete');
    }),
    [withIdentityGuard, log]
  );

  /**
   * Handle context update
   */
  const handleContextUpdate = useCallback(
    withIdentityGuard((params: unknown) => {
      const contextParams = params as { percent?: number; step?: number };
      if (contextParams.percent !== undefined) {
        setContextPercent(contextParams.percent);
      }
      if (contextParams.step !== undefined) {
        setCurrentStep(contextParams.step);
      }
    }),
    [withIdentityGuard]
  );

  /**
   * Handle user message (for display)
   */
  const handleUserMessage = useCallback(
    withIdentityGuard((params: unknown) => {
      const msgParams = params as { content: string; attachments?: Attachment[] };
      const userMessage: LiveMessage = {
        id: `user_${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: msgParams.content }],
        timestamp: Date.now(),
        isComplete: true,
      };

      setMessages((prev) => [...prev, userMessage]);
    }),
    [withIdentityGuard]
  );

  // ========================================
  // CONNECTION MANAGEMENT
  // ========================================

  /**
   * Clear reconnect timer
   */
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Calculate reconnection delay with exponential backoff
   */
  const getReconnectDelay = useCallback((): number => {
    const attempts = reconnectAttemptsRef.current;
    const baseDelay = reconnectDelay * Math.pow(2, attempts);
    const jitter = Math.random() * 0.1 * baseDelay;
    return Math.min(baseDelay + jitter, 30000);
  }, [reconnectDelay]);

  /**
   * Connect to the WebSocket
   */
  const connect = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      log('No session ID, skipping connect');
      return;
    }

    if (isConnectingRef.current) {
      log('Already connecting, skipping');
      return;
    }

    // Bind this connection to the active session id. The identity guard blocks
    // any handler whose session no longer matches wsIdentityRef.current, so a
    // session switch (which changes sessionId) invalidates the previous
    // connection's callbacks.
    const identity = sessionId;
    wsIdentityRef.current = identity;

    isConnectingRef.current = true;
    setStatus('idle');

    try {
      const wsUrl = `${getWebSocketBase()}/sessions/${sessionId}`;
      log('Connecting to', wsUrl);

      const client = new JSONRPCClient({
        debug,
        maxReconnectAttempts: 0, // We handle reconnection ourselves
        requestTimeout: 120000, // 2 minutes for long operations
      });

      // Connect to WebSocket
      await client.connect(wsUrl);

      // Guard: Check identity after async operation
      if (!checkIdentity(identity)) {
        log('Connected but identity changed, disconnecting');
        client.disconnect();
        return;
      }

      // Register event handlers
      const unsubscribers: (() => void)[] = [];

      unsubscribers.push(client.on('contentPart', handleContentPart));
      unsubscribers.push(client.on('toolCall', handleToolCall));
      unsubscribers.push(client.on('toolResult', handleToolResult));
      unsubscribers.push(client.on('turnBegin', handleTurnBegin));
      unsubscribers.push(client.on('turnEnd', handleTurnEnd));
      unsubscribers.push(client.on('status', handleStatus));
      unsubscribers.push(client.on('replay_start', handleReplayStart));
      unsubscribers.push(client.on('replay_complete', handleReplayComplete));
      unsubscribers.push(client.on('context', handleContextUpdate));
      unsubscribers.push(client.on('user_message', handleUserMessage));

      // Handle connection events
      unsubscribers.push(
        client.on('disconnected', () => {
          if (!checkIdentity(identity)) {
            log('Disconnected for stale identity, ignoring');
            return;
          }

          log('Disconnected');
          setStatus('idle');

          // Attempt reconnection
          if (reconnectAttemptsRef.current < maxReconnectAttempts) {
            reconnectAttemptsRef.current++;
            const delay = getReconnectDelay();
            log(`Reconnecting in ${delay}ms`);

            reconnectTimerRef.current = setTimeout(() => {
              if (checkIdentity(identity)) {
                connect();
              }
            }, delay);
          }
        })
      );

      unsubscribers.push(
        client.on('error', (params) => {
          if (!checkIdentity(identity)) return;
          log('Connection error:', params);
          setStatus('error');
        })
      );

      // Initialize connection
      await client.request('initialize', {
        capabilities: {
          streaming: true,
          attachments: true,
        },
      });

      // Guard: Check identity after async operation
      if (!checkIdentity(identity)) {
        log('Initialized but identity changed, disconnecting');
        client.disconnect();
        unsubscribers.forEach((unsub) => unsub());
        return;
      }

      // Store client
      clientRef.current = client;
      reconnectAttemptsRef.current = 0;

      log('Connected successfully');
    } catch (error) {
      log('Connection failed:', error);

      if (!checkIdentity(identity)) {
        log('Connection failed but identity changed, ignoring');
        return;
      }

      setStatus('error');

      // Attempt reconnection
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current++;
        const delay = getReconnectDelay();
        log(`Retrying connection in ${delay}ms`);

        reconnectTimerRef.current = setTimeout(() => {
          if (checkIdentity(identity)) {
            connect();
          }
        }, delay);
      }
    } finally {
      isConnectingRef.current = false;
    }
  }, [
    sessionId,
    debug,
    maxReconnectAttempts,
    checkIdentity,
    getReconnectDelay,
    log,
    handleContentPart,
    handleToolCall,
    handleToolResult,
    handleTurnBegin,
    handleTurnEnd,
    handleStatus,
    handleReplayStart,
    handleReplayComplete,
    handleContextUpdate,
    handleUserMessage,
  ]);

  /**
   * Disconnect from the WebSocket
   */
  const disconnect = useCallback(() => {
    log('Disconnecting');

    // Invalidate identity FIRST to prevent stale callbacks
    wsIdentityRef.current = '';

    // Clear timers
    clearReconnectTimer();
    if (streamingUpdateRef.current) {
      clearTimeout(streamingUpdateRef.current);
      streamingUpdateRef.current = 0;
    }

    // Disconnect client
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }

    // Reset state
    setStatus('idle');
    setIsReplaying(false);
    reconnectAttemptsRef.current = 0;
  }, [clearReconnectTimer, log]);

  // ========================================
  // ATOMIC TEARDOWN (useLayoutEffect)
  // ========================================

  useLayoutEffect(() => {
    if (!sessionId) {
      // No session, ensure disconnected
      disconnect();
      return;
    }

    // Auto-connect if enabled
    if (autoConnect) {
      connect();
    }

    // ATOMIC TEARDOWN - runs before paint, prevents stale callbacks
    return () => {
      log('Cleanup: invalidating all callbacks');

      // Invalidate identity FIRST
      wsIdentityRef.current = '';

      // Clear all timers
      clearReconnectTimer();
      if (streamingUpdateRef.current) {
        clearTimeout(streamingUpdateRef.current);
        streamingUpdateRef.current = 0;
      }

      // Disconnect client
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }

      // Clear all refs
      textRef.current = '';
      thinkingRef.current = '';
      toolCallsRef.current.clear();
      currentMessageRef.current = null;

      // Reset state
      setMessages([]);
      setStatus('idle');
      setContextPercent(0);
      setCurrentStep(0);
      setIsReplaying(false);
    };
  }, [sessionId]); // ONLY sessionId - handlers use refs

  // ========================================
  // ACTIONS
  // ========================================

  /**
   * Send a prompt to the agent
   */
  const sendPrompt = useCallback(
    async (content: string, attachments?: Attachment[]): Promise<void> => {
      if (!clientRef.current) {
        log('Cannot send prompt, not connected');
        return;
      }

      setStatus('busy');

      try {
        await clientRef.current.request('prompt', { content, attachments });
      } catch (error) {
        log('Failed to send prompt:', error);
        setStatus('error');
        throw error;
      }
    },
    [log]
  );

  /**
   * Cancel the current turn
   */
  const cancelCurrentTurn = useCallback(() => {
    if (!clientRef.current) {
      log('Cannot cancel, not connected');
      return;
    }

    clientRef.current.notify('cancel', {});
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

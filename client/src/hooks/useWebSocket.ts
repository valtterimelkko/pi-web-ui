/**
 * @deprecated Use useSessionStream instead.
 * This hook will be removed in a future version.
 *
 * Migration guide:
 * - Replace `useWebSocket()` with `useSessionStream(sessionId)`
 * - The new hook provides: messages, status, sendPrompt, cancelCurrentTurn
 * - Session management is handled automatically by the hook
 *
 * For components that only need to send specific messages (like extension responses),
 * consider using the WebSocket client directly or refactoring to use the new protocol.
 */
import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore, useUIStore } from '../store';
import { WebSocketClient, createWebSocketClient, type WebSocketSendResult, type WebSocketStatus } from '../lib/websocket';
import { emitTalkerTurnResult } from '../lib/talkerBus';
import { emitTurnDigestResult } from '../lib/turnDigest';

export function useWebSocket() {
  const clientRef = useRef<WebSocketClient | null>(null);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  // Track the current session path for reconnection resubscription
  const currentSessionPathRef = useRef<string | null>(null);

  // Subscribe to session store changes to keep sessionPathRef in sync
  const sessions = useSessionStore((state) => state.sessions);
  useEffect(() => {
    if (currentSessionId) {
      const session = sessions.find(s => s.id === currentSessionId);
      if (session?.path) {
        currentSessionPathRef.current = session.path;
      }
    }
  }, [currentSessionId, sessions]);

  useEffect(() => {
    // Get the handler from the store directly to avoid re-subscription
    const handleServerMessage = useSessionStore.getState().handleServerMessage;

    const client = createWebSocketClient({
      onMessage: (message: unknown) => {
        // H7 voice-talker tap: consume `talker_turn_result` here, BEFORE the
        // session store — the store does not know this message type and would
        // record it as protocol drift. See lib/talkerBus.ts.
        if (emitTalkerTurnResult(message)) return;
        // P17 digest tap: the reading levels' digest answer is consumed the
        // same way, and for the same reason (see lib/turnDigest.ts).
        if (emitTurnDigestResult(message)) return;
        handleServerMessage(message);
      },
      onStatusChange: (status: WebSocketStatus) => {
        console.log('WebSocket status:', status);
        // A dropped connection can never deliver the session_switched the
        // sidebar spinner is waiting for; clear it so the row stays usable.
        if (status === 'disconnected') {
          useSessionStore.getState().setSwitchingSession(false);
        }
        // Fetch sessions when connected
        if (status === 'connected') {
          console.log('Fetching sessions...');
          // Set loading state to prevent duplicate adds from session_update events
          useSessionStore.getState().isLoadingSessions = true;
          client.send({ type: 'get_sessions' });

          // Re-subscribe to the current session after reconnection
          // This fixes the bug where prompts silently fail after WS reconnect
          const sessionPath = currentSessionPathRef.current;
          if (sessionPath) {
            console.log('[WebSocket] Re-subscribing to session after reconnection:', sessionPath);
            client.send({ type: 'switch_session', sessionPath });
          }
        }
      },
      onError: (error) => {
        console.error('WebSocket error:', error);
      },
      // A send made while the socket was down is held and flushed after
      // reconnect. Tell the operator once per outage so a dictated prompt on a
      // phone does not look like it vanished into thin air.
      onMessageQueued: (queueDepth) => {
        if (queueDepth !== 1) return; // one notice per outage, not per message
        useUIStore.getState().addToast({
          type: 'info',
          message: 'Message queued — it will be sent once the connection is restored.',
        });
      },
      // A send that could not even be queued is genuinely lost — this must be
      // visible, not a silent console.error.
      onSendFailed: (reason) => {
        console.error('[WebSocket] Send failed:', reason);
        useUIStore.getState().addToast({ type: 'error', message: reason });
        useUIStore.getState().logNotification({ type: 'error', message: reason, sessionId: null });
      },
    });

    clientRef.current = client;

    // Only connect if not already connected/connecting
    const status = client.getStatus();
    if (status !== 'connected' && status !== 'connecting') {
      client.connect();
    }

    return () => {
      // Don't disconnect on unmount to keep connection alive across component re-renders
      // The WebSocket singleton will manage its own lifecycle
    };
  }, []); // Empty dependency array - only run once on mount

  const sendMessage = useCallback((message: unknown): WebSocketSendResult => {
    return clientRef.current?.send(message) ?? 'failed';
  }, []);

  const sendPrompt = useCallback((message: string, images?: unknown[], agent?: string): WebSocketSendResult => {
    if (!currentSessionId) {
      console.error('No active session');
      return 'failed';
    }
    const sent = sendMessage({
      type: 'prompt',
      sessionId: currentSessionId,
      message,
      images,
      agent,
    });
    // A queued prompt will still reach the agent after reconnect, so the
    // transfer-ready state may be cleared either way; only a real failure is
    // reported to the caller as 'failed'.
    if (sent !== 'failed') useSessionStore.getState().clearTransferReady(currentSessionId);
    return sent;
  }, [sendMessage, currentSessionId]);

  const sendSteer = useCallback((message: string): WebSocketSendResult => {
    const sent = sendMessage({ type: 'steer', message });
    if (sent !== 'failed' && currentSessionId) useSessionStore.getState().clearTransferReady(currentSessionId);
    return sent;
  }, [sendMessage, currentSessionId]);

  const sendFollowUp = useCallback((message: string): WebSocketSendResult => {
    const sent = sendMessage({ type: 'follow_up', message });
    if (sent !== 'failed' && currentSessionId) useSessionStore.getState().clearTransferReady(currentSessionId);
    return sent;
  }, [sendMessage, currentSessionId]);

  const abortGeneration = useCallback(() => {
    return sendMessage({ type: 'abort' });
  }, [sendMessage]);

  const goalControl = useCallback((sessionId: string, action: 'pause' | 'resume' | 'clear') => {
    return sendMessage({ type: 'goal_control', sessionId, action });
  }, [sendMessage]);

  const createNewSession = useCallback((cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity' | 'commandcode', model?: string, thinkingLevel?: string, effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max', requestId?: string) => {
    return sendMessage({ type: 'new_session', cwd, sdkType: sdkType || 'pi', model, thinkingLevel, effort, ...(requestId ? { requestId } : {}) });
  }, [sendMessage]);

  const switchSession = useCallback((sessionPath: string) => {
    return sendMessage({ type: 'switch_session', sessionPath });
  }, [sendMessage]);

  const subscribeToSession = useCallback((sessionPath: string) => {
    return sendMessage({ type: 'subscribe_session', sessionPath });
  }, [sendMessage]);

  const unsubscribeFromSession = useCallback((sessionPath: string) => {
    return sendMessage({ type: 'unsubscribe_session', sessionPath });
  }, [sendMessage]);

  const getSessions = useCallback(() => {
    // Set loading state to prevent duplicate adds from session_update events
    useSessionStore.getState().isLoadingSessions = true;
    return sendMessage({ type: 'get_sessions' });
  }, [sendMessage]);

  const setModel = useCallback((modelId: string) => {
    return sendMessage({ type: 'set_model', modelId });
  }, [sendMessage]);

  const setThinkingLevel = useCallback((level: string) => {
    return sendMessage({ type: 'set_thinking_level', level });
  }, [sendMessage]);

  const setEffort = useCallback((effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => {
    return sendMessage({ type: 'set_effort', effort });
  }, [sendMessage]);

  const sendCompact = useCallback((customInstructions?: string) => {
    return sendMessage({ type: 'compact', customInstructions });
  }, [sendMessage]);

  const getSessionInfo = useCallback(() => {
    return sendMessage({ type: 'get_session_info' });
  }, [sendMessage]);

  const setSessionName = useCallback((sessionId: string, name: string) => {
    return sendMessage({ type: 'set_session_name', sessionId, name });
  }, [sendMessage]);

  const pinSession = useCallback((sessionPath: string) => {
    return sendMessage({ type: 'pin_session', sessionPath });
  }, [sendMessage]);

  const unpinSession = useCallback((sessionPath: string) => {
    return sendMessage({ type: 'unpin_session', sessionPath });
  }, [sendMessage]);

  return {
    sendMessage,
    sendPrompt,
    sendSteer,
    sendFollowUp,
    abortGeneration,
    goalControl,
    createNewSession,
    switchSession,
    subscribeToSession,
    unsubscribeFromSession,
    getSessions,
    setModel,
    setThinkingLevel,
    setEffort,
    sendCompact,
    getSessionInfo,
    setSessionName,
    pinSession,
    unpinSession,
  };
}

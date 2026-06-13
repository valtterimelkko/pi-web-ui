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
import { useSessionStore } from '../store';
import { WebSocketClient, createWebSocketClient, type WebSocketStatus } from '../lib/websocket';

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
      onMessage: handleServerMessage,
      onStatusChange: (status: WebSocketStatus) => {
        console.log('WebSocket status:', status);
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

  const sendMessage = useCallback((message: unknown) => {
    return clientRef.current?.send(message) ?? false;
  }, []);

  const sendPrompt = useCallback((message: string, images?: unknown[], agent?: string) => {
    if (!currentSessionId) {
      console.error('No active session');
      return false;
    }
    return sendMessage({
      type: 'prompt',
      sessionId: currentSessionId,
      message,
      images,
      agent,
    });
  }, [sendMessage, currentSessionId]);

  const sendSteer = useCallback((message: string) => {
    return sendMessage({ type: 'steer', message });
  }, [sendMessage]);

  const sendFollowUp = useCallback((message: string) => {
    return sendMessage({ type: 'follow_up', message });
  }, [sendMessage]);

  const abortGeneration = useCallback(() => {
    return sendMessage({ type: 'abort' });
  }, [sendMessage]);

  const createNewSession = useCallback((cwd?: string, sdkType?: 'pi' | 'claude' | 'opencode' | 'antigravity', model?: string, thinkingLevel?: string) => {
    return sendMessage({ type: 'new_session', cwd, sdkType: sdkType || 'pi', model, thinkingLevel });
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
    createNewSession,
    switchSession,
    subscribeToSession,
    unsubscribeFromSession,
    getSessions,
    setModel,
    setThinkingLevel,
    sendCompact,
    getSessionInfo,
    setSessionName,
    pinSession,
    unpinSession,
  };
}

import { useEffect, useRef, useCallback } from 'react';
import { useSessionStore } from '../store';
import { WebSocketClient, createWebSocketClient, type WebSocketStatus } from '../lib/websocket';

export function useWebSocket() {
  const clientRef = useRef<WebSocketClient | null>(null);
  const handleServerMessage = useSessionStore((state) => state.handleServerMessage);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);

  useEffect(() => {
    const client = createWebSocketClient({
      onMessage: handleServerMessage,
      onStatusChange: (status: WebSocketStatus) => {
        console.log('WebSocket status:', status);
        // Fetch sessions when connected
        if (status === 'connected') {
          console.log('Fetching sessions...');
          client.send({ type: 'get_sessions' });
        }
      },
      onError: (error) => {
        console.error('WebSocket error:', error);
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
    };
  }, [handleServerMessage]);

  const sendMessage = useCallback((message: unknown) => {
    return clientRef.current?.send(message) ?? false;
  }, []);

  const sendPrompt = useCallback((message: string, images?: unknown[]) => {
    if (!currentSessionId) {
      console.error('No active session');
      return false;
    }
    return sendMessage({
      type: 'prompt',
      sessionId: currentSessionId,
      message,
      images,
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

  const createNewSession = useCallback((cwd?: string) => {
    return sendMessage({ type: 'new_session', cwd });
  }, [sendMessage]);

  const switchSession = useCallback((sessionPath: string) => {
    return sendMessage({ type: 'switch_session', sessionPath });
  }, [sendMessage]);

  const getSessions = useCallback(() => {
    return sendMessage({ type: 'get_sessions' });
  }, [sendMessage]);

  return {
    sendMessage,
    sendPrompt,
    sendSteer,
    sendFollowUp,
    abortGeneration,
    createNewSession,
    switchSession,
    getSessions,
  };
}

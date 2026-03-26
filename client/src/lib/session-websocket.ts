/**
 * Per-Session WebSocket Client with Identity Guards
 *
 * This module provides a React hook for managing WebSocket connections
 * scoped to individual sessions. The key feature is the identity guard
 * pattern that prevents stale callbacks from executing after session switches.
 *
 * CRITICAL: All async callbacks MUST check identity before proceeding:
 * ```typescript
 * const currentIdentity = identityRef.current
 * someAsyncOp().then(() => {
 *   if (identityRef.current !== currentIdentity) return // STALE
 *   // proceed...
 * })
 * ```
 */

import { useRef, useCallback, useLayoutEffect, useState } from 'react';
import { JSONRPCClient, type JSONRPCClientOptions } from './jsonrpc-client';

// Use Vite proxy in development, or direct URL in production
const WS_URL = import.meta.env.VITE_WS_URL || '/ws';

/**
 * Connection states for the session WebSocket
 */
export type SessionConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'reconnecting';

/**
 * Options for the session WebSocket hook
 */
export interface UseSessionWebSocketOptions {
  /** WebSocket URL (defaults to WS_URL env var or '/ws') */
  url?: string;
  /** Called when connection state changes */
  onConnectionStateChange?: (state: SessionConnectionState) => void;
  /** Called when a notification/event is received */
  onNotification?: (method: string, params: unknown) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** JSON-RPC client options (timeout, reconnect, etc.) */
  clientOptions?: Omit<JSONRPCClientOptions, 'debug'>;
  /** Enable debug logging */
  debug?: boolean;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Base reconnection delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Maximum reconnection delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Heartbeat timeout in ms (default: 60000) */
  heartbeatTimeout?: number;
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean;
}

/**
 * Return type for the session WebSocket hook
 */
export interface SessionWebSocketResult {
  /** The JSON-RPC client instance (null when disconnected) */
  client: JSONRPCClient | null;
  /** Whether the WebSocket is currently connected */
  isConnected: boolean;
  /** Current connection state */
  connectionState: SessionConnectionState;
  /** Current session identity (changes on each session switch) */
  identity: string;
  /** Manually connect to the WebSocket */
  connect: () => Promise<void>;
  /** Manually disconnect from the WebSocket */
  disconnect: () => void;
  /** Force reconnection (disconnect then connect) */
  reconnect: () => Promise<void>;
}

/**
 * Internal state for heartbeat/watchdog
 */
interface HeartbeatState {
  lastPong: number;
  intervalId: ReturnType<typeof setInterval> | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-session WebSocket hook with identity guards.
 *
 * Features:
 * - Identity guard pattern prevents stale callbacks
 * - Atomic teardown on session switch (useLayoutEffect)
 * - Automatic reconnection with exponential backoff
 * - Heartbeat/watchdog for stale connection detection
 * - Browser tab visibility handling
 *
 * @param sessionId - The session ID to connect to (null to disconnect)
 * @param options - Configuration options
 * @returns SessionWebSocketResult with client and control methods
 *
 * @example
 * ```typescript
 * function MyComponent() {
 *   const { sessionId } = useSessionStore();
 *   const { client, isConnected, identity } = useSessionWebSocket(sessionId, {
 *     onNotification: (method, params) => {
 *       console.log(`Received ${method}:`, params);
 *     },
 *   });
 *
 *   const sendMessage = async () => {
 *     if (!client || !isConnected) return;
 *     const result = await client.request('prompt', { content: 'Hello!' });
 *   };
 *
 *   return <div>Connected: {isConnected ? 'Yes' : 'No'}</div>;
 * }
 * ```
 */
export function useSessionWebSocket(
  sessionId: string | null,
  options: UseSessionWebSocketOptions = {}
): SessionWebSocketResult {
  const {
    url = WS_URL,
    onConnectionStateChange,
    onNotification,
    onError,
    clientOptions = {},
    debug = false,
    maxReconnectAttempts = 5,
    reconnectDelay = 1000,
    maxReconnectDelay = 30000,
    heartbeatInterval = 30000,
    heartbeatTimeout = 60000,
    autoConnect = true,
  } = options;

  // Refs for identity guard pattern
  const wsRef = useRef<WebSocket | null>(null);
  const clientRef = useRef<JSONRPCClient | null>(null);
  const identityRef = useRef<string>('');
  const heartbeatRef = useRef<HeartbeatState>({
    lastPong: Date.now(),
    intervalId: null,
    timeoutId: null,
  });
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isConnectingRef = useRef<boolean>(false);

  // State
  const [connectionState, setConnectionState] = useState<SessionConnectionState>('disconnected');
  const [identity, setIdentity] = useState<string>('');

  // Stable callback refs
  const onConnectionStateChangeRef = useRef(onConnectionStateChange);
  const onNotificationRef = useRef(onNotification);
  const onErrorRef = useRef(onError);

  // Update refs when props change
  onConnectionStateChangeRef.current = onConnectionStateChange;
  onNotificationRef.current = onNotification;
  onErrorRef.current = onError;

  /**
   * Log debug messages
   */
  const log = useCallback(
    (...args: unknown[]) => {
      if (debug) {
        console.log('[SessionWebSocket]', `[session:${sessionId?.slice(0, 8)}]`, ...args);
      }
    },
    [debug, sessionId]
  );

  /**
   * Update connection state and notify callback
   */
  const updateConnectionState = useCallback(
    (state: SessionConnectionState) => {
      setConnectionState(state);
      onConnectionStateChangeRef.current?.(state);
    },
    []
  );

  /**
   * Stop heartbeat watchdog
   */
  const stopHeartbeat = useCallback(() => {
    const heartbeat = heartbeatRef.current;
    if (heartbeat.intervalId) {
      clearInterval(heartbeat.intervalId);
      heartbeat.intervalId = null;
    }
    if (heartbeat.timeoutId) {
      clearTimeout(heartbeat.timeoutId);
      heartbeat.timeoutId = null;
    }
  }, []);

  /**
   * Start heartbeat watchdog
   */
  const startHeartbeat = useCallback(() => {
    stopHeartbeat();

    const currentIdentity = identityRef.current;
    const heartbeat = heartbeatRef.current;
    heartbeat.lastPong = Date.now();

    // Send ping periodically
    heartbeat.intervalId = setInterval(() => {
      // IDENTITY GUARD: Don't send if identity changed
      if (identityRef.current !== currentIdentity) {
        stopHeartbeat();
        return;
      }

      if (clientRef.current?.isConnected) {
        clientRef.current.notify('ping');
        log('Sent ping');
      }

      // Check for stale connection (no pong received)
      const timeSinceLastPong = Date.now() - heartbeat.lastPong;
      if (timeSinceLastPong > heartbeatTimeout) {
        log('Connection stale, no pong received');
        // Trigger reconnection
        handleReconnect(currentIdentity);
      }
    }, heartbeatInterval);
  }, [stopHeartbeat, heartbeatInterval, heartbeatTimeout, log]);

  /**
   * Handle pong responses
   */
  const handlePong = useCallback(() => {
    heartbeatRef.current.lastPong = Date.now();
    log('Received pong');
  }, [log]);

  /**
   * Clear reconnection timer
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
    // Exponential backoff: base * 2^(attempts-1) with jitter
    const baseDelay = reconnectDelay * Math.pow(2, attempts);
    const jitter = Math.random() * 0.1 * baseDelay; // 10% jitter
    const delay = baseDelay + jitter;
    return Math.min(delay, maxReconnectDelay);
  }, [reconnectDelay, maxReconnectDelay]);

  /**
   * Handle reconnection with backoff
   */
  const handleReconnect = useCallback(
    (currentIdentity: string) => {
      // IDENTITY GUARD: Check if identity changed
      if (identityRef.current !== currentIdentity) {
        log('Skipping reconnect, identity changed');
        return;
      }

      if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
        log('Max reconnection attempts reached');
        updateConnectionState('disconnected');
        onErrorRef.current?.(new Error('Max reconnection attempts reached'));
        return;
      }

      reconnectAttemptsRef.current++;
      updateConnectionState('reconnecting');

      const delay = getReconnectDelay();
      log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`);

      reconnectTimerRef.current = setTimeout(() => {
        // IDENTITY GUARD: Check again after timeout
        if (identityRef.current !== currentIdentity) {
          log('Skipping reconnect after timeout, identity changed');
          return;
        }

        // Clean up old connection
        if (clientRef.current) {
          clientRef.current.disconnect();
          clientRef.current = null;
        }
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }

        // Reconnect
        connectInternal(currentIdentity);
      }, delay);
    },
    [maxReconnectAttempts, getReconnectDelay, updateConnectionState, log]
  );

  /**
   * Internal connect implementation
   */
  const connectInternal = useCallback(
    async (currentIdentity: string) => {
      // IDENTITY GUARD: Check at start
      if (identityRef.current !== currentIdentity) {
        log('Connect cancelled, identity changed');
        return;
      }

      if (isConnectingRef.current) {
        log('Already connecting, skipping');
        return;
      }

      isConnectingRef.current = true;
      updateConnectionState('connecting');

      try {
        // Create new JSON-RPC client
        const client = new JSONRPCClient({
          ...clientOptions,
          debug,
          maxReconnectAttempts: 0, // We handle reconnection ourselves
        });

        // Set up event handlers before connecting
        const unsubscribeConnected = client.on('connected', () => {
          // IDENTITY GUARD
          if (identityRef.current !== currentIdentity) {
            log('Connected callback for stale identity, disconnecting');
            client.disconnect();
            return;
          }

          log('Connected');
          reconnectAttemptsRef.current = 0;
          updateConnectionState('connected');
          startHeartbeat();
        });

        const unsubscribeDisconnected = client.on('disconnected', (params) => {
          // IDENTITY GUARD
          if (identityRef.current !== currentIdentity) {
            log('Disconnected callback for stale identity, ignoring');
            return;
          }

          log('Disconnected:', params);
          stopHeartbeat();

          // Don't reconnect if we're disconnecting intentionally
          if (client.connectionState !== 'disconnecting') {
            handleReconnect(currentIdentity);
          } else {
            updateConnectionState('disconnected');
          }
        });

        const unsubscribeError = client.on('error', (params) => {
          // IDENTITY GUARD
          if (identityRef.current !== currentIdentity) {
            log('Error callback for stale identity, ignoring');
            return;
          }

          log('Error:', params);
          const error =
            params instanceof Error
              ? params
              : new Error(String(params));
          onErrorRef.current?.(error);
        });

        // Handle all notifications
        const handleNotification = (method: string, params: unknown) => {
          // IDENTITY GUARD
          if (identityRef.current !== currentIdentity) {
            return;
          }

          // Handle pong for heartbeat
          if (method === 'pong') {
            handlePong();
            return;
          }

          // Forward to callback
          onNotificationRef.current?.(method, params);
        };

        // Connect to WebSocket
        await client.connect(url);

        // IDENTITY GUARD: Check after async connect
        if (identityRef.current !== currentIdentity) {
          log('Connected but identity changed, disconnecting');
          unsubscribeConnected();
          unsubscribeDisconnected();
          unsubscribeError();
          client.disconnect();
          return;
        }

        // Store refs
        clientRef.current = client;

        // Set up notification handler by patching the client's internal handler
        // Note: This is a bit of a hack, but JSONRPCClient doesn't expose a way
        // to listen to all notifications. We could also extend the class.
        const originalHandleMessage = (client as unknown as { handleMessage: (e: MessageEvent) => void }).handleMessage;
        (client as unknown as { handleMessage: (e: MessageEvent) => void }).handleMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.method && !data.id) {
              handleNotification(data.method, data.params);
            }
          } catch {
            // Ignore parse errors
          }
          originalHandleMessage.call(client, event);
        };

        log('Connection established');
      } catch (error) {
        // IDENTITY GUARD: Check after error
        if (identityRef.current !== currentIdentity) {
          log('Connect failed but identity changed, ignoring');
          return;
        }

        log('Connection failed:', error);
        updateConnectionState('disconnected');

        const err = error instanceof Error ? error : new Error(String(error));
        onErrorRef.current?.(err);

        // Attempt reconnection
        handleReconnect(currentIdentity);
      } finally {
        isConnectingRef.current = false;
      }
    },
    [
      url,
      clientOptions,
      debug,
      updateConnectionState,
      startHeartbeat,
      stopHeartbeat,
      handleReconnect,
      handlePong,
      log,
    ]
  );

  /**
   * Public connect method
   */
  const connect = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      log('No session ID, skipping connect');
      return;
    }

    const newIdentity = crypto.randomUUID();
    identityRef.current = newIdentity;
    setIdentity(newIdentity);

    log('Connecting with new identity:', newIdentity.slice(0, 8));
    await connectInternal(newIdentity);
  }, [sessionId, connectInternal, log]);

  /**
   * Public disconnect method
   */
  const disconnect = useCallback(() => {
    log('Disconnecting');

    // Invalidate identity to prevent stale callbacks
    identityRef.current = '';
    setIdentity('');

    // Clear timers
    stopHeartbeat();
    clearReconnectTimer();

    // Disconnect client
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }

    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Reset state
    reconnectAttemptsRef.current = 0;
    isConnectingRef.current = false;
    updateConnectionState('disconnected');
  }, [stopHeartbeat, clearReconnectTimer, updateConnectionState, log]);

  /**
   * Public reconnect method
   */
  const reconnect = useCallback(async (): Promise<void> => {
    log('Reconnecting...');
    disconnect();
    // Small delay to ensure cleanup
    await new Promise((resolve) => setTimeout(resolve, 50));
    await connect();
  }, [disconnect, connect, log]);

  /**
   * Atomic teardown and connection on session change
   *
   * CRITICAL: useLayoutEffect ensures this runs before paint,
   * preventing stale callbacks from updating the UI.
   */
  useLayoutEffect(() => {
    if (!sessionId) {
      // No session, ensure disconnected
      disconnect();
      return;
    }

    // Generate new identity for this session
    const newIdentity = crypto.randomUUID();
    identityRef.current = newIdentity;
    setIdentity(newIdentity);

    log('Session changed, new identity:', newIdentity.slice(0, 8));

    // Auto-connect if enabled
    if (autoConnect) {
      connectInternal(newIdentity);
    }

    // ATOMIC CLEANUP: Runs before paint on unmount or before next effect
    return () => {
      log('Cleanup: invalidating identity', newIdentity.slice(0, 8));

      // Invalidate identity FIRST to prevent any stale callbacks
      identityRef.current = '';

      // Clear all timers
      stopHeartbeat();
      clearReconnectTimer();

      // Disconnect client
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }

      // Close WebSocket
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      // Reset connection state
      reconnectAttemptsRef.current = 0;
      isConnectingRef.current = false;
    };
  }, [sessionId]); // Only depend on sessionId - other deps are stable

  /**
   * Handle browser tab visibility changes
   */
  useLayoutEffect(() => {
    const handleVisibilityChange = () => {
      const currentIdentity = identityRef.current;

      if (document.visibilityState === 'visible') {
        // IDENTITY GUARD
        if (identityRef.current !== currentIdentity) return;

        log('Tab visible, checking connection');

        // Check if connection is stale
        if (clientRef.current?.isConnected) {
          const timeSinceLastPong = Date.now() - heartbeatRef.current.lastPong;
          if (timeSinceLastPong > heartbeatTimeout) {
            log('Connection stale after tab focus, reconnecting');
            handleReconnect(currentIdentity);
          } else {
            // Send ping to verify connection
            clientRef.current.notify('ping');
          }
        } else if (sessionId && autoConnect) {
          // Reconnect if disconnected
          log('Reconnecting after tab focus');
          connectInternal(currentIdentity);
        }
      } else {
        log('Tab hidden');
        // Could pause heartbeat here to save resources
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [sessionId, autoConnect, heartbeatTimeout, handleReconnect, connectInternal, log]);

  return {
    client: clientRef.current,
    isConnected: connectionState === 'connected',
    connectionState,
    identity,
    connect,
    disconnect,
    reconnect,
  };
}

/**
 * Utility to check if a callback is still valid based on identity
 *
 * @example
 * ```typescript
 * const currentIdentity = identityRef.current;
 * fetchData().then((result) => {
 *   if (!isIdentityValid(identityRef.current, currentIdentity)) {
 *     return; // Stale callback
 *   }
 *   // Process result
 * });
 * ```
 */
export function isIdentityValid(currentIdentity: string, expectedIdentity: string): boolean {
  return currentIdentity === expectedIdentity && currentIdentity !== '';
}

/**
 * Create an identity guard wrapper for async operations
 *
 * @example
 * ```typescript
 * const guard = createIdentityGuard(identityRef);
 * fetchData().then(guard((result) => {
 *   // Only runs if identity is still valid
 *   setState(result);
 * }));
 * ```
 */
export function createIdentityGuard(
  identityRef: React.MutableRefObject<string>
): <T>(callback: (result: T) => void) => (result: T) => void {
  return <T>(callback: (result: T) => void) => {
    const expectedIdentity = identityRef.current;
    return (result: T) => {
      if (identityRef.current !== expectedIdentity || identityRef.current === '') {
        return; // Stale callback
      }
      callback(result);
    };
  };
}

export default useSessionWebSocket;

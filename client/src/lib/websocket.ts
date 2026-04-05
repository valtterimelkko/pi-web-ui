// WebSocket client with automatic reconnection and worker-based session support

import { useAuth } from '../hooks/useAuth';

/**
 * Worker status types for worker-based session architecture
 */
export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'terminated' | 'error';

// Use Vite proxy in development, or direct URL in production
const WS_URL = import.meta.env.VITE_WS_URL || '/ws';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * Worker status update message from server
 */
export interface WorkerStatusMessage {
  type: 'worker_status';
  sessionId: string;
  status: WorkerStatus;
  error?: string;
  timestamp?: number;
}

/**
 * Extension UI request message from workers
 */
export interface ExtensionUIRequestMessage {
  type: 'extension_ui_request';
  request: {
    id: string;
    type: 'confirm' | 'select' | 'input' | 'editor' | 'notify';
    method: string;
    params: Record<string, unknown>;
    timeout: number;
  };
  sessionId?: string;
}

/**
 * Session event wrapper for multi-session routing
 */
export interface SessionEventMessage {
  type: 'session_event';
  sessionId: string;
  event: {
    type: string;
    [key: string]: unknown;
  };
}

/**
 * Union type for all worker-related messages
 */
export type WorkerMessage =
  | WorkerStatusMessage
  | ExtensionUIRequestMessage
  | SessionEventMessage;

/**
 * Type guard for worker status messages
 */
export function isWorkerStatusMessage(message: unknown): message is WorkerStatusMessage {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  return (
    msg.type === 'worker_status' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.status === 'string' &&
    ['spawning', 'ready', 'streaming', 'idle', 'terminated', 'error'].includes(msg.status)
  );
}

/**
 * Type guard for extension UI request messages
 */
export function isExtensionUIRequestMessage(message: unknown): message is ExtensionUIRequestMessage {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  return (
    msg.type === 'extension_ui_request' &&
    typeof msg.request === 'object' &&
    msg.request !== null &&
    typeof (msg.request as Record<string, unknown>).id === 'string'
  );
}

/**
 * Type guard for session event messages
 */
export function isSessionEventMessage(message: unknown): message is SessionEventMessage {
  if (typeof message !== 'object' || message === null) return false;
  const msg = message as Record<string, unknown>;
  return (
    msg.type === 'session_event' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.event === 'object' &&
    msg.event !== null
  );
}

export interface WebSocketClientOptions {
  onMessage: (message: unknown) => void;
  onStatusChange: (status: WebSocketStatus) => void;
  onError?: (error: Error) => void;
  // Worker-specific handlers (optional, for direct handling)
  onWorkerStatusUpdate?: (message: WorkerStatusMessage) => void;
  onExtensionUIRequest?: (message: ExtensionUIRequestMessage) => void;
  onSessionEvent?: (message: SessionEventMessage) => void;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private options: WebSocketClientOptions;
  private status: WebSocketStatus = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private csrfToken: string | null = null;
  // Track if we're reconnecting to a worker-based session
  private pendingSessionReconnect: string | null = null;
  // Additional message listeners (for useSessionStream hook)
  private messageListeners: Set<(message: unknown) => void> = new Set();

  constructor(options: WebSocketClientOptions) {
    this.options = options;
    this.csrfToken = useAuth.getState().csrfToken;
  }

  /**
   * Register a listener for all incoming messages.
   * Returns an unsubscribe function.
   */
  addMessageListener(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  connect(targetSessionId?: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // Track if we're reconnecting to a specific session
    if (targetSessionId) {
      this.pendingSessionReconnect = targetSessionId;
    }

    this.setStatus('connecting');

    try {
      this.ws = new WebSocket(WS_URL);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.setStatus('connected');
        this.reconnectAttempts = 0;
        this.startHeartbeat();

        // Send auth message with CSRF token
        if (this.csrfToken) {
          this.send({ type: 'auth', csrfToken: this.csrfToken });
        }

        // If we were reconnecting to a specific session, resubscribe
        if (this.pendingSessionReconnect) {
          console.log(`[WebSocket] Reconnecting to session: ${this.pendingSessionReconnect}`);
          this.send({
            type: 'subscribe_session',
            sessionPath: this.pendingSessionReconnect
          });
          this.pendingSessionReconnect = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        this.stopHeartbeat();
        // Check if this was an abnormal closure that might indicate worker issues
        if (event.code === 1006 || event.code === 1011) {
          console.warn('[WebSocket] Abnormal closure, may need worker recovery');
        }
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.options.onError?.(new Error('WebSocket error'));
      };
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.setStatus('disconnected');
      this.attemptReconnect();
    }
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingSessionReconnect = null;
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
  }

  send(message: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('Failed to send message:', error);
      return false;
    }
  }

  getStatus(): WebSocketStatus {
    return this.status;
  }

  /**
   * Handle worker spawn errors gracefully
   */
  handleWorkerSpawnError(sessionId: string, error: Error): void {
    console.error(`[WebSocket] Worker spawn error for session ${sessionId}:`, error);
    // Notify the server to clean up any partial state
    this.send({
      type: 'worker_spawn_error',
      sessionId,
      error: error.message
    });
    // Call the error handler
    this.options.onError?.(error);
  }

  /**
   * Subscribe to a worker-based session
   */
  subscribeToSession(sessionPath: string): boolean {
    return this.send({ type: 'subscribe_session', sessionPath });
  }

  /**
   * Unsubscribe from a worker-based session
   */
  unsubscribeFromSession(sessionPath: string): boolean {
    return this.send({ type: 'unsubscribe_session', sessionPath });
  }

  private setStatus(status: WebSocketStatus): void {
    this.status = status;
    this.options.onStatusChange(status);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.setStatus('disconnected');
      return;
    }

    this.reconnectAttempts++;
    this.setStatus('reconnecting');

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30000); // 30 second heartbeat
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Handle incoming messages with worker-specific routing
   */
  private handleMessage(message: unknown): void {
    // Handle worker status updates
    if (isWorkerStatusMessage(message)) {
      console.log(`[WebSocket] Worker status update: ${message.sessionId} = ${message.status}`);
      this.options.onWorkerStatusUpdate?.(message);

      // Handle worker errors
      if (message.status === 'error' && message.error) {
        console.error(`[WebSocket] Worker error for ${message.sessionId}:`, message.error);
      }

      // Handle worker termination
      if (message.status === 'terminated') {
        console.log(`[WebSocket] Worker terminated for ${message.sessionId}`);
      }
    }

    // Handle extension UI requests from workers
    if (isExtensionUIRequestMessage(message)) {
      console.log(`[WebSocket] Extension UI request: ${message.request.method}`);
      this.options.onExtensionUIRequest?.(message);
    }

    // Handle session events (multi-session routing)
    if (isSessionEventMessage(message)) {
      this.options.onSessionEvent?.(message);
    }

    // Always forward to the general message handler
    this.options.onMessage(message);

    // Notify additional listeners (e.g. useSessionStream)
    this.messageListeners.forEach(listener => {
      try { listener(message); } catch (e) { console.error('Message listener error:', e); }
    });
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null;
let isConnecting = false;

// Global instance reference for useSessionStream and other consumers
let globalInstance: WebSocketClient | null = null;

/**
 * Register a WebSocketClient as the global instance.
 * Called automatically by createWebSocketClient.
 */
export function registerWebSocketInstance(client: WebSocketClient) {
  globalInstance = client;
}

/**
 * Get the global WebSocketClient instance.
 * Returns null if no client has been created yet.
 */
export function getWebSocketInstance(): WebSocketClient | null {
  return globalInstance;
}

export function createWebSocketClient(options: WebSocketClientOptions): WebSocketClient {
  // Return existing instance if it exists and is connected or connecting
  if (wsClient) {
    const status = wsClient.getStatus();
    if (status === 'connected' || status === 'connecting' || isConnecting) {
      return wsClient;
    }
    // If disconnected, disconnect and create new
    wsClient.disconnect();
  }

  isConnecting = true;
  wsClient = new WebSocketClient({
    ...options,
    onStatusChange: (status) => {
      if (status === 'connected' || status === 'disconnected') {
        isConnecting = false;
      }
      options.onStatusChange?.(status);
    },
  });

  // Register as the global instance
  registerWebSocketInstance(wsClient);

  return wsClient;
}

export function getWebSocketClient(): WebSocketClient | null {
  return wsClient;
}

export function disconnectWebSocket(): void {
  wsClient?.disconnect();
  wsClient = null;
  globalInstance = null;
}

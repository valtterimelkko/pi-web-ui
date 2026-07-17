// WebSocket client with automatic reconnection and worker-based session support

import { useAuth } from '../hooks/useAuth';
import { recordBrowserDiagnostic, recordProtocolDrift } from './browserDiagnostics.js';

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
    type: 'confirm' | 'select' | 'input' | 'editor' | 'notify' | 'ask_user_question';
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
  /** Deterministic seams for bounded reconnect tests. */
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  random?: () => number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private options: WebSocketClientOptions;
  private status: WebSocketStatus = 'disconnected';
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private readonly random: () => number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private csrfToken: string | null = null;
  // Track if we're reconnecting to a worker-based session
  private pendingSessionReconnect: string | null = null;
  private intentionalDisconnect = false;

  constructor(options: WebSocketClientOptions) {
    this.options = options;
    this.csrfToken = useAuth.getState().csrfToken;
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 5);
    this.reconnectDelay = Math.max(10, options.reconnectDelay ?? 1000);
    this.random = options.random ?? Math.random;
  }

  connect(targetSessionId?: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.intentionalDisconnect = false;

    // Track if we're reconnecting to a specific session
    if (targetSessionId) {
      this.pendingSessionReconnect = targetSessionId;
    }

    this.setStatus('connecting');

    try {
      // The CSRF token is refreshed by checkAuthStatus() on app startup.
      // Re-read it for every connection so a singleton client does not keep
      // using a token that expired or was invalidated by a server restart.
      this.csrfToken = useAuth.getState().csrfToken;
      this.ws = new WebSocket(WS_URL);
      const socket = this.ws;

      socket.onopen = () => {
        if (this.ws !== socket || this.intentionalDisconnect) {
          socket.close();
          return;
        }
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

      socket.onmessage = (event) => {
        if (this.ws !== socket || this.intentionalDisconnect) return;
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (error) {
          recordProtocolDrift('malformed');
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      socket.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        // Ignore a delayed close from a socket that was replaced by a newer
        // connection. An intentional close is still useful local evidence.
        if (this.ws !== socket) {
          if (this.intentionalDisconnect) {
            recordBrowserDiagnostic({
              kind: 'connection', state: 'disconnected', closeCode: event.code,
              closeReason: event.reason, reconnectAttempt: this.reconnectAttempts,
            });
          }
          return;
        }
        this.stopHeartbeat();
        this.ws = null;
        recordBrowserDiagnostic({
          kind: 'connection',
          state: 'disconnected',
          closeCode: event.code,
          closeReason: event.reason,
          reconnectAttempt: this.reconnectAttempts,
        });
        if (this.intentionalDisconnect) {
          this.setStatus('disconnected');
          return;
        }
        // Check if this was an abnormal closure that might indicate worker issues
        if (event.code === 1006 || event.code === 1011) {
          console.warn('[WebSocket] Abnormal closure, may need worker recovery');
        }
        this.attemptReconnect();
      };

      socket.onerror = (error) => {
        if (this.ws !== socket || this.intentionalDisconnect) return;
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
    this.intentionalDisconnect = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingSessionReconnect = null;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
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
    recordBrowserDiagnostic({
      kind: 'connection',
      state: status,
      reconnectAttempt: this.reconnectAttempts,
    });
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

    const exponential = Math.min(30_000, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));
    const jitter = 0.8 + Math.min(1, Math.max(0, this.random())) * 0.4;
    const delay = Math.round(exponential * jitter);
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
    // The general store handler records one privacy-safe message projection.
    // Avoid duplicating every protocol event in the bounded browser ring here.
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
  }
}

// Singleton instance
let wsClient: WebSocketClient | null = null;
let isConnecting = false;

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
  return wsClient;
}

export function getWebSocketClient(): WebSocketClient | null {
  return wsClient;
}

export function disconnectWebSocket(): void {
  wsClient?.disconnect();
  wsClient = null;
}

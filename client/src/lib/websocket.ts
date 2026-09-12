// WebSocket client with automatic reconnection and worker-based session support

import { useAuth } from '../hooks/useAuth';
import { recordBrowserDiagnostic, recordProtocolDrift } from './browserDiagnostics.js';

const API_BASE = import.meta.env.VITE_API_URL || '';

/**
 * Refresh the CSRF token (best-effort) before reconnecting. After a backend
 * restart the server's in-memory CSRF store is empty, so re-sending a stale
 * token would get the reconnected (and queue-flushed) messages refused with
 * CSRF_TOKEN_REFRESH_REQUIRED. /api/auth/me issues a fresh token for the
 * existing cookie session — no page refresh needed.
 *
 * Deliberately NOT useAuth.checkAuthStatus(): that helper flips
 * isAuthenticated to false on any failure (including being offline), which
 * would tear the whole app down to the login screen mid-outage and destroy
 * exactly the queued state this module is protecting. Only the token is
 * replaced; on failure the old token is kept and connect() proceeds anyway.
 */
async function refreshCsrfBeforeReconnect(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({})) as { csrfToken?: unknown };
    const csrfToken = typeof data.csrfToken === 'string'
      ? data.csrfToken
      : response.headers.get('X-CSRF-Token');
    if (csrfToken) {
      useAuth.setState({ csrfToken });
    }
  } catch {
    // Offline: connect anyway with whatever token the store holds.
  }
}

/**
 * Worker status types for worker-based session architecture
 */
export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'terminated' | 'error';

// Use Vite proxy in development, or direct URL in production
const WS_URL = import.meta.env.VITE_WS_URL || '/ws';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/**
 * Outcome of a send attempt.
 * - 'sent'   — handed to an open socket.
 * - 'queued' — the socket was down; the message is held in order and will be
 *              flushed automatically after reconnection. Not an error.
 * - 'failed' — the message could not be queued or delivered and has been
 *              dropped; onSendFailed has fired and callers should surface it.
 */
export type WebSocketSendResult = 'sent' | 'queued' | 'failed';

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
  /** Upper bound on messages held while the socket is down. */
  maxQueuedMessages?: number;
  /** A send could not be queued or delivered and was dropped. */
  onSendFailed?: (reason: string) => void;
  /** A send was queued because the socket was down (queueDepth = new depth). */
  onMessageQueued?: (queueDepth: number) => void;
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
  // Outbound messages held while the socket is down, in send order. Mobile
  // browsers suspend timers when a tab is backgrounded, so a dictated prompt
  // can easily be typed while the socket is dead; queueing it here (instead of
  // dropping it on the floor) is what keeps spoken instructions from being lost.
  private outboundQueue: unknown[] = [];
  private maxQueuedMessages: number;
  // The server processes switch_session asynchronously (it rehydrates the
  // session before acknowledging with session_switched). A queued prompt
  // flushed before that acknowledgement is refused with SESSION_NOT_FOUND, so
  // after a reconnect that re-subscribes, the flush waits for the ack (with a
  // bounded fallback so a lost ack cannot stall the queue forever).
  private switchAckPending = false;
  private switchAckTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SWITCH_ACK_FALLBACK_MS = 15_000;

  constructor(options: WebSocketClientOptions) {
    this.options = options;
    this.csrfToken = useAuth.getState().csrfToken;
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 5);
    this.reconnectDelay = Math.max(10, options.reconnectDelay ?? 1000);
    this.maxQueuedMessages = Math.max(1, options.maxQueuedMessages ?? 50);
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
          this.switchAckPending = true;
        }

        // Anything queued while the socket was down goes out after the auth
        // handshake and session re-subscription above — the server refuses
        // prompts for a session it has not (re)subscribed to. When a switch is
        // being processed, hold the flush until its session_switched ack.
        if (this.outboundQueue.length > 0 && this.switchAckPending) {
          this.armSwitchAckFallback();
        } else {
          this.flushOutboundQueue();
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
        this.clearSwitchAckFallback();
        this.switchAckPending = false;
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
    this.clearSwitchAckFallback();
    this.switchAckPending = false;
    this.pendingSessionReconnect = null;
    // An intentional disconnect has no recovery path for queued messages; drop
    // them loudly rather than silently.
    if (this.outboundQueue.length > 0) {
      const dropped = this.outboundQueue.length;
      this.outboundQueue = [];
      this.notifySendFailed(
        `${dropped} queued message${dropped === 1 ? '' : 's'} could not be delivered because the connection was closed.`
      );
    }
    const socket = this.ws;
    this.ws = null;
    socket?.close();
    this.setStatus('disconnected');
  }

  send(message: unknown): WebSocketSendResult {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return this.queueOutbound(message);
    }

    // Track re-subscribes so a post-reconnect flush knows to wait for the
    // server's session_switched acknowledgement before sending queued prompts.
    if (
      message && typeof message === 'object'
      && (message as { type?: string }).type === 'switch_session'
    ) {
      this.switchAckPending = true;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return 'sent';
    } catch (error) {
      // A half-open socket can throw synchronously; keep the message rather
      // than dropping it on the floor.
      console.error('Failed to send message:', error);
      return this.queueOutbound(message);
    }
  }

  /**
   * Re-evaluate the connection after the tab was suspended. Mobile browsers
   * freeze timers when a tab is backgrounded or the screen locks, so the
   * scheduled reconnect never fires (or fires stale) on return. Resume events
   * (visibilitychange → visible, online, focus) call this directly: if the
   * socket is not open, reconnect immediately and reset the attempt budget so
   * a frozen tab cannot have exhausted it for good.
   */
  handleResume(): void {
    if (this.intentionalDisconnect) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    void refreshCsrfBeforeReconnect().then(() => this.connect());
  }

  /** Hold a message for delivery after reconnect; never drops it silently. */
  private queueOutbound(message: unknown): WebSocketSendResult {
    if (this.intentionalDisconnect) {
      this.notifySendFailed('Message could not be sent because the connection was closed.');
      return 'failed';
    }
    if (this.outboundQueue.length >= this.maxQueuedMessages) {
      this.notifySendFailed('Message could not be sent because the send queue is full.');
      return 'failed';
    }
    this.outboundQueue.push(message);
    this.options.onMessageQueued?.(this.outboundQueue.length);
    // A user send on a dead connection is itself a reason to reconnect now,
    // not after the (possibly frozen) backoff timer.
    this.handleResume();
    return 'queued';
  }

  /** Flush held messages, in order, on an open socket. */
  private flushOutboundQueue(): void {
    while (this.outboundQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const message = this.outboundQueue[0];
      try {
        this.ws.send(JSON.stringify(message));
        this.outboundQueue.shift();
      } catch (error) {
        // Leave the remainder queued; the next successful reconnect retries it.
        console.error('Failed to flush queued message:', error);
        this.notifySendFailed('A queued message could not be delivered; it will be retried after reconnecting.');
        break;
      }
    }
  }

  /** A lost ack must not stall the queue forever. */
  private armSwitchAckFallback(): void {
    if (this.switchAckTimer) clearTimeout(this.switchAckTimer);
    this.switchAckTimer = setTimeout(() => {
      this.switchAckTimer = null;
      this.switchAckPending = false;
      this.flushOutboundQueue();
    }, WebSocketClient.SWITCH_ACK_FALLBACK_MS);
  }

  private clearSwitchAckFallback(): void {
    if (this.switchAckTimer) {
      clearTimeout(this.switchAckTimer);
      this.switchAckTimer = null;
    }
  }

  private notifySendFailed(reason: string): void {
    recordBrowserDiagnostic({ kind: 'connection', state: 'send_failed' });
    this.options.onSendFailed?.(reason);
  }

  getStatus(): WebSocketStatus {
    return this.status;
  }

  /** True while outbound messages are held for delivery after reconnect. */
  hasQueuedMessages(): boolean {
    return this.outboundQueue.length > 0;
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
  subscribeToSession(sessionPath: string): WebSocketSendResult {
    return this.send({ type: 'subscribe_session', sessionPath });
  }

  /**
   * Unsubscribe from a worker-based session
   */
  unsubscribeFromSession(sessionPath: string): WebSocketSendResult {
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
      void refreshCsrfBeforeReconnect().then(() => this.connect());
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
    // A completed (or definitively failed) session switch releases a flush that
    // was held for the re-subscription acknowledgement.
    const messageType = (message as { type?: string }).type;
    if (messageType === 'session_switched' || messageType === 'session_subscribed') {
      this.switchAckPending = false;
      this.clearSwitchAckFallback();
      this.flushOutboundQueue();
    } else if (
      messageType === 'error'
      && typeof (message as { code?: string }).code === 'string'
      && ['SESSION_NOT_FOUND', 'SESSION_FILE_MISSING', 'SESSION_IDENTITY_MISMATCH', 'SUBSCRIBE_FAILED'].includes((message as { code: string }).code)
    ) {
      this.switchAckPending = false;
      this.clearSwitchAckFallback();
      this.flushOutboundQueue();
    }

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

// Resume listeners are attached once, when the app's singleton client is
// created. Mobile browsers freeze timers while a tab is suspended, so without
// these the scheduled reconnect never fires on return — refresh was the only
// thing that reconnected, which is exactly the defect being fixed.
let resumeListenersAttached = false;
function attachResumeListeners(): void {
  if (resumeListenersAttached || typeof window === 'undefined' || typeof document === 'undefined') return;
  resumeListenersAttached = true;
  const onResume = (): void => {
    wsClient?.handleResume();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onResume();
  });
  window.addEventListener('online', onResume);
  window.addEventListener('focus', onResume);
  // bfcache restore (history navigation on mobile) resumes without a
  // visibilitychange transition.
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) onResume();
  });
}

export function createWebSocketClient(options: WebSocketClientOptions): WebSocketClient {
  // Return existing instance if it exists and is connected or connecting
  if (wsClient) {
    const status = wsClient.getStatus();
    if (status === 'connected' || status === 'connecting' || isConnecting) {
      return wsClient;
    }
    if (wsClient.hasQueuedMessages()) {
      // Queued outbound messages are durable user data (e.g. a dictated
      // prompt captured while the socket was down). Replacing the singleton
      // would drop them via disconnect(), so adopt the existing client and
      // let it reconnect and flush instead.
      wsClient.handleResume();
      return wsClient;
    }
    // If disconnected, disconnect and create new
    wsClient.disconnect();
  }

  attachResumeListeners();
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

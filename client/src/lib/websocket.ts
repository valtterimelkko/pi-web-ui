// WebSocket client with automatic reconnection

import { useAuth } from '../hooks/useAuth';

// Use Vite proxy in development, or direct URL in production
const WS_URL = import.meta.env.VITE_WS_URL || '/ws';

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface WebSocketClientOptions {
  onMessage: (message: unknown) => void;
  onStatusChange: (status: WebSocketStatus) => void;
  onError?: (error: Error) => void;
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

  constructor(options: WebSocketClientOptions) {
    this.options = options;
    this.csrfToken = useAuth.getState().csrfToken;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

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
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.options.onMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.stopHeartbeat();
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

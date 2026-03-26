// JSON-RPC 2.0 Client for WebSocket communication

/**
 * Connection states for the JSON-RPC client
 */
export type ConnectionState = 
  | 'connecting' 
  | 'connected' 
  | 'disconnecting' 
  | 'disconnected';

/**
 * JSON-RPC 2.0 request object
 */
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 notification object (no id, no response expected)
 */
export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 success response
 */
export interface JSONRPCSuccessResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result: T;
}

/**
 * JSON-RPC 2.0 error response
 */
export interface JSONRPCErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * JSON-RPC 2.0 response (success or error)
 */
export type JSONRPCResponse<T = unknown> = 
  | JSONRPCSuccessResponse<T> 
  | JSONRPCErrorResponse;

/**
 * JSON-RPC error codes
 */
export const JSONRPCErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Error class for JSON-RPC specific errors
 */
export class JSONRPCError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'JSONRPCError';
    this.code = code;
    this.data = data;
  }

  static fromErrorResponse(error: JSONRPCErrorResponse['error']): JSONRPCError {
    return new JSONRPCError(error.message, error.code, error.data);
  }
}

/**
 * Error class for connection-related errors
 */
export class JSONRPCConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JSONRPCConnectionError';
  }
}

/**
 * Error class for timeout errors
 */
export class JSONRPCTimeoutError extends Error {
  public readonly method: string;
  public readonly requestId: string | number;

  constructor(method: string, requestId: string | number, timeout: number) {
    super(`Request '${method}' (id: ${requestId}) timed out after ${timeout}ms`);
    this.name = 'JSONRPCTimeoutError';
    this.method = method;
    this.requestId = requestId;
  }
}

/**
 * Pending request tracker entry
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
}

/**
 * Options for the JSON-RPC client
 */
export interface JSONRPCClientOptions {
  /** Request timeout in milliseconds (default: 30000) */
  requestTimeout?: number;
  /** Maximum reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Base reconnection delay in milliseconds (default: 1000) */
  reconnectDelay?: number;
  /** Maximum reconnection delay in milliseconds (default: 30000) */
  maxReconnectDelay?: number;
  /** Debug logging enabled */
  debug?: boolean;
}

/**
 * JSON-RPC 2.0 client for WebSocket communication.
 * 
 * Features:
 * - Request/response correlation with unique IDs
 * - Automatic reconnection with exponential backoff
 * - Event-based notification handling
 * - Timeout handling for requests
 * - Connection state management
 * 
 * @example
 * ```typescript
 * const client = new JSONRPCClient();
 * 
 * // Connect
 * await client.connect('ws://localhost:3000/ws');
 * 
 * // Make a request
 * const result = await client.request<{ id: string }>('getUser', { id: '123' });
 * 
 * // Send a notification
 * client.notify('statusUpdate', { status: 'active' });
 * 
 * // Listen for events
 * const unsubscribe = client.on('userJoined', (params) => {
 *   console.log('User joined:', params);
 * });
 * 
 * // Cleanup
 * unsubscribe();
 * client.disconnect();
 * ```
 */
export class JSONRPCClient {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private requestTracker: Map<string | number, PendingRequest> = new Map();
  private eventHandlers: Map<string, Set<(params: unknown) => void>> = new Map();
  private requestIdCounter: number = 0;
  
  private _connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  
  private readonly requestTimeout: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly debug: boolean;

  constructor(options: JSONRPCClientOptions = {}) {
    this.requestTimeout = options.requestTimeout ?? 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.debug = options.debug ?? false;
    
    // Initialize built-in event handlers
    this.eventHandlers.set('connected', new Set());
    this.eventHandlers.set('disconnected', new Set());
    this.eventHandlers.set('error', new Set());
    this.eventHandlers.set('reconnecting', new Set());
  }

  /**
   * Current connection state
   */
  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  /**
   * Whether the client is currently connected
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to a WebSocket endpoint
   * @param url WebSocket URL to connect to
   * @returns Promise that resolves when connected
   */
  async connect(url: string): Promise<void> {
    if (this._connectionState === 'connected' || this._connectionState === 'connecting') {
      if (this.url === url) {
        return; // Already connected/connecting to the same URL
      }
      // Disconnect from previous URL
      this.disconnect();
    }

    this.url = url;
    
    return new Promise((resolve, reject) => {
      this.setConnectionState('connecting');
      
      try {
        this.ws = new WebSocket(url);
        
        const cleanup = () => {
          this.ws?.removeEventListener('open', onOpen);
          this.ws?.removeEventListener('error', onError);
          this.ws?.removeEventListener('close', onClose);
        };
        
        const onOpen = () => {
          cleanup();
          this.setConnectionState('connected');
          this.reconnectAttempts = 0;
          this.log('Connected to', url);
          this.emit('connected', { url });
          resolve();
        };
        
        const onError = (event: Event) => {
          cleanup();
          const error = new JSONRPCConnectionError('Failed to connect');
          this.log('Connection error:', event);
          this.emit('error', { error, event });
          reject(error);
        };
        
        const onClose = () => {
          cleanup();
          reject(new JSONRPCConnectionError('Connection closed before handshake'));
        };
        
        this.ws.addEventListener('open', onOpen);
        this.ws.addEventListener('error', onError);
        this.ws.addEventListener('close', onClose);
        
        // Set up permanent handlers after initial connection
        this.ws.addEventListener('message', (event) => this.handleMessage(event));
        this.ws.addEventListener('close', () => this.handleClose());
        this.ws.addEventListener('error', (event) => this.handleError(event));
        
      } catch (error) {
        this.setConnectionState('disconnected');
        reject(new JSONRPCConnectionError(
          `Failed to create WebSocket: ${error instanceof Error ? error.message : String(error)}`
        ));
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    if (this._connectionState === 'disconnected' || this._connectionState === 'disconnecting') {
      return;
    }

    this.setConnectionState('disconnecting');
    
    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Reject all pending requests
    this.rejectAllPending(new JSONRPCConnectionError('Disconnected'));
    
    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    this.setConnectionState('disconnected');
    this.emit('disconnected', { reason: 'client_disconnect' });
    this.log('Disconnected');
  }

  /**
   * Send a JSON-RPC request and wait for response
   * @param method Method name to call
   * @param params Parameters to pass
   * @returns Promise that resolves with the result
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.isConnected) {
      throw new JSONRPCConnectionError('Not connected');
    }

    const id = this.generateRequestId();
    
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.requestTracker.delete(String(id));
        reject(new JSONRPCTimeoutError(method, id, this.requestTimeout));
      }, this.requestTimeout);

      // Track the request
      this.requestTracker.set(String(id), {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeout,
        method,
      });

      // Send the request
      this.log('Sending request:', request);
      this.ws!.send(JSON.stringify(request));
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   * @param method Method name
   * @param params Parameters to pass
   */
  notify<T = unknown>(method: string, params?: T): void {
    if (!this.isConnected) {
      this.log('Cannot send notification, not connected');
      return;
    }

    const notification: JSONRPCNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.log('Sending notification:', notification);
    this.ws!.send(JSON.stringify(notification));
  }

  /**
   * Register an event listener
   * @param event Event name (built-in: 'connected', 'disconnected', 'error', 'reconnecting')
   *              or server notification method name
   * @param handler Handler function to call with event params
   * @returns Unsubscribe function
   */
  on(event: string, handler: (params: unknown) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    
    this.eventHandlers.get(event)!.add(handler);
    
    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  /**
   * Remove an event listener
   * @param event Event name
   * @param handler Handler function to remove
   */
  off(event: string, handler: (params: unknown) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Remove all listeners for an event
   * @param event Event name (optional, removes all if not provided)
   */
  removeAllListeners(event?: string): void {
    if (event) {
      this.eventHandlers.get(event)?.clear();
    } else {
      this.eventHandlers.clear();
      // Re-initialize built-in events
      this.eventHandlers.set('connected', new Set());
      this.eventHandlers.set('disconnected', new Set());
      this.eventHandlers.set('error', new Set());
      this.eventHandlers.set('reconnecting', new Set());
    }
  }

  // Private methods

  private generateRequestId(): number {
    return ++this.requestIdCounter;
  }

  private setConnectionState(state: ConnectionState): void {
    this._connectionState = state;
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data) as JSONRPCResponse | JSONRPCNotification;
      this.log('Received message:', data);

      // Check if it's a response (has id)
      if ('id' in data) {
        this.handleResponse(data as JSONRPCResponse);
      } else {
        // It's a notification
        this.handleNotification(data as JSONRPCNotification);
      }
    } catch (error) {
      this.log('Failed to parse message:', error);
      this.emit('error', { 
        error: new JSONRPCError(
          'Failed to parse message',
          JSONRPCErrorCodes.PARSE_ERROR,
          error
        )
      });
    }
  }

  private handleResponse(response: JSONRPCResponse): void {
    const pending = this.requestTracker.get(String(response.id));
    
    if (!pending) {
      this.log('Received response for unknown request:', response.id);
      return;
    }

    // Clear timeout and remove from tracker
    clearTimeout(pending.timeout);
    this.requestTracker.delete(String(response.id));

    if ('result' in response) {
      // Success response
      pending.resolve(response.result);
    } else {
      // Error response
      pending.reject(JSONRPCError.fromErrorResponse(response.error));
    }
  }

  private handleNotification(notification: JSONRPCNotification): void {
    this.emit(notification.method, notification.params);
  }

  private handleClose(): void {
    this.log('Connection closed');
    
    // Reject pending requests
    this.rejectAllPending(new JSONRPCConnectionError('Connection closed'));
    
    // Attempt reconnection if we have a URL and weren't explicitly disconnected
    if (this.url && this._connectionState !== 'disconnecting') {
      this.attemptReconnect();
    } else {
      this.setConnectionState('disconnected');
      this.emit('disconnected', { reason: 'connection_closed' });
    }
  }

  private handleError(event: Event): void {
    this.log('WebSocket error:', event);
    this.emit('error', { event });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('Max reconnection attempts reached');
      this.setConnectionState('disconnected');
      this.emit('disconnected', { reason: 'max_reconnect_attempts' });
      return;
    }

    this.reconnectAttempts++;
    this.setConnectionState('connecting');
    this.emit('reconnecting', { 
      attempt: this.reconnectAttempts, 
      maxAttempts: this.maxReconnectAttempts,
      delay: this.getReconnectDelay()
    });

    const delay = this.getReconnectDelay();
    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      if (this.url) {
        this.connect(this.url).catch((error) => {
          this.log('Reconnection attempt failed:', error);
          // Will try again if attempts remain
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.attemptReconnect();
          } else {
            this.setConnectionState('disconnected');
            this.emit('disconnected', { reason: 'reconnect_failed' });
          }
        });
      }
    }, delay);
  }

  private getReconnectDelay(): number {
    // Exponential backoff with jitter
    const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const jitter = Math.random() * 0.1 * baseDelay; // 10% jitter
    const delay = baseDelay + jitter;
    return Math.min(delay, this.maxReconnectDelay);
  }

  private emit(event: string, params: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(params);
        } catch (error) {
          this.log(`Error in event handler for '${event}':`, error);
        }
      });
    }
  }

  private rejectAllPending(error: Error): void {
    this.requestTracker.forEach((pending, id) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.requestTracker.clear();
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[JSONRPCClient]', ...args);
    }
  }
}

// Export a factory function for convenience
export function createJSONRPCClient(options?: JSONRPCClientOptions): JSONRPCClient {
  return new JSONRPCClient(options);
}

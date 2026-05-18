import { EventEmitter } from 'events';
import WebSocket from 'ws';

export type ChannelEventType =
  | 'session_init'
  | 'agent_start'
  | 'agent_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'tool_execution_start'
  | 'tool_execution_end'
  | 'permission_request'
  | 'rate_limit'
  | 'session_status'
  | 'error'
  | 'history';

export interface ChannelEvent {
  type: ChannelEventType;
  sessionId: string;
  [key: string]: unknown;
}

export interface ChannelPromptRequest {
  type: 'prompt';
  sessionId: string;
  content: string;
  cwd?: string;
}

export interface ChannelAbortRequest {
  type: 'abort';
  sessionId: string;
}

export interface ChannelPermissionResponse {
  type: 'permission_response';
  requestId: string;
  allowed: boolean;
}

export type ChannelClientRequest =
  | ChannelPromptRequest
  | ChannelAbortRequest
  | ChannelPermissionResponse
  | { type: 'fetch_history'; sessionId: string; limit?: number }
  | { type: 'set_model'; sessionId: string; model: string };

const VALID_CHANNEL_EVENT_TYPES: Set<string> = new Set<ChannelEventType>([
  'session_init',
  'agent_start',
  'agent_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_end',
  'permission_request',
  'rate_limit',
  'session_status',
  'error',
  'history',
]);

export interface ClaudeChannelWsClientOptions {
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnect?: boolean;
  heartbeatInterval?: number;
}

const DEFAULTS = {
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  reconnect: true,
  heartbeatInterval: 30000,
} as const;

const MAX_QUEUE_SIZE = 100;
const HEARTBEAT_TIMEOUT = 10000;

export class ClaudeChannelWsClient extends EventEmitter {
  private url: string;
  private options: Required<ClaudeChannelWsClientOptions>;
  private ws: WebSocket | null = null;
  private messageQueue: ChannelClientRequest[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private _intentionalDisconnect = false;

  constructor(url: string, options?: ClaudeChannelWsClientOptions) {
    super();
    this.url = url;
    this.options = {
      reconnectDelay: options?.reconnectDelay ?? DEFAULTS.reconnectDelay,
      maxReconnectDelay: options?.maxReconnectDelay ?? DEFAULTS.maxReconnectDelay,
      reconnect: options?.reconnect ?? DEFAULTS.reconnect,
      heartbeatInterval: options?.heartbeatInterval ?? DEFAULTS.heartbeatInterval,
    };
  }

  async connect(): Promise<void> {
    this._intentionalDisconnect = false;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onError = (err: Error) => {
        ws.removeListener('open', onOpen);
        reject(err);
      };

      const onOpen = () => {
        ws.removeListener('error', onError);
        this._connected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.flushQueue();
        this.emit('connected');
        resolve();
      };

      ws.once('open', onOpen);
      ws.once('error', onError);

      ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      ws.on('pong', () => {
        this.resetHeartbeatTimeout();
      });

      ws.on('close', () => {
        this.handleClose();
      });

      ws.on('error', (err: Error) => {
        this.emit('error', err);
      });
    });
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSING) {
          ws.terminate();
        }
      } catch {
        // ignore
      }
    }

    if (this._connected) {
      this._connected = false;
      this.emit('disconnected');
    }
  }

  send(message: ChannelClientRequest): void {
    if (this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      if (this.messageQueue.length < MAX_QUEUE_SIZE) {
        this.messageQueue.push(message);
      }
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  onEvent(handler: (event: ChannelEvent) => void): void {
    this.on('event', handler);
  }

  onConnected(handler: () => void): void {
    this.on('connected', handler);
  }

  onDisconnected(handler: () => void): void {
    this.on('disconnected', handler);
  }

  onError(handler: (err: Error) => void): void {
    this.on('error', handler);
  }

  private handleMessage(data: WebSocket.Data): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      this.emit('error', new Error('Malformed JSON received from channel'));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      this.emit('error', new Error('Invalid message: expected object'));
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.type !== 'string' || !obj.type) {
      this.emit('error', new Error('Invalid message: missing type field'));
      return;
    }

    if (typeof obj.sessionId !== 'string' || !obj.sessionId) {
      if (VALID_CHANNEL_EVENT_TYPES.has(obj.type)) {
        this.emit('error', new Error(`Invalid message: missing sessionId for event type "${obj.type}"`));
        return;
      }
    }

    const event = obj as unknown as ChannelEvent;
    this.emit('event', event);
  }

  private handleClose(): void {
    const wasConnected = this._connected;
    this._connected = false;
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    if (wasConnected) {
      this.emit('disconnected');
    }

    if (!this._intentionalDisconnect && this.options.reconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = this.getBackoffDelay();
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.doReconnect();
    }, delay);
  }

  private async doReconnect(): Promise<void> {
    if (this._intentionalDisconnect) return;
    try {
      await this.connect();
    } catch {
      if (!this._intentionalDisconnect && this.options.reconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private getBackoffDelay(): number {
    const base = this.options.reconnectDelay;
    const max = this.options.maxReconnectDelay;
    const exponential = Math.min(base * Math.pow(2, this.reconnectAttempts), max);
    const jitter = Math.random() * base;
    return exponential + jitter;
  }

  private flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      if (this._connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      } else {
        this.messageQueue.unshift(msg);
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.startHeartbeatTimeout();
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private startHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();
    this.heartbeatTimeoutTimer = setTimeout(() => {
      if (this.ws) {
        try {
          this.ws.removeAllListeners();
          this.ws.close();
        } catch {
          // ignore
        }
        this.ws = null;
        this._connected = false;
        this.emit('disconnected');
        if (!this._intentionalDisconnect && this.options.reconnect) {
          this.scheduleReconnect();
        }
      }
    }, HEARTBEAT_TIMEOUT);
  }

  private resetHeartbeatTimeout(): void {
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * Session WebSocket Handler
 * Handles WebSocket connections for the process-per-session architecture.
 * 
 * This module exports both:
 * - The new SessionWebSocketHandler class (worker-based architecture)
 * - Legacy functions (handleSessionWebSocket, replayHistory, etc.) for backward compatibility
 */

import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { readFile, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import { WorkerPool } from '../workers/worker-pool.js';
import { SessionRPCClient } from '../workers/session-rpc-client.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { MultiSessionManager, SessionStatusInfo } from '../pi/multi-session-manager.js';
import type { ServerMessage } from './protocol.js';
import type { ImageContent } from '@mariozechner/pi-ai';

// ============================================================================
// New Worker-Based Architecture
// ============================================================================

export type WSSender = (clientId: string, message: unknown) => void;

export interface SessionWebSocketOptions {
  ws: WebSocket;
  clientId: string;
  workerPool: WorkerPool;
  send: WSSender;
}

export interface SessionWebSocketMessage {
  type: string;
  sessionId?: string;
  sessionPath?: string;
  message?: string;
  images?: Array<{ type: string; data: string; mimeType?: string }>;
  level?: string;
  provider?: string;
  modelId?: string;
  customInstructions?: string;
}

/**
 * Handles WebSocket communication for session workers.
 */
export class SessionWebSocketHandler {
  private ws: WebSocket;
  private clientId: string;
  private workerPool: WorkerPool;
  private send: WSSender;
  private activeSessions: Map<string, () => void> = new Map();
  private sessionClients: Map<string, SessionRPCClient> = new Map();

  constructor(options: SessionWebSocketOptions) {
    this.ws = options.ws;
    this.clientId = options.clientId;
    this.workerPool = options.workerPool;
    this.send = options.send;
  }

  /**
   * Handle incoming WebSocket message.
   */
  async handleMessage(data: unknown): Promise<void> {
    const message = data as SessionWebSocketMessage;

    switch (message.type) {
      case 'subscribe':
        await this.handleSubscribe(message);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(message);
        break;
      case 'prompt':
        await this.handlePrompt(message);
        break;
      case 'steer':
        await this.handleSteer(message);
        break;
      case 'abort':
        await this.handleAbort(message);
        break;
      case 'compact':
        await this.handleCompact(message);
        break;
      case 'set_model':
        await this.handleSetModel(message);
        break;
      case 'set_thinking_level':
        await this.handleSetThinkingLevel(message);
        break;
    }
  }

  /**
   * Handle session subscription.
   */
  private async handleSubscribe(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    if (!sessionPath) return;

    try {
      // Get or create worker
      const worker = await this.workerPool.getOrCreate(sessionPath);
      const client = new SessionRPCClient(worker);
      
      // Store client for this session
      this.sessionClients.set(sessionPath, client);

      // Subscribe to events
      const unsubscribe = client.subscribe((event: NormalizedEvent) => {
        this.send(this.clientId, {
          type: 'session_event',
          sessionId: sessionPath,
          event,
        });
      });

      this.activeSessions.set(sessionPath, unsubscribe);

      // Send confirmation
      this.send(this.clientId, {
        type: 'subscribed',
        sessionId: sessionPath,
        status: worker.status,
      });
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to subscribe',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Handle session unsubscription.
   */
  private handleUnsubscribe(message: SessionWebSocketMessage): void {
    const sessionPath = message.sessionPath || message.sessionId;
    if (!sessionPath) return;

    const unsubscribe = this.activeSessions.get(sessionPath);
    if (unsubscribe) {
      unsubscribe();
      this.activeSessions.delete(sessionPath);
    }

    this.sessionClients.delete(sessionPath);

    this.send(this.clientId, {
      type: 'unsubscribed',
      sessionId: sessionPath,
    });
  }

  /**
   * Handle prompt message.
   */
  private async handlePrompt(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    const client = sessionPath ? this.sessionClients.get(sessionPath) : undefined;
    
    if (!client) {
      this.send(this.clientId, {
        type: 'error',
        message: 'Not subscribed to session',
        sessionId: sessionPath,
      });
      return;
    }

    try {
      const images: ImageContent[] | undefined = message.images?.map(img => ({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType || 'image/png',
      }));
      await client.prompt(message.message || '', images);
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Prompt failed',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Handle steering message.
   */
  private async handleSteer(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    const client = sessionPath ? this.sessionClients.get(sessionPath) : undefined;
    
    if (!client) return;

    try {
      const images: ImageContent[] | undefined = message.images?.map(img => ({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType || 'image/png',
      }));
      await client.steer(message.message || '', images);
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Steer failed',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Handle abort message.
   */
  private async handleAbort(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    const client = sessionPath ? this.sessionClients.get(sessionPath) : undefined;
    
    if (!client) return;

    try {
      await client.abort();
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Abort failed',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Handle compact message.
   */
  private async handleCompact(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    const client = sessionPath ? this.sessionClients.get(sessionPath) : undefined;
    
    if (!client) return;

    try {
      await client.compact(message.customInstructions);
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Compact failed',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Handle set_model message.
   */
  private async handleSetModel(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    const client = sessionPath ? this.sessionClients.get(sessionPath) : undefined;
    
    if (!client || !message.provider || !message.modelId) return;

    try {
      await client.setModel(message.provider, message.modelId);
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Set model failed',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Handle set_thinking_level message.
   */
  private async handleSetThinkingLevel(message: SessionWebSocketMessage): Promise<void> {
    const sessionPath = message.sessionPath || message.sessionId;
    const client = sessionPath ? this.sessionClients.get(sessionPath) : undefined;
    
    if (!client || !message.level) return;

    try {
      await client.setThinkingLevel(message.level);
    } catch (error) {
      this.send(this.clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Set thinking level failed',
        sessionId: sessionPath,
      });
    }
  }

  /**
   * Clean up all subscriptions.
   */
  close(): void {
    for (const [sessionPath, unsubscribe] of this.activeSessions) {
      unsubscribe();
    }
    this.activeSessions.clear();
    this.sessionClients.clear();
  }

  /**
   * Get active session count.
   */
  get activeSessionCount(): number {
    return this.activeSessions.size;
  }
}

// ============================================================================
// Legacy Exports for Backward Compatibility
// ============================================================================

/**
 * @deprecated Use SessionWebSocketHandler instead. This interface is kept for backward compatibility.
 */
export interface SessionWsClient {
  ws: WebSocket;
  sessionId: string;
  sessionPath: string;
  lastEventIndex: number;
  connectedAt: Date;
  isReplayComplete: boolean;
  messageBuffer: BufferedMessage[];
  isSlowClient: boolean;
}

/**
 * @deprecated Use SessionWebSocketHandler instead. This interface is kept for backward compatibility.
 */
interface BufferedMessage {
  message: ServerMessage;
  timestamp: number;
}

/**
 * @deprecated Use SessionWebSocketHandler instead. This interface is kept for backward compatibility.
 */
export interface SessionWsOptions {
  maxBufferSize?: number;
  maxBufferAge?: number;
  verboseLogging?: boolean;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * @deprecated Use SessionWebSocketHandler instead. This function is kept for backward compatibility.
 */
export function handleSessionWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
  sessionId: string,
  multiSessionManager: MultiSessionManager,
  options: SessionWsOptions = {}
): void {
  const {
    maxBufferSize = 100,
    maxBufferAge = 30000,
    verboseLogging = false,
  } = options;

  const log = (message: string, ...args: unknown[]) => {
    if (verboseLogging) {
      console.log(`[SessionWs:${sessionId}] ${message}`, ...args);
    }
  };

  const clientId = `session-ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  log(`New connection from ${req.socket.remoteAddress}`);

  const client: SessionWsClient = {
    ws,
    sessionId,
    sessionPath: '',
    lastEventIndex: 0,
    connectedAt: new Date(),
    isReplayComplete: false,
    messageBuffer: [],
    isSlowClient: false,
  };

  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const resumeFromIndex = parseInt(url.searchParams.get('lastEventIndex') || '0', 10);
  client.lastEventIndex = resumeFromIndex;
  log(`Resume from index: ${resumeFromIndex}`);

  const sendNotification = (method: string, params: unknown): void => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    sendToClient(notification);
  };

  const sendResponse = (id: string | number, result?: unknown, error?: JsonRpcResponse['error']): void => {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result }),
    };
    sendToClient(response);
  };

  const sendToClient = (message: unknown): void => {
    const serialized = JSON.stringify(message);

    if (client.messageBuffer.length >= maxBufferSize) {
      client.isSlowClient = true;
      log(`Client marked as slow, buffer size: ${client.messageBuffer.length}`);
      const now = Date.now();
      client.messageBuffer = client.messageBuffer.filter(
        m => now - m.timestamp < maxBufferAge
      );
    }

    if (client.isSlowClient && client.messageBuffer.length > 0) {
      client.messageBuffer.push({
        message: message as ServerMessage,
        timestamp: Date.now(),
      });
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(serialized);
        processBuffer();
      } catch (error) {
        log(`Error sending message: ${error}`);
        client.messageBuffer.push({
          message: message as ServerMessage,
          timestamp: Date.now(),
        });
      }
    } else {
      client.messageBuffer.push({
        message: message as ServerMessage,
        timestamp: Date.now(),
      });
    }
  };

  const processBuffer = (): void => {
    if (client.messageBuffer.length === 0) {
      client.isSlowClient = false;
      return;
    }

    const toSend = client.messageBuffer.splice(0, 10);
    for (const buffered of toSend) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(buffered.message));
        } catch (error) {
          log(`Error sending buffered message: ${error}`);
          client.messageBuffer.unshift(buffered);
          return;
        }
      }
    }

    if (client.messageBuffer.length === 0) {
      client.isSlowClient = false;
      log(`Client buffer cleared, back to normal`);
    }
  };

  const handleMessage = (data: Buffer): void => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(data.toString()) as JsonRpcRequest;
    } catch {
      sendResponse(0, undefined, { code: -32700, message: 'Parse error: Invalid JSON' });
      return;
    }

    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      sendResponse(request.id ?? 0, undefined, {
        code: -32600,
        message: 'Invalid Request: Must be valid JSON-RPC 2.0',
      });
      return;
    }

    log(`Received method: ${request.method}`);
    routeMethod(request);
  };

  const routeMethod = (request: JsonRpcRequest): void => {
    switch (request.method) {
      case 'ping':
        handlePing(request);
        break;
      case 'resume':
        handleResume(request);
        break;
      case 'get_status':
        handleGetStatus(request);
        break;
      case 'prompt':
        handlePrompt(request);
        break;
      case 'abort':
        handleAbort(request);
        break;
      default:
        sendResponse(request.id ?? 0, undefined, {
          code: -32601,
          message: `Method not found: ${request.method}`,
        });
    }
  };

  const handlePing = (request: JsonRpcRequest): void => {
    sendResponse(request.id ?? 0, { pong: true, timestamp: Date.now() });
  };

  const handleResume = async (request: JsonRpcRequest): Promise<void> => {
    const params = request.params as { lastEventIndex?: number } | undefined;
    const newIndex = params?.lastEventIndex ?? 0;

    if (typeof newIndex !== 'number' || newIndex < 0) {
      sendResponse(request.id ?? 0, undefined, {
        code: -32602,
        message: 'Invalid params: lastEventIndex must be a non-negative number',
      });
      return;
    }

    client.lastEventIndex = newIndex;
    log(`Resume requested from index: ${newIndex}`);

    try {
      await replayHistory(client.sessionPath, ws, newIndex);
      sendResponse(request.id ?? 0, { success: true, resumedFrom: newIndex });
    } catch (error) {
      sendResponse(request.id ?? 0, undefined, {
        code: -32603,
        message: `Replay failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  const handleGetStatus = (request: JsonRpcRequest): void => {
    const status = multiSessionManager.getSessionStatus(client.sessionPath);
    sendResponse(request.id ?? 0, {
      connected: true,
      sessionId: client.sessionId,
      sessionPath: client.sessionPath,
      lastEventIndex: client.lastEventIndex,
      isReplayComplete: client.isReplayComplete,
      sessionStatus: status,
    });
  };

  const handlePrompt = async (request: JsonRpcRequest): Promise<void> => {
    const params = request.params as { message?: string } | undefined;
    if (!params?.message || typeof params.message !== 'string') {
      sendResponse(request.id ?? 0, undefined, {
        code: -32602,
        message: 'Invalid params: message is required and must be a string',
      });
      return;
    }

    try {
      await multiSessionManager.prompt(client.sessionPath, params.message);
      sendResponse(request.id ?? 0, { success: true });
    } catch (error) {
      sendResponse(request.id ?? 0, undefined, {
        code: -32603,
        message: `Prompt failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  const handleAbort = async (request: JsonRpcRequest): Promise<void> => {
    try {
      await multiSessionManager.abort(client.sessionPath);
      sendResponse(request.id ?? 0, { success: true });
    } catch (error) {
      sendResponse(request.id ?? 0, undefined, {
        code: -32603,
        message: `Abort failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  const handleClose = (code: number, reason: Buffer): void => {
    log(`Connection closed: code=${code}, reason=${reason.toString()}`);
    if (client.sessionPath) {
      multiSessionManager.unsubscribeClient(clientId, client.sessionPath);
      log(`Unsubscribed from session: ${client.sessionPath}`);
    }
    client.messageBuffer = [];
  };

  const handleError = (error: Error): void => {
    console.error(`[SessionWs:${sessionId}] WebSocket error:`, error);
    if (client.sessionPath) {
      multiSessionManager.unsubscribeClient(clientId, client.sessionPath);
    }
  };

  const initialize = async (): Promise<void> => {
    try {
      const status = await multiSessionManager.subscribeClient(clientId, sessionId);
      client.sessionPath = status.sessionPath;
      client.sessionId = status.sessionId;
      log(`Subscribed to session: ${status.sessionPath}`);

      sendResponse('init', {
        success: true,
        sessionId: status.sessionId,
        sessionPath: status.sessionPath,
        status: status.status,
        messageCount: status.messageCount,
        currentStep: status.currentStep,
      });

      await replayHistory(client.sessionPath, ws, client.lastEventIndex);
      client.isReplayComplete = true;

      sendNotification('replay_complete', {
        lastEventIndex: client.lastEventIndex,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(`[SessionWs:${sessionId}] Initialization failed:`, error);
      sendResponse('init', undefined, {
        code: -32603,
        message: `Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
      ws.close(1011, 'Initialization failed');
    }
  };

  ws.on('message', (data: Buffer) => handleMessage(data));
  ws.on('close', (code: number, reason: Buffer) => handleClose(code, reason));
  ws.on('error', (error: Error) => handleError(error));

  initialize().catch((error) => {
    console.error(`[SessionWs:${sessionId}] Unhandled initialization error:`, error);
  });
}

/**
 * @deprecated Use SessionWebSocketHandler instead. This function is kept for backward compatibility.
 */
export async function replayHistory(
  sessionPath: string,
  ws: WebSocket,
  fromIndex: number = 0
): Promise<void> {
  if (!sessionPath) {
    throw new Error('Session path is required');
  }

  let stats;
  try {
    stats = await stat(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const fileStream = createReadStream(sessionPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  let currentIndex = 0;
  let sentCount = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (currentIndex < fromIndex) {
        currentIndex++;
        continue;
      }

      try {
        const entry = JSON.parse(line);
        if (ws.readyState === WebSocket.OPEN) {
          const notification: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: 'session_event',
            params: { index: currentIndex, event: entry },
          };
          ws.send(JSON.stringify(notification));
          sentCount++;
        }
        currentIndex++;
      } catch (parseError) {
        console.warn(
          `[replayHistory] Failed to parse line ${currentIndex}:`,
          parseError instanceof Error ? parseError.message : 'Unknown error'
        );
        currentIndex++;
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  console.log(`[replayHistory] Replayed ${sentCount} events from ${sessionPath} (from index ${fromIndex})`);
}

/**
 * @deprecated Use SessionWebSocketHandler instead. This function is kept for backward compatibility.
 */
export function createSessionWebSocketHandler(
  multiSessionManager: MultiSessionManager,
  options: SessionWsOptions = {}
): (ws: WebSocket, req: IncomingMessage) => void {
  return (ws: WebSocket, req: IncomingMessage) => {
    const url = req.url || '';
    const match = url.match(/\/ws\/session\/([^\/\?]+)/);

    if (!match) {
      ws.close(1008, 'Invalid session URL');
      return;
    }

    const sessionId = match[1];
    if (!sessionId || sessionId.length === 0) {
      ws.close(1008, 'Session ID is required');
      return;
    }

    handleSessionWebSocket(ws, req, sessionId, multiSessionManager, options);
  };
}

/**
 * @deprecated Use SessionWebSocketHandler instead. This function is kept for backward compatibility.
 */
export function broadcastSessionEvent(
  multiSessionManager: MultiSessionManager,
  sessionPath: string,
  event: unknown,
  eventIndex: number
): void {
  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method: 'session_event',
    params: { index: eventIndex, event },
  };
  multiSessionManager.broadcastToSubscribers(sessionPath, notification);
}

// Re-export types
export type { SessionStatusInfo };

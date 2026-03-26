/**
 * Per-session WebSocket Endpoint
 *
 * Handles WebSocket connections for a specific session, providing:
 * - History replay on connect
 * - Live event streaming
 * - Graceful disconnect
 * - Reconnection with resume support
 */

import WebSocket from 'ws';
import type { IncomingMessage } from 'http';
import { readFile, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import type { MultiSessionManager, SessionStatusInfo } from '../pi/multi-session-manager.js';
import type { ServerMessage } from './protocol.js';

/**
 * Session WebSocket client state
 */
export interface SessionWsClient {
  ws: WebSocket;
  sessionId: string;
  sessionPath: string;
  lastEventIndex: number;
  connectedAt: Date;
  isReplayComplete: boolean;
  /** Buffer for backpressure handling */
  messageBuffer: BufferedMessage[];
  /** Whether client is slow (buffer is filling up) */
  isSlowClient: boolean;
}

/**
 * Buffered message for backpressure handling
 */
interface BufferedMessage {
  message: ServerMessage;
  timestamp: number;
}

/**
 * Configuration options for session WebSocket handler
 */
export interface SessionWsOptions {
  /** Maximum buffer size before marking client as slow (default: 100) */
  maxBufferSize?: number;
  /** Maximum time to keep buffered messages (default: 30000ms) */
  maxBufferAge?: number;
  /** Whether to enable verbose logging (default: false) */
  verboseLogging?: boolean;
}

/**
 * JSON-RPC notification format
 */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

/**
 * JSON-RPC request format (for incoming messages)
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC response format
 */
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
 * Handle a session-specific WebSocket connection.
 *
 * This is the main entry point for per-session WebSocket connections.
 * It sets up the connection lifecycle handlers and initiates history replay.
 *
 * @param ws - The WebSocket connection
 * @param req - The HTTP upgrade request
 * @param sessionId - The session ID to connect to
 * @param multiSessionManager - The multi-session manager instance
 * @param options - Configuration options
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

  // Generate a unique client ID based on connection time
  const clientId = `session-ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  log(`New connection from ${req.socket.remoteAddress}`);

  // We'll track state in a client object
  const client: SessionWsClient = {
    ws,
    sessionId,
    sessionPath: '', // Will be set after subscription
    lastEventIndex: 0,
    connectedAt: new Date(),
    isReplayComplete: false,
    messageBuffer: [],
    isSlowClient: false,
  };

  // Extract resume parameters from query string
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const resumeFromIndex = parseInt(url.searchParams.get('lastEventIndex') || '0', 10);
  client.lastEventIndex = resumeFromIndex;

  log(`Resume from index: ${resumeFromIndex}`);

  /**
   * Send a JSON-RPC notification to the client
   */
  const sendNotification = (method: string, params: unknown): void => {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    sendToClient(notification);
  };

  /**
   * Send a JSON-RPC response to the client
   */
  const sendResponse = (id: string | number, result?: unknown, error?: JsonRpcResponse['error']): void => {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      ...(error ? { error } : { result }),
    };
    sendToClient(response);
  };

  /**
   * Send raw message to client with backpressure handling
   */
  const sendToClient = (message: unknown): void => {
    const serialized = JSON.stringify(message);

    // Check if buffer is getting full (backpressure)
    if (client.messageBuffer.length >= maxBufferSize) {
      client.isSlowClient = true;
      log(`Client marked as slow, buffer size: ${client.messageBuffer.length}`);

      // Clean up old buffered messages
      const now = Date.now();
      client.messageBuffer = client.messageBuffer.filter(
        m => now - m.timestamp < maxBufferAge
      );
    }

    // If client is slow, buffer the message
    if (client.isSlowClient && client.messageBuffer.length > 0) {
      client.messageBuffer.push({
        message: message as ServerMessage,
        timestamp: Date.now(),
      });
      return;
    }

    // Try to send directly
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(serialized);

        // Process any buffered messages
        processBuffer();
      } catch (error) {
        log(`Error sending message: ${error}`);
        // Buffer for retry
        client.messageBuffer.push({
          message: message as ServerMessage,
          timestamp: Date.now(),
        });
      }
    } else {
      // Buffer for later
      client.messageBuffer.push({
        message: message as ServerMessage,
        timestamp: Date.now(),
      });
    }
  };

  /**
   * Process buffered messages (backpressure relief)
   */
  const processBuffer = (): void => {
    if (client.messageBuffer.length === 0) {
      client.isSlowClient = false;
      return;
    }

    // Send up to 10 buffered messages at a time
    const toSend = client.messageBuffer.splice(0, 10);

    for (const buffered of toSend) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(buffered.message));
        } catch (error) {
          log(`Error sending buffered message: ${error}`);
          // Re-queue at the front
          client.messageBuffer.unshift(buffered);
          return;
        }
      }
    }

    // If buffer is cleared, mark client as not slow
    if (client.messageBuffer.length === 0) {
      client.isSlowClient = false;
      log(`Client buffer cleared, back to normal`);
    }
  };

  /**
   * Handle incoming message from client
   */
  const handleMessage = (data: Buffer): void => {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(data.toString()) as JsonRpcRequest;
    } catch {
      sendResponse(0, undefined, {
        code: -32700,
        message: 'Parse error: Invalid JSON',
      });
      return;
    }

    // Validate JSON-RPC format
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      sendResponse(request.id ?? 0, undefined, {
        code: -32600,
        message: 'Invalid Request: Must be valid JSON-RPC 2.0',
      });
      return;
    }

    log(`Received method: ${request.method}`);

    // Route to method handler
    routeMethod(request);
  };

  /**
   * Route incoming method to appropriate handler
   */
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

  /**
   * Handle ping request
   */
  const handlePing = (request: JsonRpcRequest): void => {
    sendResponse(request.id ?? 0, { pong: true, timestamp: Date.now() });
  };

  /**
   * Handle resume request (replay from specific index)
   */
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

  /**
   * Handle get_status request
   */
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

  /**
   * Handle prompt request
   */
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

  /**
   * Handle abort request
   */
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

  /**
   * Handle WebSocket close
   */
  const handleClose = (code: number, reason: Buffer): void => {
    log(`Connection closed: code=${code}, reason=${reason.toString()}`);

    // Unsubscribe from session
    if (client.sessionPath) {
      multiSessionManager.unsubscribeClient(clientId, client.sessionPath);
      log(`Unsubscribed from session: ${client.sessionPath}`);
    }

    // Clear buffer
    client.messageBuffer = [];
  };

  /**
   * Handle WebSocket error
   */
  const handleError = (error: Error): void => {
    console.error(`[SessionWs:${sessionId}] WebSocket error:`, error);

    // Cleanup on error
    if (client.sessionPath) {
      multiSessionManager.unsubscribeClient(clientId, client.sessionPath);
    }
  };

  /**
   * Initialize the connection
   */
  const initialize = async (): Promise<void> => {
    try {
      // Subscribe to the session
      const status = await multiSessionManager.subscribeClient(clientId, sessionId);
      client.sessionPath = status.sessionPath;
      client.sessionId = status.sessionId;

      log(`Subscribed to session: ${status.sessionPath}`);

      // Send initialize response
      sendResponse('init', {
        success: true,
        sessionId: status.sessionId,
        sessionPath: status.sessionPath,
        status: status.status,
        messageCount: status.messageCount,
        currentStep: status.currentStep,
      });

      // Start history replay
      await replayHistory(client.sessionPath, ws, client.lastEventIndex);

      // Mark replay as complete
      client.isReplayComplete = true;

      // Notify client that replay is complete
      sendNotification('replay_complete', {
        lastEventIndex: client.lastEventIndex,
        timestamp: Date.now(),
      });

      // Set up live event forwarding
      setupEventForwarding();

    } catch (error) {
      console.error(`[SessionWs:${sessionId}] Initialization failed:`, error);
      sendResponse('init', undefined, {
        code: -32603,
        message: `Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
      ws.close(1011, 'Initialization failed');
    }
  };

  /**
   * Set up event forwarding from MultiSessionManager
   */
  const setupEventForwarding = (): void => {
    // Get the active session to check for events
    const activeSession = multiSessionManager.getActiveSession(client.sessionPath);
    if (!activeSession) {
      log(`No active session found for event forwarding`);
      return;
    }

    // Events are already being broadcast by MultiSessionManager
    // We just need to track the event index
    log(`Event forwarding set up for session: ${client.sessionPath}`);
  };

  // Set up WebSocket event handlers
  ws.on('message', (data: Buffer) => {
    handleMessage(data);
  });

  ws.on('close', (code: number, reason: Buffer) => {
    handleClose(code, reason);
  });

  ws.on('error', (error: Error) => {
    handleError(error);
  });

  // Start initialization
  initialize().catch((error) => {
    console.error(`[SessionWs:${sessionId}] Unhandled initialization error:`, error);
  });
}

/**
 * Replay session history from a JSONL file.
 *
 * Reads the session file line by line, parses events, and sends them
 * as JSON-RPC notifications to the client.
 *
 * @param sessionPath - Path to the session JSONL file
 * @param ws - WebSocket connection to send events to
 * @param fromIndex - Index to start replaying from (default: 0)
 */
export async function replayHistory(
  sessionPath: string,
  ws: WebSocket,
  fromIndex: number = 0
): Promise<void> {
  if (!sessionPath) {
    throw new Error('Session path is required');
  }

  // Check if file exists
  let stats;
  try {
    stats = await stat(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist - this is OK for new sessions
      return;
    }
    throw error;
  }

  // Read and parse the file
  const fileStream = createReadStream(sessionPath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let currentIndex = 0;
  let sentCount = 0;

  try {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      // Skip events before fromIndex
      if (currentIndex < fromIndex) {
        currentIndex++;
        continue;
      }

      try {
        const entry = JSON.parse(line);

        // Send as notification
        if (ws.readyState === WebSocket.OPEN) {
          const notification: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: 'session_event',
            params: {
              index: currentIndex,
              event: entry,
            },
          };
          ws.send(JSON.stringify(notification));
          sentCount++;
        }

        currentIndex++;
      } catch (parseError) {
        // Skip invalid lines but continue
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
 * Create a session WebSocket handler factory.
 *
 * This creates a handler function that can be used with HTTP server upgrade events.
 *
 * @param multiSessionManager - The multi-session manager instance
 * @param options - Configuration options
 * @returns Handler function for WebSocket upgrades
 */
export function createSessionWebSocketHandler(
  multiSessionManager: MultiSessionManager,
  options: SessionWsOptions = {}
): (ws: WebSocket, req: IncomingMessage) => void {
  return (ws: WebSocket, req: IncomingMessage) => {
    // Extract session ID from URL path
    // Expected format: /ws/session/:sessionId
    const url = req.url || '';
    const match = url.match(/\/ws\/session\/([^\/\?]+)/);

    if (!match) {
      ws.close(1008, 'Invalid session URL');
      return;
    }

    const sessionId = match[1];

    // Validate session ID (should be a valid path or ID)
    if (!sessionId || sessionId.length === 0) {
      ws.close(1008, 'Session ID is required');
      return;
    }

    handleSessionWebSocket(ws, req, sessionId, multiSessionManager, options);
  };
}

/**
 * Broadcast an event to all subscribers of a session.
 *
 * This is a helper function that wraps the MultiSessionManager broadcast
 * with JSON-RPC notification formatting.
 *
 * @param multiSessionManager - The multi-session manager instance
 * @param sessionPath - Path to the session
 * @param event - The event to broadcast
 * @param eventIndex - The index of this event
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
    params: {
      index: eventIndex,
      event,
    },
  };

  multiSessionManager.broadcastToSubscribers(sessionPath, notification);
}

// Re-export types
export type { SessionStatusInfo };

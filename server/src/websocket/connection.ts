import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import {
  authenticateWebSocket,
  type WsAuthResult,
} from '../security/websocket.js';
import { wsMessageLimiter } from '../security/rate-limit.js';
import { detectPromptInjection } from '../security/prompt-injection.js';
import { getPiService, type PiService } from '../pi/index.js';
import { SessionPool } from '../pi/session-pool.js';
import { EventForwarder } from '../pi/event-forwarder.js';
import type { ClientMessage, ServerMessage, ImageContent } from './protocol.js';
import { config } from '../config.js';
import { validateCsrfToken } from '../security/csrf.js';

export interface WebSocketClient {
  id: string;
  ws: WebSocket;
  isAuthenticated: boolean;
  userId?: string;
  sessionId?: string;
}

export class WebSocketConnectionManager {
  private wss: WebSocketServer;
  private clients: Map<string, WebSocketClient> = new Map();
  private piService: PiService;
  private sessionPool: SessionPool;
  private eventForwarder: EventForwarder;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.piService = getPiService();
    this.sessionPool = new SessionPool(this.piService);
    this.eventForwarder = new EventForwarder(this.sendToClient.bind(this));

    // Set up Web UI context provider for extension binding
    this.sessionPool.setWebUIContextProvider(this.getWebUIContext.bind(this));

    this.setupServer();
  }

  private setupServer(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage, authResult: WsAuthResult) => {
      const clientId = this.generateClientId();

      console.log(`WebSocket client ${clientId} connected, auth success: ${authResult.success}, userId: ${authResult.user?.userId}`);

      const client: WebSocketClient = {
        id: clientId,
        ws,
        isAuthenticated: authResult.success,
        userId: authResult.user?.userId,
      };

      this.clients.set(clientId, client);

      // Send authenticated message
      this.sendMessage(clientId, { type: 'authenticated', sessionId: clientId });

      // Set up event forwarding for this client
      this.piService.setEventHandler(clientId, (event) => {
        this.eventForwarder.forwardEvent(clientId, event);
      });

      ws.on('message', (data: Buffer) => {
        void this.handleMessage(clientId, data);
      });

      ws.on('close', () => {
        this.handleDisconnect(clientId);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
        this.handleDisconnect(clientId);
      });
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Validate origin first
    const origin = req.headers.origin;
    console.log(`WebSocket upgrade request from origin: ${origin}, allowed: ${config.allowedOrigins}`);
    
    if (!origin || !config.allowedOrigins.includes(origin)) {
      console.log(`Origin not allowed: ${origin}`);
      socket.destroy();
      return;
    }

    // Authenticate
    const authResult = authenticateWebSocket(req);
    console.log(`WebSocket auth result: ${authResult.success}, userId: ${authResult.user?.userId}`);

    if (!authResult.success) {
      console.log('WebSocket auth failed, destroying socket');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req, authResult);
    });
  }

  private async handleMessage(clientId: string, data: Buffer): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) {
      console.log(`Message from unknown client: ${clientId}`);
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
      console.log(`Received message from ${clientId}: ${message.type}, auth: ${client.isAuthenticated}`);
    } catch {
      this.sendMessage(clientId, { type: 'error', message: 'Invalid JSON', code: 'INVALID_JSON' });
      return;
    }

    // Allow 'auth' messages even if not authenticated yet
    if (!client.isAuthenticated && message.type !== 'auth') {
      this.sendMessage(clientId, { type: 'error', message: 'Not authenticated', code: 'UNAUTHORIZED' });
      return;
    }

    // Rate limiting
    if (!wsMessageLimiter.check(clientId)) {
      this.sendMessage(clientId, {
        type: 'error',
        message: 'Rate limit exceeded',
        code: 'RATE_LIMIT',
      });
      return;
    }

    try {
      await this.routeMessage(clientId, message);
    } catch (error) {
      console.error(`Error handling message from ${clientId}:`, error);
      this.sendMessage(clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Internal error',
        code: 'INTERNAL_ERROR',
      });
    }
  }

  private async routeMessage(clientId: string, message: ClientMessage): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'prompt':
        await this.handlePrompt(clientId, message);
        break;

      case 'steer':
        await this.handleSteer(clientId, message);
        break;

      case 'follow_up':
        await this.handleFollowUp(clientId, message);
        break;

      case 'abort':
        await this.handleAbort(clientId);
        break;

      case 'new_session':
        await this.handleNewSession(clientId, message);
        break;

      case 'switch_session':
        await this.handleSwitchSession(clientId, message);
        break;

      case 'get_sessions':
        await this.handleGetSessions(clientId, message);
        break;

      case 'get_session_tree':
        await this.handleGetSessionTree(clientId, message);
        break;

      case 'get_session_info':
        await this.handleGetSessionInfo(clientId);
        break;

      case 'fork':
        await this.handleFork(clientId, message);
        break;

      case 'navigate_tree':
        await this.handleNavigateTree(clientId, message);
        break;

      case 'set_model':
        await this.handleSetModel(clientId, message);
        break;

      case 'set_thinking_level':
        await this.handleSetThinkingLevel(clientId, message);
        break;

      case 'compact':
        await this.handleCompact(clientId, message);
        break;

      case 'extension_ui_response':
        await this.handleExtensionUiResponse(clientId, message);
        break;

      case 'set_session_name':
        await this.handleSetSessionName(clientId, message);
        break;

      case 'auth': {
        const client = this.clients.get(clientId);
        if (!client?.userId) {
          this.sendMessage(clientId, {
            type: 'error',
            message: 'Not authenticated',
            code: 'UNAUTHORIZED'
          });
          break;
        }

        // Validate CSRF token
        const valid = validateCsrfToken(client.userId, message.csrfToken);
        if (!valid) {
          this.sendMessage(clientId, {
            type: 'error',
            message: 'Invalid CSRF token',
            code: 'UNAUTHORIZED'
          });
          // Disconnect client on invalid CSRF
          this.handleDisconnect(clientId);
          break;
        }

        // Mark client as authenticated
        client.isAuthenticated = true;

        // CSRF validation successful
        this.sendMessage(clientId, {
          type: 'connection_status',
          status: 'authenticated'
        });
        break;
      }

      default:
        this.sendMessage(clientId, {
          type: 'error',
          message: `Unknown message type: ${(message as { type: string }).type}`,
          code: 'INVALID_MESSAGE',
        });
    }
  }

  private async handlePrompt(
    clientId: string,
    message: { type: 'prompt'; sessionId: string; message: string; images?: ImageContent[] }
  ): Promise<void> {
    // Prompt injection check
    const injectionCheck = detectPromptInjection(message.message);
    if (injectionCheck.recommendation === 'block') {
      this.sendMessage(clientId, {
        type: 'error',
        message: 'Prompt contains potentially malicious content',
        code: 'PROMPT_INJECTION',
      });
      return;
    }

    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Extension commands are handled by the SDK automatically

    await clientSession.session.prompt(message.message, {
      images: message.images,
    });
  }

  private async handleSteer(clientId: string, message: { type: 'steer'; message: string }): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    await clientSession.session.steer(message.message);
  }

  private async handleFollowUp(clientId: string, message: { type: 'follow_up'; message: string }): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    await clientSession.session.followUp(message.message);
  }

  private async handleAbort(clientId: string): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) return;

    await clientSession.session.abort();
  }

  private async handleNewSession(clientId: string, message: { type: 'new_session'; cwd?: string }): Promise<void> {
    const clientSession = await this.sessionPool.createClientSession(clientId, {
      cwd: message.cwd,
    });

    this.sendMessage(clientId, {
      type: 'session_created',
      sessionId: clientSession.sessionId,
      sessionPath: clientSession.session.sessionFile || '',
    });
  }

  private async handleSwitchSession(
    clientId: string,
    message: { type: 'switch_session'; sessionPath: string }
  ): Promise<void> {
    const clientSession = await this.sessionPool.switchClientSession(clientId, message.sessionPath);

    // Get model and context usage from the session
    const model = clientSession.session.model;
    const contextUsage = clientSession.session.getContextUsage();

    this.sendMessage(clientId, {
      type: 'session_switched',
      sessionId: clientSession.sessionId,
      sessionPath: clientSession.session.sessionFile || '',
      model: model ? `${model.provider}/${model.id}` : undefined,
      contextWindow: contextUsage?.contextWindow ?? undefined,
      contextUsed: contextUsage?.tokens ?? undefined,
      contextPercent: contextUsage?.percent ?? undefined,
    });
  }

  private async handleGetSessions(
    clientId: string,
    message: { type: 'get_sessions'; cwd?: string }
  ): Promise<void> {
    const sessions = await this.piService.listAllSessions();

    this.sendMessage(clientId, {
      type: 'sessions_list',
      sessions: sessions.map(s => ({
        id: s.id,
        path: s.path,
        firstMessage: s.firstMessage,
        messageCount: s.messageCount,
        cwd: s.cwd,
        name: s.name,
        createdAt: s.createdAt?.toISOString?.() ?? String(s.createdAt),
        lastActivity: s.lastActivity?.toISOString?.() ?? String(s.lastActivity),
      })),
    });
  }

  private async handleGetSessionTree(
    clientId: string,
    _message: { type: 'get_session_tree'; sessionId: string }
  ): Promise<void> {
    // Session tree navigation will be implemented when the SDK supports it
    // For now, return empty tree
    this.sendMessage(clientId, {
      type: 'session_tree',
      tree: [],
    });
  }

  private async handleGetSessionInfo(clientId: string): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const stats = clientSession.session.getSessionStats();
    const contextUsage = clientSession.session.getContextUsage();
    const model = clientSession.session.model;

    this.sendMessage(clientId, {
      type: 'session_info',
      stats: {
        sessionFile: clientSession.sessionId,
        sessionId: clientSession.sessionId,
        userMessages: stats.userMessages ?? 0,
        assistantMessages: stats.assistantMessages ?? 0,
        toolCalls: stats.toolCalls ?? 0,
        toolResults: stats.toolResults ?? 0,
        totalMessages: stats.totalMessages ?? 0,
        tokens: stats.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: stats.cost ?? 0,
        model: model ? `${model.provider}/${model.id}` : undefined,
        contextWindow: contextUsage?.contextWindow,
        contextUsed: contextUsage?.tokens ?? undefined,
        contextPercent: contextUsage?.percent ?? undefined,
      },
    });
  }

  private async handleFork(clientId: string, _message: { type: 'fork'; entryId: string }): Promise<void> {
    // Forking will be implemented when the SDK supports it
    this.sendMessage(clientId, {
      type: 'error',
      message: 'Fork not yet implemented',
      code: 'NOT_IMPLEMENTED',
    });
  }

  private async handleNavigateTree(
    clientId: string,
    _message: { type: 'navigate_tree'; entryId: string; summarize?: boolean }
  ): Promise<void> {
    // Tree navigation will be implemented when the SDK supports it
    this.sendMessage(clientId, {
      type: 'error',
      message: 'Tree navigation not yet implemented',
      code: 'NOT_IMPLEMENTED',
    });
  }

  private async handleSetModel(clientId: string, message: { type: 'set_model'; modelId: string }): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Parse model ID (format: provider/model-name)
    const [provider, ...modelParts] = message.modelId.split('/');
    const modelId = modelParts.join('/');

    if (!provider || !modelId) {
      this.sendMessage(clientId, { type: 'error', message: 'Invalid model ID format', code: 'INVALID_MESSAGE' });
      return;
    }

    // Use pi service to set model
    await this.piService.setModel(clientSession.sessionId, message.modelId);

    this.sendMessage(clientId, {
      type: 'model_changed',
      modelId: message.modelId,
    });
  }

  private async handleSetThinkingLevel(
    clientId: string,
    message: { type: 'set_thinking_level'; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  ): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    clientSession.session.setThinkingLevel(message.level);

    this.sendMessage(clientId, {
      type: 'thinking_level_changed',
      level: message.level,
    });
  }

  private async handleCompact(
    clientId: string,
    message: { type: 'compact'; customInstructions?: string }
  ): Promise<void> {
    const clientSession = this.sessionPool.getClientSession(clientId);
    if (!clientSession) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const result = await clientSession.session.compact(message.customInstructions);

    this.sendMessage(clientId, {
      type: 'compaction_result',
      summary: result.summary,
      tokensBefore: result.tokensBefore,
    });
  }

  private async handleExtensionUiResponse(
    clientId: string,
    message: { type: 'extension_ui_response'; response: { id: string; approved?: boolean; value?: unknown; cancelled?: boolean } }
  ): Promise<void> {
    const { getExtensionUIHandler } = await import('../pi/extension-ui-handler.js');
    const handler = getExtensionUIHandler();
    handler.handleResponse(message.response);
  }

  private async handleSetSessionName(
    clientId: string,
    message: { type: 'set_session_name'; sessionId: string; name: string }
  ): Promise<void> {
    const { getSessionWatcher } = await import('../pi/session-watcher.js');
    const watcher = getSessionWatcher();

    // Find the session by ID to get its path
    const sessions = await watcher.listSessions();
    const session = sessions.find(s => s.id === message.sessionId);

    if (!session) {
      this.sendMessage(clientId, {
        type: 'error',
        message: `Session not found: ${message.sessionId}`,
        code: 'SESSION_NOT_FOUND',
      });
      return;
    }

    // Update the session metadata with the new name
    await watcher.setSessionName(session.path, message.name);

    // Broadcast the update to all clients
    this.broadcast({
      type: 'session_name_updated',
      sessionId: message.sessionId,
      name: message.name,
    });

    // Confirm to the sender
    this.sendMessage(clientId, {
      type: 'session_name_changed',
      sessionId: message.sessionId,
      name: message.name,
    });
  }

  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      this.sessionPool.removeClient(clientId);
      this.clients.delete(clientId);
    }
  }

  private sendMessage(clientId: string, message: ServerMessage): void {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  private sendToClient(clientId: string, message: unknown): void {
    this.sendMessage(clientId, message as ServerMessage);
  }

  /**
   * Get Web UI context for a client (used by extension binding)
   */
  private getWebUIContext(clientId: string): { sendToClient: (message: unknown) => void; clientId: string } | undefined {
    const client = this.clients.get(clientId);
    // DEBUG: console.log(`[getWebUIContext] clientId=${clientId}, found=${!!client}`);
    if (!client) return undefined;

    return {
      clientId,
      sendToClient: (message: unknown) => {
        this.sendToClient(clientId, message);
      },
    };
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(serialized);
      }
    }
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getStats(): { connectedClients: number } {
    return {
      connectedClients: this.clients.size,
    };
  }

  /**
   * Close all connections and cleanup
   */
  async close(): Promise<void> {
    for (const [clientId, client] of this.clients.entries()) {
      client.ws.close();
      this.sessionPool.removeClient(clientId);
    }
    this.clients.clear();
    this.wss.close();
  }
}

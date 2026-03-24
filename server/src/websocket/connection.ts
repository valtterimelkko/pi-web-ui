import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { readFile, stat } from 'fs/promises';
import {
  authenticateWebSocket,
  type WsAuthResult,
} from '../security/websocket.js';
import { wsMessageLimiter } from '../security/rate-limit.js';
import { detectPromptInjection } from '../security/prompt-injection.js';
import { getPiService, type PiService } from '../pi/index.js';
import { SessionPool } from '../pi/session-pool.js';
import { MultiSessionManager, type SessionStatus } from '../pi/multi-session-manager.js';
import { EventForwarder } from '../pi/event-forwarder.js';
import type { ClientMessage, ServerMessage, ImageContent, SessionMessage } from './protocol.js';
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
  private multiSessionManager: MultiSessionManager;
  private eventForwarder: EventForwarder;
  /** Track CWD per client for session info */
  private clientCwd: Map<string, string> = new Map();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.piService = getPiService();
    this.sessionPool = new SessionPool(this.piService);
    this.eventForwarder = new EventForwarder(this.sendToClient.bind(this));

    // Create MultiSessionManager with broadcast function
    // Note: No automatic cleanup - sessions persist until explicitly stopped
    this.multiSessionManager = new MultiSessionManager(
      this.piService,
      this.sendToClient.bind(this)
    );

    // Set up event forwarder to track streaming state
    this.eventForwarder.setSessionPool(this.sessionPool);

    // Set up Web UI context provider for MultiSessionManager (extension binding)
    this.multiSessionManager.setWebUIContextProvider(this.getWebUIContextForMultiSession.bind(this));

    // Set up session status change broadcasting
    this.setupSessionStatusBroadcasting();

    this.setupServer();
  }

  /**
   * Set up broadcasting of session status changes to all clients
   */
  private setupSessionStatusBroadcasting(): void {
    // Poll for session status changes every second
    setInterval(() => {
      const statuses = this.multiSessionManager.getAllSessionStatuses();
      for (const status of statuses) {
        this.broadcast({
          type: 'session_status',
          sessionId: status.sessionId,
          sessionPath: status.sessionPath,
          status: status.status,
          lastActivity: status.lastActivity.toISOString(),
          messageCount: status.messageCount,
          currentStep: status.currentStep,
        });
      }
    }, 1000);
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

      case 'subscribe_session':
        await this.handleSubscribeSession(clientId, message);
        break;

      case 'unsubscribe_session':
        await this.handleUnsubscribeSession(clientId, message);
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

    // Get the session path the client is currently viewing
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Extension commands are handled by the SDK automatically

    await agentSession.prompt(message.message, {
      images: message.images,
    });
  }

  private async handleSteer(clientId: string, message: { type: 'steer'; message: string }): Promise<void> {
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    await agentSession.steer(message.message);
  }

  private async handleFollowUp(clientId: string, message: { type: 'follow_up'; message: string }): Promise<void> {
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    await agentSession.followUp(message.message);
  }

  private async handleAbort(clientId: string): Promise<void> {
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) return;

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) return;

    await agentSession.abort();
  }

  private async handleNewSession(clientId: string, message: { type: 'new_session'; cwd?: string }): Promise<void> {
    console.log(`[handleNewSession] Creating session for client ${clientId}, cwd=${message.cwd || 'not specified'}`);

    // Create a new session via PiService to get the session path
    const agentSession = await this.piService.createSession({
      clientId: `multi-new-${clientId}`,
      cwd: message.cwd,
    });

    const sessionPath = agentSession.sessionFile;
    if (!sessionPath) {
      // Clean up if session file wasn't created
      agentSession.dispose();
      this.sendMessage(clientId, { type: 'error', message: 'Failed to create session', code: 'SESSION_CREATION_FAILED' });
      return;
    }

    // Dispose the session - we'll create it properly via MultiSessionManager
    agentSession.dispose();

    // Subscribe client to the session via MultiSessionManager
    const status = await this.multiSessionManager.subscribeClient(clientId, sessionPath);

    // Track that this client is viewing this session
    this.multiSessionManager.setClientViewingSession(clientId, sessionPath);

    // Store the cwd for this client
    const cwd = message.cwd || process.cwd();
    this.clientCwd.set(clientId, cwd);

    console.log(`[handleNewSession] Session created: ${status.sessionId}, sessionPath=${sessionPath}`);

    this.sendMessage(clientId, {
      type: 'session_created',
      sessionId: status.sessionId,
      sessionPath: sessionPath,
    });
  }

  private async handleSwitchSession(
    clientId: string,
    message: { type: 'switch_session'; sessionPath: string }
  ): Promise<void> {
    const sessionPath = message.sessionPath;

    // Get the old session path before switching
    const oldSessionPath = this.multiSessionManager.getClientSessionPath(clientId);

    // Unsubscribe from the old session if different from new session
    // This prevents receiving events from the old session while viewing the new one
    if (oldSessionPath && oldSessionPath !== sessionPath) {
      this.multiSessionManager.unsubscribeClient(clientId, oldSessionPath);
      console.log(`[handleSwitchSession] Client ${clientId} unsubscribed from ${oldSessionPath}`);
    }

    // Subscribe to the new session via MultiSessionManager (creates if doesn't exist)
    const status = await this.multiSessionManager.subscribeClient(clientId, sessionPath);

    // Track that this client is now viewing this session
    this.multiSessionManager.setClientViewingSession(clientId, sessionPath);

    // Look up the cwd for this session from the sessions list
    let cwd = this.clientCwd.get(clientId) || process.cwd();
    try {
      const allSessions = await this.piService.listAllSessions();
      const sessionInfo = allSessions.find(s => s.path === sessionPath);
      if (sessionInfo?.cwd) {
        cwd = sessionInfo.cwd;
      }
    } catch {
      // Fallback to existing cwd
    }
    this.clientCwd.set(clientId, cwd);

    // Get the agent session for model/context info
    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);

    // Get model and context usage from the session
    const model = agentSession?.model;
    const contextUsage = agentSession?.getContextUsage();

    // Load session messages from file
    const { messages, fileTimestamp } = await this.loadSessionMessages(sessionPath);

    // Check if session is currently streaming using MultiSessionManager status
    const isStreaming = status.status === 'streaming' || status.status === 'busy';

    this.sendMessage(clientId, {
      type: 'session_switched',
      sessionId: status.sessionId,
      sessionPath: sessionPath,
      model: model ? `${model.provider}/${model.id}` : undefined,
      contextWindow: contextUsage?.contextWindow ?? undefined,
      contextUsed: contextUsage?.tokens ?? undefined,
      contextPercent: contextUsage?.percent ?? undefined,
      messages,
      fileTimestamp,
      isStreaming,
    });

    // Note: The old session (oldSessionPath) is NOT disposed here.
    // It remains active in MultiSessionManager for background processing
    // and can be switched back to by the client or other clients.
    console.log(`[handleSwitchSession] Client ${clientId} switched from ${oldSessionPath || 'none'} to ${sessionPath}. Old session remains active.`);
  }

  /**
   * Load messages from a session file (JSONL format)
   * Returns messages and file modification timestamp for cache invalidation
   */
  private async loadSessionMessages(sessionPath: string): Promise<{ messages: SessionMessage[]; fileTimestamp: number }> {
    try {
      if (!sessionPath) {
        return { messages: [], fileTimestamp: 0 };
      }

      // Get file stats for timestamp
      const stats = await stat(sessionPath);
      const fileTimestamp = stats.mtimeMs;

      // Read the session file
      const fileContent = await readFile(sessionPath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim());
      
      const messages: SessionMessage[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          
          // Only process message entries
          if (entry.type !== 'message') {
            continue;
          }

          const messageData = entry.message as Record<string, unknown> | undefined;
          if (!messageData) {
            continue;
          }

          const role = messageData.role as string;
          
          // Only include user and assistant messages
          if (role !== 'user' && role !== 'assistant') {
            continue;
          }

          // Parse content
          const content = messageData.content as Array<{ type: string; text?: string; thinking?: string }> | undefined;
          const timestamp = messageData.timestamp as number | undefined;

          // Transform content to client format
          let transformedContent: SessionMessage['content'];
          if (Array.isArray(content)) {
            // Filter out signature fields from thinking blocks and map content
            transformedContent = content
              .filter(item => item.type === 'text' || item.type === 'thinking')
              .map(item => {
                if (item.type === 'thinking') {
                  return { 
                    type: 'thinking', 
                    thinking: item.thinking || '' 
                  };
                }
                return { 
                  type: 'text', 
                  text: item.text || '' 
                };
              });
          } else {
            transformedContent = '';
          }

          // Check if this is a skill content message (from /skill:name commands)
          // These messages contain raw skill file content that should be filtered
          const contentText = Array.isArray(transformedContent) 
            ? transformedContent.map(c => c.text || '').join('')
            : '';
          const hasSkillTag = contentText.includes('<skill name="');
          const hasCloseTag = contentText.includes('</skill>');
          const hasSkillMd = contentText.includes('SKILL.md');
          const hasLectureHeader = contentText.includes('# Lecture Website Builder');
          
          if (hasSkillTag || hasCloseTag || hasSkillMd || hasLectureHeader) {
            console.log(`[loadSessionMessages] Filtering skill content: tag=${hasSkillTag}, close=${hasCloseTag}, md=${hasSkillMd}, header=${hasLectureHeader}`);
            continue; // Skip skill content messages
          }

          messages.push({
            id: (entry.id as string) || `msg_${timestamp || Date.now()}`,
            role: role as 'user' | 'assistant',
            content: transformedContent,
            timestamp: timestamp || Date.now(),
          });
        } catch (parseError) {
          // Skip invalid lines but continue processing
          console.warn(`Failed to parse session line: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
      }

      return { messages, fileTimestamp };
    } catch (error) {
      // Handle file reading errors gracefully
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`Session file not found: ${sessionPath}`);
      } else {
        console.warn(`Failed to load session messages from ${sessionPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return { messages: [], fileTimestamp: 0 };
    }
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
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const stats = agentSession.getSessionStats();
    const contextUsage = agentSession.getContextUsage();
    const model = agentSession.model;

    // Get the cwd from our tracking (or use process.cwd as fallback)
    const cwd = this.clientCwd.get(clientId) || process.cwd();

    this.sendMessage(clientId, {
      type: 'session_info',
      stats: {
        sessionFile: agentSession.sessionFile,
        sessionId: agentSession.sessionId,
        cwd,
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
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      console.error(`[handleSetModel] No active session for client ${clientId}`);
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      console.error(`[handleSetModel] Session not found for client ${clientId}, path: ${sessionPath}`);
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    console.log(`[handleSetModel] Client ${clientId}, session ${agentSession.sessionId}, requested model: ${message.modelId}`);
    console.log(`[handleSetModel] Session file: ${agentSession.sessionFile || 'N/A'}`);

    // Parse model ID (format: provider/model-name)
    const [provider, ...modelParts] = message.modelId.split('/');
    const modelId = modelParts.join('/');

    if (!provider || !modelId) {
      console.error(`[handleSetModel] Invalid model ID format: ${message.modelId}`);
      this.sendMessage(clientId, { type: 'error', message: 'Invalid model ID format', code: 'INVALID_MESSAGE' });
      return;
    }

    try {
      // Use pi service to set model
      await this.piService.setModel(agentSession.sessionId, message.modelId);
      
      console.log(`[handleSetModel] Model change successful for session ${agentSession.sessionId}`);

      this.sendMessage(clientId, {
        type: 'model_changed',
        modelId: message.modelId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[handleSetModel] Failed to set model for session ${agentSession.sessionId}:`, errorMessage);
      
      this.sendMessage(clientId, {
        type: 'error',
        message: `Failed to change model: ${errorMessage}`,
        code: 'MODEL_CHANGE_FAILED',
      });
    }
  }

  private async handleSetThinkingLevel(
    clientId: string,
    message: { type: 'set_thinking_level'; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  ): Promise<void> {
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    agentSession.setThinkingLevel(message.level);

    this.sendMessage(clientId, {
      type: 'thinking_level_changed',
      level: message.level,
    });
  }

  private async handleCompact(
    clientId: string,
    message: { type: 'compact'; customInstructions?: string }
  ): Promise<void> {
    const sessionPath = this.multiSessionManager.getClientSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) {
      this.sendMessage(clientId, { type: 'error', message: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const result = await agentSession.compact(message.customInstructions);

    // Get updated context usage after compaction
    const contextUsage = agentSession.getContextUsage();

    this.sendMessage(clientId, {
      type: 'compaction_result',
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      contextWindow: contextUsage?.contextWindow ?? undefined,
      contextUsed: contextUsage?.tokens ?? undefined,
      contextPercent: contextUsage?.percent ?? undefined,
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

  /**
   * Subscribe a client to a session's events via MultiSessionManager.
   * This allows the client to receive real-time updates for the session.
   */
  private async handleSubscribeSession(
    clientId: string,
    message: { type: 'subscribe_session'; sessionPath: string }
  ): Promise<void> {
    try {
      const status = await this.multiSessionManager.subscribeClient(clientId, message.sessionPath);

      this.sendMessage(clientId, {
        type: 'session_subscribed',
        sessionId: status.sessionId,
        sessionPath: status.sessionPath,
        status: status.status,
        messageCount: status.messageCount,
        currentStep: status.currentStep,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[handleSubscribeSession] Failed to subscribe client ${clientId} to session:`, errorMessage);
      
      this.sendMessage(clientId, {
        type: 'error',
        message: `Failed to subscribe to session: ${errorMessage}`,
        code: 'SUBSCRIBE_FAILED',
      });
    }
  }

  /**
   * Unsubscribe a client from a session's events via MultiSessionManager.
   */
  private handleUnsubscribeSession(
    clientId: string,
    message: { type: 'unsubscribe_session'; sessionPath: string }
  ): void {
    // Get session status before unsubscribing to get sessionId
    const status = this.multiSessionManager.getSessionStatus(message.sessionPath);
    const sessionId = status?.sessionId || '';

    this.multiSessionManager.unsubscribeClient(clientId, message.sessionPath);

    this.sendMessage(clientId, {
      type: 'session_unsubscribed',
      sessionId,
      sessionPath: message.sessionPath,
    });
  }

  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      // Unsubscribe client from all sessions via MultiSessionManager
      const subscriptions = this.multiSessionManager.getClientSubscriptions(clientId);
      for (const sessionPath of subscriptions) {
        this.multiSessionManager.unsubscribeClient(clientId, sessionPath);
      }

      // Clean up client tracking data
      this.clientCwd.delete(clientId);
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
   * Get Web UI context for a client (legacy, used by SessionPool for extension binding)
   * @deprecated Use getWebUIContextForMultiSession instead for multi-session support
   */
  private getWebUIContext(clientId: string): { sendToClient: (message: unknown) => void; clientId: string } | undefined {
    const client = this.clients.get(clientId);
    if (!client) return undefined;

    return {
      clientId,
      sendToClient: (message: unknown) => {
        this.sendToClient(clientId, message);
      },
    };
  }

  /**
   * Get Web UI context for a session path (used by MultiSessionManager for extension binding).
   * This provides the WebUIContext that extensions need to communicate with the Web UI.
   */
  private getWebUIContextForMultiSession(sessionPath: string): { sendEvent: (event: any) => void; sessionPath: string } | undefined {
    // Find a client that is subscribed to this session
    // We'll use the first subscriber as the context owner
    const activeSession = this.multiSessionManager.getActiveSession(sessionPath);
    if (!activeSession) return undefined;

    // Get the first subscriber to determine which client to send events to
    const firstSubscriber = activeSession.subscribers.values().next().value as string | undefined;
    if (!firstSubscriber) return undefined;

    const client = this.clients.get(firstSubscriber);
    if (!client) return undefined;

    return {
      sessionPath,
      sendEvent: (event: any) => {
        // Broadcast to all subscribers of this session
        this.multiSessionManager.broadcastToSubscribers(sessionPath, event);
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
    // Dispose MultiSessionManager (which disposes all sessions)
    this.multiSessionManager.dispose();

    // Clean up all clients
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();
    this.wss.close();
  }
}

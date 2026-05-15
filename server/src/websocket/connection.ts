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
import { isTransferSessionContext } from './protocol.js';
import { handleSessionWebSocket } from './session-websocket.js';
import { config } from '../config.js';
import { validateCsrfToken, hasCsrfToken } from '../security/csrf.js';
import { getClaudeService, type ClaudeService } from '../claude/index.js';
import { ClaudeSessionSubscribers } from '../claude/claude-session-subscribers.js';
import { getOpenCodeService, type OpenCodeService } from '../opencode/index.js';
import { OpenCodeSessionSubscribers } from '../opencode/opencode-session-subscribers.js';
import { getSessionRegistry } from '../session-registry.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

// ============================================================================
// NormalizedEvent → Pi-compatible format converter
// ============================================================================

/**
 * Convert a NormalizedEvent (from ClaudeEventNormalizer) to the Pi-compatible
 * event format expected by the frontend sessionStore.
 */
function normEventToPiFormat(event: NormalizedEvent): Record<string, unknown> {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'message_start':
      return { type: 'message_start', message: { id: data.id, role: data.role } };
    case 'message_update':
      return { type: 'message_update', message: { id: data.id }, assistantMessageEvent: data.assistantMessageEvent };
    case 'message_end':
      return { type: 'message_end', message: { id: data.id } };
    case 'tool_execution_start':
      return { type: 'tool_execution_start', toolCallId: data.toolCallId, toolName: data.toolName, args: data.args };
    case 'tool_execution_end':
      return { type: 'tool_execution_end', toolCallId: data.toolCallId, result: data.result, isError: data.isError };
    case 'tool_execution_update':
      return { type: 'tool_execution_update', toolCallId: data.toolCallId, partialResult: data.partialResult };
    case 'agent_start':
      return { type: 'agent_start' };
    case 'agent_end':
      return { type: 'agent_end', result: (data as Record<string, unknown>).result, usage: (data as Record<string, unknown>).usage };
    case 'session_init':
      return { type: 'session_init', ...data };
    case 'rate_limit':
      return { type: 'rate_limit', ...data };
    default:
      return { type: event.type, ...data };
  }
}

// ============================================================================
// Protocol Detection
// ============================================================================

/**
 * Protocol type for WebSocket messages
 */
type ProtocolType = 'jsonrpc' | 'legacy';

/**
 * Detect the protocol of an incoming WebSocket message.
 *
 * JSON-RPC 2.0 messages have a `jsonrpc: '2.0'` field.
 * Legacy messages use the original Pi Web UI protocol.
 *
 * @param data - Raw message data as string
 * @returns 'jsonrpc' or 'legacy'
 */
function detectProtocol(data: string): ProtocolType {
  try {
    const parsed = JSON.parse(data);
    if (parsed.jsonrpc === '2.0') return 'jsonrpc';
    return 'legacy';
  } catch {
    return 'legacy';
  }
}

export interface WebSocketClient {
  id: string;
  ws: WebSocket;
  isAuthenticated: boolean;
  userId?: string;
  sessionId?: string;
}

type ClaudeAvailabilityService = Pick<ClaudeService, 'isAvailable' | 'validateAuth'>;
type OpenCodeAvailabilityService = Pick<OpenCodeService, 'isAvailable' | 'validateSetup'>;

export async function sendRuntimeAvailabilityStatus(
  clientId: string,
  claudeService: ClaudeAvailabilityService,
  opencodeService: OpenCodeAvailabilityService,
  sendMessage: (clientId: string, message: ServerMessage) => void,
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        const available = await claudeService.isAvailable();
        if (available) {
          const auth = await claudeService.validateAuth();
          sendMessage(clientId, {
            type: 'claude_available',
            available: auth.ok,
            error: auth.ok ? null : (auth.error ?? null),
          } as ServerMessage);
        } else {
          sendMessage(clientId, {
            type: 'claude_available',
            available: false,
            error: 'Claude Code not installed',
          } as ServerMessage);
        }
      } catch {
        sendMessage(clientId, {
          type: 'claude_available',
          available: false,
          error: 'Claude availability check failed',
        } as ServerMessage);
      }
    })(),
    (async () => {
      try {
        const available = await opencodeService.isAvailable();
        if (available) {
          const setup = await opencodeService.validateSetup();
          sendMessage(clientId, {
            type: 'opencode_available',
            available: setup.ok,
            error: setup.ok ? null : (setup.error ?? null),
          } as ServerMessage);
        } else {
          sendMessage(clientId, {
            type: 'opencode_available',
            available: false,
            error: 'OpenCode not installed',
          } as ServerMessage);
        }
      } catch {
        sendMessage(clientId, {
          type: 'opencode_available',
          available: false,
          error: 'OpenCode availability check failed',
        } as ServerMessage);
      }
    })(),
  ]);
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
  /** Track currently viewed session for both Pi and Claude sessions */
  private clientViewingSession: Map<string, string> = new Map();
  /** Claude service for Claude Direct sessions */
  private claudeService: ClaudeService;
  /** Session IDs (UUIDs) that are Claude sessions */
  private claudeSessionIds: Set<string> = new Set();
  /** Claude session subscribers: tracks which clients are viewing which Claude sessions */
  private claudeSubs = new ClaudeSessionSubscribers();
  private opencodeService: OpenCodeService;
  private opencodeSessionIds: Set<string> = new Set();
  private opencodeSubs = new OpenCodeSessionSubscribers();
  private pendingClaudePermissions: Map<string, string> = new Map();

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.piService = getPiService();
    this.sessionPool = new SessionPool(this.piService);
    this.eventForwarder = new EventForwarder(this.sendToClient.bind(this));
    this.claudeService = getClaudeService();
    this.opencodeService = getOpenCodeService();

    // Log Claude availability on startup
    this.claudeService.isAvailable().then(async (available) => {
      if (available) {
        const authStatus = await this.claudeService.validateAuth();
        if (authStatus.ok) {
          console.log(`[WebUI] Claude Direct available: ${authStatus.email}`);
        }
      }
    }).catch(() => { /* non-fatal */ });

    // Restore Claude session IDs from registry on startup
    void this.restoreClaudeSessionIds();
    void this.restoreOpencodeSessionIds();

    // Create MultiSessionManager with broadcast function
    // Configure aggressive cleanup for lazy session management
    this.multiSessionManager = new MultiSessionManager(
      this.piService,
      this.sendToClient.bind(this),
      {
        // Unload idle sessions after 30 minutes of inactivity with no subscribers
        idleSessionTimeoutMs: 30 * 60 * 1000,
        // Check for cleanup every 1 minute
        cleanupIntervalMs: 60 * 1000,
        // Maximum sessions to keep in memory (4 keeps ~2 GB heap under --max-old-space-size=2048)
        maxSessions: 4,
        // Maximum pinned sessions allowed (protected from cleanup)
        maxPinnedSessions: 2,
        // Enable memory monitoring
        enableMemoryMonitoring: true,
      }
    );
    // Note: Cleanup timer is started automatically in MultiSessionManager constructor
    // Note: Claude session IDs are restored asynchronously from the registry

    // Set up event forwarder to track streaming state
    this.eventForwarder.setSessionPool(this.sessionPool);

    // Set up Web UI context provider for MultiSessionManager (extension binding)
    this.multiSessionManager.setWebUIContextProvider(this.getWebUIContextForMultiSession.bind(this));

    // Set up session status change broadcasting
    this.setupSessionStatusBroadcasting();

    if (config.claudeChannelEnabled) {
      this.claudeService.startChannel().catch((err) => {
        console.error('[WebUI] Failed to start Claude channel:', err);
      });
    }

    this.setupServer();
  }

  /**
   * Restore claudeSessionIds Set from the session registry after server restart.
   */
  private async restoreClaudeSessionIds(): Promise<void> {
    try {
      const registry = getSessionRegistry();
      const claudeSessions = await registry.listBySdkType('claude');
      for (const entry of claudeSessions) {
        this.claudeSessionIds.add(entry.id);
      }
      if (claudeSessions.length > 0) {
        console.log(`[WebUI] Restored ${claudeSessions.length} Claude session ID(s) from registry`);
      }
    } catch (err) {
      console.warn('[WebUI] Failed to restore Claude session IDs from registry:', err instanceof Error ? err.message : String(err));
    }
  }

  private async restoreOpencodeSessionIds(): Promise<void> {
    try {
      const registry = getSessionRegistry();
      const opencodeSessions = await registry.listBySdkType('opencode');
      for (const entry of opencodeSessions) {
        this.opencodeSessionIds.add(entry.id);
      }
      if (opencodeSessions.length > 0) {
        console.log(`[WebUI] Restored ${opencodeSessions.length} OpenCode session ID(s) from registry`);
      }
    } catch (err) {
      console.warn('[WebUI] Failed to restore OpenCode session IDs from registry:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Set up broadcasting of session status changes to all clients.
   * Covers both Pi SDK sessions (via MultiSessionManager) and
   * Claude Direct sessions (via ClaudeService/ClaudeProcessPool).
   */
  private setupSessionStatusBroadcasting(): void {
    // Poll for session status changes every second
    setInterval(() => {
      // Pi SDK session statuses
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

      // Claude Direct session statuses — broadcast to clients viewing active Claude sessions
      for (const sessionId of this.claudeSessionIds) {
        const subscribers = this.claudeSubs.getSubscribers(sessionId);
        if (subscribers.size > 0) {
          const isRunning = this.claudeService.isRunning(sessionId);
          this.broadcast({
            type: 'session_status',
            sessionId,
            sessionPath: sessionId,
            status: isRunning ? 'streaming' : 'idle',
            lastActivity: new Date().toISOString(),
          });
        }
      }

      for (const sessionId of this.opencodeSessionIds) {
        const subscribers = this.opencodeSubs.getSubscribers(sessionId);
        if (subscribers.size > 0) {
          const isRunning = this.opencodeService.isRunning(sessionId);
          const isPinned = this.opencodeService.isSessionPinned(sessionId);
          this.broadcast({
            type: 'session_status',
            sessionId,
            sessionPath: sessionId,
            status: isRunning ? 'streaming' : 'idle',
            lastActivity: new Date().toISOString(),
            pinned: isPinned,
          });
        }
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

      // Runtime availability is read-only and should be sent as soon as the
      // cookie-authenticated WebSocket is established. Previously this was only
      // sent after the CSRF auth message, so stale/missing CSRF tokens made the
      // New Session modal incorrectly grey out Claude Direct and OpenCode Direct.
      void sendRuntimeAvailabilityStatus(
        clientId,
        this.claudeService,
        this.opencodeService,
        this.sendMessage.bind(this),
      );

      // Set up event forwarding for this client
      this.piService.setEventHandler(clientId, (event) => {
        this.eventForwarder.forwardEvent(clientId, event);
      });

      ws.on('message', (data: Buffer) => {
        void this.handleMessageWithProtocol(clientId, data, ws, req);
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

    // Check if this is a JSON-RPC session WebSocket request
    // URL format: /ws/sessions/:sessionId or /ws/session/:sessionId
    const url = req.url || '';
    if (url.includes('/ws/sessions/') || url.includes('/ws/session/')) {
      // Extract session ID from URL
      const match = url.match(/\/ws\/sessions?\/([^/?]+)/);
      if (match) {
        const sessionId = match[1];
        console.log(`JSON-RPC WebSocket upgrade for session: ${sessionId}`);

        // Authenticate first
        const authResult = authenticateWebSocket(req);
        if (!authResult.success) {
          console.log('JSON-RPC WebSocket auth failed, destroying socket');
          socket.destroy();
          return;
        }

        // Upgrade and hand off to session-websocket handler
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          handleSessionWebSocket(ws, req, sessionId, this.multiSessionManager, {
            verboseLogging: process.env.NODE_ENV === 'development',
          });
        });
        return;
      }
    }

    // Authenticate for legacy protocol
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

  /**
   * Handle incoming WebSocket message with protocol detection.
   *
   * Routes JSON-RPC messages to the session-websocket handler
   * and legacy messages to the existing message handler.
   */
  private async handleMessageWithProtocol(
    clientId: string,
    data: Buffer,
    ws: WebSocket,
    req: IncomingMessage
  ): Promise<void> {
    const dataStr = data.toString();
    const protocol = detectProtocol(dataStr);

    if (protocol === 'jsonrpc') {
      // JSON-RPC message - should not reach here for session WebSocket
      // as those are handled by session-websocket.ts directly
      console.log(`Received JSON-RPC message on legacy connection from ${clientId}`);

      // Send error response indicating wrong endpoint
      try {
        const parsed = JSON.parse(dataStr);
        const response = {
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          error: {
            code: -32600,
            message: 'Invalid Request: JSON-RPC messages should use /ws/sessions/:sessionId endpoint',
          },
        };
        ws.send(JSON.stringify(response));
      } catch {
        // Invalid JSON-RPC, ignore
      }
      return;
    }

    // Legacy protocol - use existing handler
    await this.handleMessage(clientId, data);
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

      case 'pin_session':
        this.handlePinSession(clientId, message);
        break;

      case 'unpin_session':
        this.handleUnpinSession(clientId, message);
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

        // Check if CSRF token exists for this user
        // If not, the server may have restarted and client needs to refresh
        if (!hasCsrfToken(client.userId)) {
          this.sendMessage(clientId, {
            type: 'error',
            message: 'CSRF token not found. Please refresh the page.',
            code: 'CSRF_TOKEN_REFRESH_REQUIRED'
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

      case 'transfer_session_context':
        await this.handleTransferSessionContext(clientId, message);
        break;

      default:
        this.sendMessage(clientId, {
          type: 'error',
          message: `Unknown message type: ${(message as { type: string }).type}`,
          code: 'INVALID_MESSAGE',
        });
    }
  }

  private async handleTransferSessionContext(
    clientId: string,
    message: ClientMessage,
  ): Promise<void> {
    if (!isTransferSessionContext(message)) {
      console.warn('[Transfer] Invalid message format:', JSON.stringify(message).slice(0, 200));
      this.sendMessage(clientId, {
        type: 'error',
        message: 'Invalid transfer_session_context message format',
        code: 'INVALID_MESSAGE',
      });
      return;
    }

    console.log(`[Transfer] Request: source=${message.sourceSessionId}, target=${message.targetSessionId || 'new'}, createNew=${message.createNew}, sdk=${message.targetSdkType}, cwd=${message.targetCwd}, scope=${message.scope}`);

    const { TransferService } = await import('../session-transfer/transfer-service.js');

    const transferService = new TransferService({
      registry: getSessionRegistry(),
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      createPiSession: async (cwd: string) => {
        const status = await this.multiSessionManager.createAndSubscribe(clientId, cwd, this.getWebUIContext(clientId));
        return { sessionId: status.sessionId, sessionPath: status.sessionPath };
      },
      sendPiPrompt: async (sessionPath: string, message: string) => {
        await this.multiSessionManager.prompt(sessionPath, message);
      },
    });

    const result = await transferService.executeTransfer({
      sourceSessionId: message.sourceSessionId,
      targetSessionId: message.targetSessionId,
      createNew: message.createNew,
      targetSdkType: message.targetSdkType,
      targetCwd: message.targetCwd,
      scope: message.scope,
      sourceDisplayName: message.sourceDisplayName,
    });

    if (result.success) {
      console.log(`[Transfer] Success: ${result.sourceSessionId} -> ${result.targetSessionId} (new=${result.createdNewSession})`);
      if (result.createdNewSession && result.targetSessionPath) {
        this.clientViewingSession.set(clientId, result.targetSessionPath);
        this.clientCwd.set(clientId, message.targetCwd || '');
        this.sendMessage(clientId, {
          type: 'session_created',
          sessionId: result.targetSessionId,
          sessionPath: result.targetSessionPath,
          sdkType: result.targetSdkType,
        });
      }
      this.sendMessage(clientId, {
        type: 'session_transfer_completed',
        sourceSessionId: result.sourceSessionId,
        targetSessionId: result.targetSessionId,
        createdNewSession: result.createdNewSession,
      } as unknown as ServerMessage);
    } else {
      console.warn(`[Transfer] Failed: ${result.sourceSessionId} -> ${result.targetSessionId || 'new'}: ${result.error?.code} - ${result.error?.message}`);
      this.sendMessage(clientId, {
        type: 'session_transfer_failed',
        sourceSessionId: result.sourceSessionId,
        targetSessionId: result.targetSessionId || undefined,
        message: result.error?.message ?? 'Transfer failed',
        code: result.error?.code ?? 'INTERNAL_ERROR',
      } as unknown as ServerMessage);
    }
  }

  private getCurrentSessionPath(clientId: string): string | undefined {
    return this.clientViewingSession.get(clientId) || this.multiSessionManager.getClientSessionPath(clientId);
  }

  private async handlePrompt(
    clientId: string,
    message: { type: 'prompt'; sessionId: string; message: string; images?: ImageContent[]; agent?: string }
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
    const sessionPath = this.getCurrentSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Check if this is a Claude session — dispatch to Claude handler
    if (this.opencodeSessionIds.has(sessionPath)) {
      await this.handleOpencodePrompt(clientId, sessionPath, message.message, message.images, message.agent);
      return;
    }

    if (this.claudeSessionIds.has(sessionPath)) {
      await this.handleClaudePrompt(clientId, sessionPath, message.message, message.images);
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

  /**
   * Handle a prompt for a Claude Direct session.
   */
  private async handleClaudePrompt(
    clientId: string,
    sessionId: string,
    prompt: string,
    _images?: ImageContent[]
  ): Promise<void> {
    // If the session already has a running process, wait for it to finish
    if (this.claudeService.isRunning(sessionId)) {
      console.log(`[handleClaudePrompt] Session ${sessionId} busy, waiting for current turn to finish...`);
      const maxWait = 30000; // 30 seconds max wait
      const pollInterval = 500;
      const start = Date.now();
      while (this.claudeService.isRunning(sessionId) && Date.now() - start < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      if (this.claudeService.isRunning(sessionId)) {
        this.sendMessage(clientId, { type: 'error', message: 'Session still busy after waiting', code: 'SESSION_BUSY' });
        return;
      }
    }

    try {
      await this.claudeService.sendPrompt(
        sessionId,
        prompt,
        (normalizedEvent) => {
          if (normalizedEvent.type === 'permission_request') {
            const data = normalizedEvent.data as Record<string, unknown>;
            const uiRequest = {
              type: 'extension_ui_request' as const,
              request: {
                id: data.requestId as string,
                type: 'confirm' as const,
                method: `claude.permission.${data.toolName || 'tool'}`,
                params: {
                  title: `Allow ${data.toolName}?`,
                  description: data.description || `Claude wants to use ${data.toolName}`,
                  toolName: data.toolName,
                  args: data.args,
                },
                timeout: 120000,
              },
            };
            const subscribers = this.claudeSubs.getSubscribers(sessionId);
            if (subscribers && subscribers.size > 0) {
              for (const subId of subscribers) {
                this.sendMessage(subId, uiRequest);
              }
            } else {
              this.sendMessage(clientId, uiRequest);
            }
            this.pendingClaudePermissions.set(data.requestId as string, sessionId);
            return;
          }

          const piEvent = normEventToPiFormat(normalizedEvent);
          const message = { type: 'session_event' as const, sessionId, event: piEvent };
          const subscribers = this.claudeSubs.getSubscribers(sessionId);
          if (subscribers && subscribers.size > 0) {
            for (const subId of subscribers) {
              this.sendMessage(subId, message);
            }
          } else {
            this.sendMessage(clientId, message);
          }
        },
        (error) => {
          // Broadcast errors to ALL subscribers, not just the requester
          const subscribers = this.claudeSubs.getSubscribers(sessionId);
          if (error) {
            for (const subId of subscribers) {
              this.sendMessage(subId, { type: 'error', message: error.message, code: 'CLAUDE_ERROR' });
            }
          }

          // Broadcast agent_end to all subscribers so they see the turn completed
          for (const subId of subscribers) {
            this.sendMessage(subId, {
              type: 'session_event',
              sessionId,
              event: { type: 'agent_end', result: null, usage: {} },
            } as unknown as ServerMessage);
          }
        }
      );
    } catch (error) {
      this.sendMessage(clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Claude prompt failed',
        code: 'CLAUDE_ERROR',
      });
    }
  }

  private async handleOpencodePrompt(
    clientId: string,
    sessionId: string,
    prompt: string,
    _images?: ImageContent[],
    agent?: string,
  ): Promise<void> {
    try {
      await this.opencodeService.sendPrompt(
        sessionId,
        prompt,
        (normalizedEvent) => {
          if (normalizedEvent.type === 'permission_request') {
            const permData = normalizedEvent.data as Record<string, unknown>;
            const uiRequest = {
              type: 'extension_ui_request' as const,
              request: {
                id: permData.permissionId as string,
                type: 'confirm' as const,
                method: `opencode.permission.${permData.toolName ?? 'tool'}`,
                params: {
                  title: permData.title ?? `Allow ${permData.toolName}?`,
                  description: permData.description ?? '',
                  toolName: permData.toolName,
                  args: permData.args,
                },
                timeout: 120000,
              },
            };
            const subscribers = this.opencodeSubs.getSubscribers(sessionId);
            if (subscribers.size > 0) {
              for (const subId of subscribers) {
                this.sendMessage(subId, uiRequest);
              }
            } else {
              this.sendMessage(clientId, uiRequest);
            }
            return;
          }

          const piEvent = normEventToPiFormat(normalizedEvent);
          const msg = { type: 'session_event' as const, sessionId, event: piEvent };
          const subscribers = this.opencodeSubs.getSubscribers(sessionId);
          const targets = subscribers.size > 0 ? [...subscribers] : [clientId];
          for (const subId of targets) {
            this.sendMessage(subId, msg);
          }

          if (normalizedEvent.type === 'agent_end' || normalizedEvent.type === 'message_end') {
            const ctxUsage = this.opencodeService.getContextUsage(sessionId);
            if (ctxUsage) {
              const ctxMsg = {
                type: 'context_update' as const,
                sessionId,
                contextWindow: ctxUsage.contextWindow,
                contextUsed: ctxUsage.tokens,
                contextPercent: ctxUsage.percent,
              };
              for (const subId of targets) {
                this.sendMessage(subId, ctxMsg as unknown as ServerMessage);
              }
            }
          }
        },
        (error) => {
          const subscribers = this.opencodeSubs.getSubscribers(sessionId);
          if (error) {
            for (const subId of subscribers) {
              this.sendMessage(subId, { type: 'error', message: error.message, code: 'OPENCODE_ERROR' });
            }
          }
          for (const subId of subscribers) {
            this.sendMessage(subId, {
              type: 'session_event',
              sessionId,
              event: { type: 'agent_end', result: null, usage: {} },
            } as unknown as ServerMessage);
          }
        },
        agent,
      );
    } catch (error) {
      this.sendMessage(clientId, {
        type: 'error',
        message: error instanceof Error ? error.message : 'OpenCode prompt failed',
        code: 'OPENCODE_ERROR',
      });
    }
  }

  private async handleSteer(clientId: string, message: { type: 'steer'; message: string }): Promise<void> {
    const sessionPath = this.getCurrentSessionPath(clientId);
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
    const sessionPath = this.getCurrentSessionPath(clientId);
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
    const sessionPath = this.getCurrentSessionPath(clientId);
    if (!sessionPath) return;

    // Claude session abort — broadcast state change to all subscribers
    if (this.claudeSessionIds.has(sessionPath)) {
      this.claudeService.abort(sessionPath);

      const subscribers = this.claudeSubs.getSubscribers(sessionPath);
      for (const subId of subscribers) {
        this.sendMessage(subId, {
          type: 'session_event',
          sessionId: sessionPath,
          event: { type: 'agent_end', result: null, usage: {} },
        } as unknown as ServerMessage);
      }
      return;
    }

    if (this.opencodeSessionIds.has(sessionPath)) {
      this.opencodeService.abort(sessionPath);
      const subscribers = this.opencodeSubs.getSubscribers(sessionPath);
      for (const subId of subscribers) {
        this.sendMessage(subId, {
          type: 'session_event',
          sessionId: sessionPath,
          event: { type: 'agent_end', result: null, usage: {} },
        } as unknown as ServerMessage);
      }
      return;
    }

    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);
    if (!agentSession) return;

    await agentSession.abort();
  }

  private async handleNewSession(
    clientId: string,
    message: { type: 'new_session'; cwd?: string; sdkType?: 'pi' | 'claude' | 'opencode' }
  ): Promise<void> {
    console.log(`[handleNewSession] Creating session for client ${clientId}, cwd=${message.cwd || 'not specified'}, sdkType=${message.sdkType || 'pi'}`);

    const cwd = message.cwd || process.cwd();
    const sdkType = message.sdkType || 'pi';

    if (sdkType === 'opencode') {
      try {
        const { sessionId } = await this.opencodeService.createSession(cwd);
        this.opencodeSessionIds.add(sessionId);
        this.clientViewingSession.set(clientId, sessionId);
        this.opencodeSubs.subscribe(clientId, sessionId);
        this.clientCwd.set(clientId, cwd);

        this.sendMessage(clientId, {
          type: 'session_created',
          sessionId,
          sessionPath: sessionId,
          sdkType: 'opencode',
        } as unknown as ServerMessage);
      } catch (error) {
        this.sendMessage(clientId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to create OpenCode session',
          code: 'SESSION_CREATE_FAILED',
        });
      }
      return;
    }

    if (sdkType === 'claude') {
      try {
        const { sessionId } = await this.claudeService.createSession(cwd);

        // Track this as a Claude session
        this.claudeSessionIds.add(sessionId);

        // Register the client as viewing this session
        this.clientViewingSession.set(clientId, sessionId);
        this.claudeSubs.subscribe(clientId, sessionId);
        this.clientCwd.set(clientId, cwd);

        console.log(`[handleNewSession] Claude session created: ${sessionId}`);

        this.sendMessage(clientId, {
          type: 'session_created',
          sessionId,
          sessionPath: sessionId,  // For Claude sessions, sessionId IS the path
          sdkType: 'claude',
        } as unknown as ServerMessage);
      } catch (error) {
        this.sendMessage(clientId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to create Claude session',
          code: 'SESSION_CREATE_FAILED',
        });
      }
      return;
    }

    // Pi session creation
    const status = await this.multiSessionManager.createAndSubscribe(clientId, cwd, this.getWebUIContext(clientId));

    const sessionPath = status.sessionPath;

    // Track that this client is viewing this session
    this.clientViewingSession.set(clientId, sessionPath);

    // Store the cwd for this client
    this.clientCwd.set(clientId, cwd);

    console.log(`[handleNewSession] Pi session created: ${status.sessionId}, sessionPath=${sessionPath}`);

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
    const oldSessionPath = this.getCurrentSessionPath(clientId);

    // Check if this is a Claude session — either already tracked or in registry
    let isClaudeSession = this.claudeSessionIds.has(sessionPath);
    if (!isClaudeSession) {
      // Check registry in case server restarted
      try {
        const registry = getSessionRegistry();
        const entry = await registry.get(sessionPath);
        if (entry?.sdkType === 'claude') {
          isClaudeSession = true;
          this.claudeSessionIds.add(sessionPath);
        }
      } catch {
        // Ignore registry lookup errors
      }
    }

    if (isClaudeSession) {
      if (oldSessionPath && oldSessionPath !== sessionPath) {
        this.claudeSubs.unsubscribe(clientId, oldSessionPath);
        this.multiSessionManager.unsubscribeClient(clientId, oldSessionPath);
      }
      this.clientViewingSession.set(clientId, sessionPath);
      this.claudeSubs.subscribe(clientId, sessionPath);
      await this.replayClaudeHistory(clientId, sessionPath);
      console.log(`[handleSwitchSession] Client ${clientId} switched to Claude session ${sessionPath}`);
      return;
    }

    let isOpencodeSession = this.opencodeSessionIds.has(sessionPath);
    if (!isOpencodeSession) {
      try {
        const registry = getSessionRegistry();
        const entry = await registry.get(sessionPath);
        if (entry?.sdkType === 'opencode') {
          isOpencodeSession = true;
          this.opencodeSessionIds.add(sessionPath);
        }
      } catch {
        // ignore lookup failures
      }
    }

    if (isOpencodeSession) {
      if (oldSessionPath && oldSessionPath !== sessionPath) {
        this.opencodeSubs.unsubscribe(clientId, oldSessionPath);
        this.claudeSubs.unsubscribe(clientId, oldSessionPath);
        this.multiSessionManager.unsubscribeClient(clientId, oldSessionPath);
      }
      this.clientViewingSession.set(clientId, sessionPath);
      this.opencodeSubs.subscribe(clientId, sessionPath);
      await this.opencodeService.touchSession(sessionPath);
      await this.replayOpencodeHistory(clientId, sessionPath);
      console.log(`[handleSwitchSession] Client ${clientId} switched to OpenCode session ${sessionPath}`);
      return;
    }

    // Pi session switching

    // Unsubscribe from the old session if different from new session
    // This prevents receiving events from the old session while viewing the new one
    if (oldSessionPath && oldSessionPath !== sessionPath) {
      this.multiSessionManager.unsubscribeClient(clientId, oldSessionPath);
      console.log(`[handleSwitchSession] Client ${clientId} unsubscribed from ${oldSessionPath}`);
    }

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

    // Subscribe to the new session via MultiSessionManager (creates if doesn't exist)
    const status = await this.multiSessionManager.subscribeClient(clientId, sessionPath, cwd, this.getWebUIContext(clientId));

    // Track that this client is now viewing this session
    this.clientViewingSession.set(clientId, sessionPath);

    // Get the agent session for model/context info
    const agentSession = this.multiSessionManager.getAgentSession(sessionPath);

    // Get model and context usage from the session
    const model = agentSession?.model;
    const thinkingLevel = agentSession?.thinkingLevel;
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
      thinkingLevel: thinkingLevel ?? undefined,
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
   * Replay Claude session history to a client on switch.
   */
  private async replayClaudeHistory(clientId: string, sessionId: string): Promise<void> {
    const registry = getSessionRegistry();
    const entry = await registry.get(sessionId);
    if (!entry) {
      this.sendMessage(clientId, { type: 'error', message: 'Claude session not found', code: 'SESSION_NOT_FOUND' } as unknown as ServerMessage);
      return;
    }

    // Send session_switched first
    this.sendMessage(clientId, {
      type: 'session_switched',
      sessionId,
      sessionPath: sessionId,
      sdkType: 'claude',
      model: entry.model ?? 'sonnet',
      messages: [],
      fileTimestamp: 0,
      isStreaming: this.claudeService.isRunning(sessionId),
    } as unknown as ServerMessage);

    // Load and replay history
    try {
      const { ClaudeSessionStore } = await import('../claude/claude-session-store.js');
      const { historyToReplayEvents } = await import('../claude/claude-history-replay.js');
      const { config: cfg } = await import('../config.js');

      const store = new ClaudeSessionStore(cfg.claudeSessionDir);
      const history = await store.loadHistory(sessionId);

      if (history.length === 0) {
        // Empty session, nothing to replay
        return;
      }

      // Send history_start signal
      this.sendMessage(clientId, { type: 'history_start', sessionId } as unknown as ServerMessage);

      // Send each event as a session_event
      const events = historyToReplayEvents(history);
      for (const evt of events) {
        this.sendMessage(clientId, {
          type: 'session_event',
          sessionId,
          event: evt,
        } as unknown as ServerMessage);
      }

      // Send history_end signal
      this.sendMessage(clientId, { type: 'history_end', sessionId } as unknown as ServerMessage);
    } catch (error) {
      console.error(`[replayClaudeHistory] Error replaying history for ${sessionId}:`, error);
    }
  }

  private async replayOpencodeHistory(clientId: string, sessionId: string): Promise<void> {
    const registry = getSessionRegistry();
    const entry = await registry.get(sessionId);
    if (!entry) {
      this.sendMessage(clientId, { type: 'error', message: 'OpenCode session not found', code: 'SESSION_NOT_FOUND' } as unknown as ServerMessage);
      return;
    }

    const contextUsage = this.opencodeService.getContextUsage(sessionId);

    this.sendMessage(clientId, {
      type: 'session_switched',
      sessionId,
      sessionPath: sessionId,
      sdkType: 'opencode',
      model: entry.model ?? '',
      messages: [],
      fileTimestamp: 0,
      isStreaming: this.opencodeService.isRunning(sessionId),
      contextWindow: contextUsage?.contextWindow ?? undefined,
      contextUsed: contextUsage?.tokens ?? undefined,
      contextPercent: contextUsage?.percent ?? undefined,
    } as unknown as ServerMessage);

    try {
      const events = await this.opencodeService.getReplayEvents(sessionId);
      const goalEvents = await this.opencodeService.getGoalEngineEvents(sessionId);

      if (events.length === 0 && goalEvents.length === 0) return;

      this.sendMessage(clientId, { type: 'history_start', sessionId } as unknown as ServerMessage);
      for (const evt of events) {
        this.sendMessage(clientId, {
          type: 'session_event',
          sessionId,
          event: evt,
        } as unknown as ServerMessage);
      }
      // Append goal-engine widget/status events so the frontend displays
      // the current goal state immediately on session load.
      for (const evt of goalEvents) {
        this.sendMessage(clientId, {
          type: 'session_event',
          sessionId,
          event: evt,
        } as unknown as ServerMessage);
      }
      this.sendMessage(clientId, { type: 'history_end', sessionId } as unknown as ServerMessage);
    } catch (error) {
      console.error('[replayOpencodeHistory] Error:', error);
    }
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
          // Transform skill content to brief placeholder instead of filtering entirely
          const contentText = Array.isArray(transformedContent) 
            ? transformedContent.map(c => c.text || '').join('')
            : '';
          
          // Check for skill content injection markers
          // We require BOTH opening tag AND closing tag to be specific
          const hasSkillOpenTag = contentText.includes('<skill name="');
          const hasSkillCloseTag = contentText.includes('</skill>');
          const hasFullSkillStructure = hasSkillOpenTag && hasSkillCloseTag;
          
          // Also check for lecture website builder header (actual skill content)
          const hasLectureHeader = contentText.includes('# Lecture Website Builder');
          
          // Transform skill content to brief placeholder
          if (hasFullSkillStructure || hasLectureHeader) {
            // Extract skill name if available
            const skillNameMatch = contentText.match(/<skill name="([^"]+)"/);
            const skillName = skillNameMatch ? skillNameMatch[1] : null;
            const placeholder = skillName 
              ? `📚 **Skill loaded: ${skillName}**`
              : '📚 **Skill loaded**';
            
            console.log(`[loadSessionMessages] Transforming skill content: ${skillName || 'unknown'}`);
            
            messages.push({
              id: (entry.id as string) || `msg_${timestamp || Date.now()}`,
              role: role as 'user' | 'assistant',
              content: [{ type: 'text', text: placeholder }],
              timestamp: timestamp || Date.now(),
            });
            continue;
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
    _message: { type: 'get_sessions'; cwd?: string }
  ): Promise<void> {
    const piSessions = await this.piService.listAllSessions();

    const formattedPiSessions: Array<{
      id: string; path: string;       sdkType: 'pi' | 'claude' | 'opencode';
      firstMessage: string; messageCount: number; cwd: string;
      name?: string; createdAt: string; lastActivity: string;
    }> = piSessions.map(s => ({
      id: s.id,
      path: s.path,
      sdkType: 'pi' as const,
      firstMessage: s.firstMessage,
      messageCount: s.messageCount,
      cwd: s.cwd,
      name: s.name,
      createdAt: s.createdAt?.toISOString?.() ?? String(s.createdAt),
      lastActivity: s.lastActivity?.toISOString?.() ?? String(s.lastActivity),
    }));

    // Also load Claude sessions from the registry
    let allSessions = formattedPiSessions;
    try {
      const claudeEntries = await this.claudeService.listSessions();
      const formattedClaudeSessions = claudeEntries.map(entry => ({
        id: entry.id,
        path: entry.id,  // For Claude sessions, path == id
        sdkType: 'claude' as const,
        firstMessage: entry.firstMessage || '',
        messageCount: entry.messageCount || 0,
        cwd: entry.cwd || '',
        name: undefined,
        createdAt: entry.createdAt || new Date().toISOString(),
        lastActivity: entry.lastActivity || new Date().toISOString(),
      }));
      allSessions = [...formattedPiSessions, ...formattedClaudeSessions];
    } catch (e) {
      console.warn('[handleGetSessions] Failed to load Claude sessions:', e instanceof Error ? e.message : String(e));
    }

    try {
      const opencodeEntries = await this.opencodeService.listSessions();
      const formattedOpencodeSessions = opencodeEntries.map(entry => ({
        id: entry.id,
        path: entry.id,
        sdkType: 'opencode' as const,
        firstMessage: entry.firstMessage || '',
        messageCount: entry.messageCount || 0,
        cwd: entry.cwd || '',
        name: undefined,
        createdAt: entry.createdAt || new Date().toISOString(),
        lastActivity: entry.lastActivity || new Date().toISOString(),
      }));
      allSessions = [...allSessions, ...formattedOpencodeSessions];
    } catch (e) {
      console.warn('[handleGetSessions] Failed to load OpenCode sessions:', e instanceof Error ? e.message : String(e));
    }

    this.sendMessage(clientId, {
      type: 'sessions_list',
      sessions: allSessions,
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
    const sessionPath = this.getCurrentSessionPath(clientId);
    if (!sessionPath) {
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Claude Direct session info
    if (this.claudeSessionIds.has(sessionPath)) {
      try {
        const claudeStats = await this.claudeService.getSessionStats(sessionPath);
        if (!claudeStats) {
          this.sendMessage(clientId, { type: 'error', message: 'Claude session not found', code: 'SESSION_NOT_FOUND' });
          return;
        }
        this.sendMessage(clientId, {
          type: 'session_info',
          stats: {
            sessionFile: undefined,
            sessionId: claudeStats.sessionId,
            cwd: claudeStats.cwd,
            userMessages: claudeStats.userMessages,
            assistantMessages: claudeStats.assistantMessages,
            toolCalls: claudeStats.toolCalls,
            toolResults: claudeStats.toolResults,
            totalMessages: claudeStats.totalMessages,
            tokens: claudeStats.tokens,
            cost: claudeStats.cost,
            model: claudeStats.model,
            contextWindow: undefined,
            contextUsed: undefined,
            contextPercent: undefined,
          },
        });
      } catch (error) {
        this.sendMessage(clientId, { type: 'error', message: error instanceof Error ? error.message : 'Failed to get Claude session info', code: 'INTERNAL_ERROR' });
      }
      return;
    }

    // OpenCode Direct session info
    if (this.opencodeSessionIds.has(sessionPath)) {
      try {
        const ocStats = await this.opencodeService.getSessionStats(sessionPath);
        if (!ocStats) {
          this.sendMessage(clientId, { type: 'error', message: 'OpenCode session not found', code: 'SESSION_NOT_FOUND' });
          return;
        }
        const ocContextUsage = this.opencodeService.getContextUsage(sessionPath);
        this.sendMessage(clientId, {
          type: 'session_info',
          stats: {
            sessionFile: undefined,
            sessionId: ocStats.sessionId,
            cwd: ocStats.cwd,
            userMessages: ocStats.userMessages,
            assistantMessages: ocStats.assistantMessages,
            toolCalls: ocStats.toolCalls,
            toolResults: ocStats.toolResults,
            totalMessages: ocStats.totalMessages,
            tokens: ocStats.tokens,
            cost: ocStats.cost,
            model: ocStats.model,
            contextWindow: ocContextUsage?.contextWindow ?? undefined,
            contextUsed: ocContextUsage?.tokens ?? undefined,
            contextPercent: ocContextUsage?.percent ?? undefined,
          },
        });
      } catch (error) {
        this.sendMessage(clientId, { type: 'error', message: error instanceof Error ? error.message : 'Failed to get OpenCode session info', code: 'INTERNAL_ERROR' });
      }
      return;
    }

    // Pi SDK session info (original path)
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
    const sessionPath = this.getCurrentSessionPath(clientId);
    if (!sessionPath) {
      console.error(`[handleSetModel] No active session for client ${clientId}`);
      this.sendMessage(clientId, { type: 'error', message: 'No active session', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Handle Claude session model change
    if (this.claudeSessionIds.has(sessionPath)) {
      try {
        const normalizedModel = await this.claudeService.setModel(sessionPath, message.modelId);
        this.sendMessage(clientId, { type: 'model_changed', modelId: normalizedModel });
      } catch (error) {
        this.sendMessage(clientId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to change model',
          code: 'MODEL_CHANGE_FAILED',
        });
      }
      return;
    }

    if (this.opencodeSessionIds.has(sessionPath)) {
      try {
        const normalizedModel = await this.opencodeService.setModel(sessionPath, message.modelId);
        this.sendMessage(clientId, { type: 'model_changed', modelId: normalizedModel });
      } catch (error) {
        this.sendMessage(clientId, {
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to change model',
          code: 'MODEL_CHANGE_FAILED',
        });
      }
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
    const sessionPath = this.getCurrentSessionPath(clientId);
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
    const { id, approved, cancelled } = message.response;

    if (this.pendingClaudePermissions.has(id)) {
      const sessionId = this.pendingClaudePermissions.get(id)!;
      this.pendingClaudePermissions.delete(id);
      this.claudeService.sendPermissionResponse(
        sessionId,
        id,
        approved === true && cancelled !== true,
      );
      return;
    }

    if (this.opencodeService.isPendingPermission(id)) {
      const isApproved = approved === true && cancelled !== true;
      try {
        await this.opencodeService.resolvePermission(id, isApproved);
      } catch (e) {
        console.error('[handleExtensionUiResponse] OpenCode permission reply failed:', e);
      }
      return;
    }

    // Otherwise fall through to Pi extension UI handler
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
    const sessionPath = message.sessionPath;

    // Check if this is a Claude session
    let isClaudeSession = this.claudeSessionIds.has(sessionPath);
    if (!isClaudeSession) {
      try {
        const registry = getSessionRegistry();
        const entry = await registry.get(sessionPath).catch(() => undefined);
        if (entry?.sdkType === 'claude') {
          isClaudeSession = true;
          this.claudeSessionIds.add(sessionPath);
        }
      } catch {
        // Ignore registry lookup errors
      }
    }

    if (isClaudeSession) {
      this.clientViewingSession.set(clientId, sessionPath);
      this.claudeSubs.subscribe(clientId, sessionPath);
      await this.replayClaudeHistory(clientId, sessionPath);
      return;
    }

    try {
      const status = await this.multiSessionManager.subscribeClient(clientId, sessionPath, undefined, this.getWebUIContext(clientId));

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

  private async handlePinSession(
    clientId: string,
    message: { type: 'pin_session'; sessionPath: string }
  ): Promise<void> {
    if (this.opencodeSessionIds.has(message.sessionPath)) {
      const success = await this.opencodeService.pinSession(message.sessionPath);
      if (success) {
        this.sendMessage(clientId, {
          type: 'session_pinned',
          sessionPath: message.sessionPath,
          pinned: true,
        });
      } else {
        const hasSession = this.opencodeService.hasSession(message.sessionPath);
        this.sendMessage(clientId, {
          type: 'session_pin_error',
          sessionPath: message.sessionPath,
          error: hasSession ? 'Maximum pinned sessions limit reached' : 'Session not found',
        });
      }
      return;
    }

    if (this.claudeSessionIds.has(message.sessionPath)) {
      const success = this.claudeService.pinSession(message.sessionPath);
      if (success) {
        this.sendMessage(clientId, {
          type: 'session_pinned',
          sessionPath: message.sessionPath,
          pinned: true,
        });
      } else {
        const hasSession = this.claudeService.hasSession(message.sessionPath);
        this.sendMessage(clientId, {
          type: 'session_pin_error',
          sessionPath: message.sessionPath,
          error: hasSession ? 'Maximum pinned sessions limit reached' : 'Session not found',
        });
      }
      return;
    }

    const success = this.multiSessionManager.pinSession(message.sessionPath);
    if (success) {
      this.sendMessage(clientId, {
        type: 'session_pinned',
        sessionPath: message.sessionPath,
        pinned: true,
      });
    } else {
      const hasSession = this.multiSessionManager.hasSession(message.sessionPath);
      this.sendMessage(clientId, {
        type: 'session_pin_error',
        sessionPath: message.sessionPath,
        error: hasSession ? 'Maximum pinned sessions limit reached' : 'Session not found',
      });
    }
  }

  private handleUnpinSession(
    clientId: string,
    message: { type: 'unpin_session'; sessionPath: string }
  ): void {
    if (this.opencodeSessionIds.has(message.sessionPath)) {
      this.opencodeService.unpinSession(message.sessionPath);
      this.sendMessage(clientId, {
        type: 'session_pinned',
        sessionPath: message.sessionPath,
        pinned: false,
      });
      return;
    }

    if (this.claudeSessionIds.has(message.sessionPath)) {
      this.claudeService.unpinSession(message.sessionPath);
      this.sendMessage(clientId, {
        type: 'session_pinned',
        sessionPath: message.sessionPath,
        pinned: false,
      });
      return;
    }

    const success = this.multiSessionManager.unpinSession(message.sessionPath);
    this.sendMessage(clientId, {
      type: 'session_pinned',
      sessionPath: message.sessionPath,
      pinned: false,
    });
    if (!success) {
      console.log(`[Connection] Unpin requested for inactive session ${message.sessionPath} — confirmed to client anyway`);
    }
  }

  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      // Unsubscribe client from all sessions via MultiSessionManager
      const subscriptions = this.multiSessionManager.getClientSubscriptions(clientId);
      for (const sessionPath of subscriptions) {
        this.multiSessionManager.unsubscribeClient(clientId, sessionPath);
      }

      // Unsubscribe client from all Claude sessions
      this.claudeSubs.unsubscribeAll(clientId);
      this.opencodeSubs.unsubscribeAll(clientId);

      // Clean up client tracking data
      this.clientCwd.delete(clientId);
      this.clientViewingSession.delete(clientId);
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
  private getWebUIContextForMultiSession(sessionPath: string): { clientId: string; sendToClient: (message: unknown) => void; sessionPath: string } | undefined {
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
      clientId: firstSubscriber,
      sessionPath,
      sendToClient: (message: unknown) => {
        const payload =
          message && typeof message === 'object' && !Array.isArray(message) && !(message as { sessionId?: unknown }).sessionId
            ? { ...(message as Record<string, unknown>), sessionId: activeSession.sessionId }
            : message;
        // Broadcast to all subscribers of this session
        this.multiSessionManager.broadcastToSubscribers(sessionPath, payload);
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
   * Get the WebSocket server instance
   */
  getWss(): WebSocketServer {
    return this.wss;
  }

  /**
   * Get the MultiSessionManager instance
   */
  getMultiSessionManager(): MultiSessionManager {
    return this.multiSessionManager;
  }

  getClaudeService(): ClaudeService {
    return this.claudeService;
  }

  getOpenCodeService(): OpenCodeService {
    return this.opencodeService;
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

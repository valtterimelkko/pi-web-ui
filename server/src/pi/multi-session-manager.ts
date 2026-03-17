import type { PiService } from './pi-service.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

/**
 * WebUIContext for extension binding
 */
export interface WebUIContext {
  /** Function to send events to the Web UI */
  sendEvent: (event: any) => void;
  /** Session path this context belongs to */
  sessionPath: string;
  /** Extension registry for accessing registered extensions */
  extensionRegistry?: any;
}

/**
 * Session status types
 */
export type SessionStatus = 'idle' | 'busy' | 'streaming' | 'error';

/**
 * Internal representation of an active session
 */
export interface ActiveSession {
  sessionPath: string;
  sessionId: string;
  agentSession: AgentSession;
  status: SessionStatus;
  subscribers: Set<string>;
  lastActivity: Date;
  messageCount: number;
  currentStep: number;
  webUIContext?: WebUIContext;
}

/**
 * Public session status information
 */
export interface SessionStatusInfo {
  sessionPath: string;
  sessionId: string;
  status: SessionStatus;
  lastActivity: Date;
  messageCount: number;
  currentStep: number;
  subscriberCount: number;
}

/**
 * Options for MultiSessionManager
 */
export interface MultiSessionManagerOptions {
  cleanupIntervalMs?: number;
  sessionTimeoutMs?: number;
}

/**
 * Type for the broadcast function
 */
export type BroadcastFunction = (clientId: string, message: any) => void;

/**
 * Type for the WebUI context provider function
 */
export type WebUIContextProvider = (sessionPath: string) => WebUIContext | undefined;

/**
 * MultiSessionManager manages multiple sessions that can be shared across clients.
 * 
 * - Sessions are identified by their sessionPath (file path)
 * - Multiple clients can subscribe to the same session
 * - Events are broadcast to all subscribers
 * - Inactive sessions (no subscribers, idle) are cleaned up periodically
 */
export class MultiSessionManager {
  private piService: PiService;
  private broadcast: BroadcastFunction;
  private sessions: Map<string, ActiveSession> = new Map(); // sessionPath -> ActiveSession
  private clientSubscriptions: Map<string, Set<string>> = new Map(); // clientId -> Set<sessionPath>
  private clientViewingSession: Map<string, string> = new Map(); // clientId -> sessionPath
  private cleanupIntervalMs: number;
  private sessionTimeoutMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private webUIContextProvider?: WebUIContextProvider;

  constructor(
    piService: PiService,
    broadcast: BroadcastFunction,
    options: MultiSessionManagerOptions = {}
  ) {
    this.piService = piService;
    this.broadcast = broadcast;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 1000; // Default: 1 minute
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 30 * 60 * 1000; // Default: 30 minutes
  }

  /**
   * Subscribe a client to a session. Creates the session if it doesn't exist.
   */
  async subscribeClient(
    clientId: string,
    sessionPath: string,
    webUIContext?: WebUIContext
  ): Promise<SessionStatusInfo> {
    // Validate inputs
    if (!sessionPath || sessionPath.trim() === '') {
      throw new Error('Invalid session path');
    }
    if (!clientId || clientId.trim() === '') {
      throw new Error('Invalid client ID');
    }

    let activeSession = this.sessions.get(sessionPath);

    if (!activeSession) {
      // Create new session
      console.log(`[MultiSessionManager] Creating new session for path: ${sessionPath}`);

      const agentSession = await this.piService.createSession({
        clientId: `multi-${sessionPath}`,
        sessionPath,
      });

      // Set up event handler for this session
      this.piService.setEventHandler(`multi-${sessionPath}`, (event) => {
        this.handleAgentEvent(sessionPath, event);
      });

      activeSession = {
        sessionPath,
        sessionId: agentSession.sessionId,
        agentSession,
        status: 'idle',
        subscribers: new Set(),
        lastActivity: new Date(),
        messageCount: 0,
        currentStep: 0,
        webUIContext,
      };

      this.sessions.set(sessionPath, activeSession);
    } else if (webUIContext) {
      // Update webUIContext if provided for existing session
      activeSession.webUIContext = webUIContext;
    }

    // Add client to subscribers
    activeSession.subscribers.add(clientId);
    activeSession.lastActivity = new Date();

    // Track client subscription
    if (!this.clientSubscriptions.has(clientId)) {
      this.clientSubscriptions.set(clientId, new Set());
    }
    this.clientSubscriptions.get(clientId)!.add(sessionPath);

    return this.getSessionStatus(sessionPath)!;
  }

  /**
   * Unsubscribe a client from a session.
   * Sessions are kept alive if they have subscribers or are busy/streaming.
   */
  unsubscribeClient(clientId: string, sessionPath: string): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return; // Session doesn't exist, nothing to do
    }

    // Remove client from subscribers
    activeSession.subscribers.delete(clientId);

    // Remove from client subscriptions map
    const clientSubs = this.clientSubscriptions.get(clientId);
    if (clientSubs) {
      clientSubs.delete(sessionPath);
      if (clientSubs.size === 0) {
        this.clientSubscriptions.delete(clientId);
      }
    }

    // Note: We don't immediately dispose the session here.
    // Cleanup happens via cleanupInactiveSessions() which checks:
    // - No subscribers
    // - Status is idle (not busy/streaming)
    // - Past the timeout
  }

  /**
   * Broadcast a message to all subscribers of a session.
   */
  broadcastToSubscribers(sessionPath: string, message: any): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return; // No session, nothing to broadcast
    }

    for (const clientId of activeSession.subscribers) {
      try {
        this.broadcast(clientId, message);
      } catch (error) {
        console.warn(
          `[MultiSessionManager] Failed to broadcast to client ${clientId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }

  /**
   * Get the status of a session.
   */
  getSessionStatus(sessionPath: string): SessionStatusInfo | undefined {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return undefined;
    }

    return {
      sessionPath: activeSession.sessionPath,
      sessionId: activeSession.sessionId,
      status: activeSession.status,
      lastActivity: activeSession.lastActivity,
      messageCount: activeSession.messageCount,
      currentStep: activeSession.currentStep,
      subscriberCount: activeSession.subscribers.size,
    };
  }

  /**
   * Get status of all active sessions.
   */
  getAllSessionStatuses(): SessionStatusInfo[] {
    const statuses: SessionStatusInfo[] = [];
    for (const sessionPath of this.sessions.keys()) {
      const status = this.getSessionStatus(sessionPath);
      if (status) {
        statuses.push(status);
      }
    }
    return statuses;
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionPath: string): boolean {
    return this.sessions.has(sessionPath);
  }

  /**
   * Update the status of a session.
   */
  updateSessionStatus(sessionPath: string, status: SessionStatus): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return; // Session doesn't exist
    }
    activeSession.status = status;
    activeSession.lastActivity = new Date();
  }

  /**
   * Increment the message count for a session.
   */
  incrementMessageCount(sessionPath: string): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return;
    }
    activeSession.messageCount++;
    activeSession.lastActivity = new Date();
  }

  /**
   * Update the current step for a session.
   */
  updateCurrentStep(sessionPath: string, step: number): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return;
    }
    activeSession.currentStep = step;
    activeSession.lastActivity = new Date();
  }

  /**
   * Handle an agent event for a session.
   * Wraps the event in a session_event envelope with sessionId for proper routing.
   */
  handleAgentEvent(sessionPath: string, event: any): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return;
    }

    // Update last activity
    activeSession.lastActivity = new Date();

    // Handle specific event types
    switch (event.type) {
      case 'agent_start':
        activeSession.status = 'streaming';
        break;

      case 'agent_end':
        activeSession.status = 'idle';
        break;

      case 'message_start':
        activeSession.messageCount++;
        break;

      case 'step':
        if (typeof event.step === 'number') {
          activeSession.currentStep = event.step;
        }
        break;

      case 'error':
        activeSession.status = 'error';
        break;
    }

    // Wrap the event in a session_event envelope with sessionId for proper client routing
    const sessionEvent = {
      type: 'session_event',
      sessionId: activeSession.sessionId,
      sessionPath: activeSession.sessionPath,
      event: event,
    };

    // Broadcast the wrapped event to all subscribers
    this.broadcastToSubscribers(sessionPath, sessionEvent);
  }

  /**
   * Get all session paths a client is subscribed to.
   */
  getClientSubscriptions(clientId: string): string[] {
    const subs = this.clientSubscriptions.get(clientId);
    return subs ? Array.from(subs) : [];
  }

  /**
   * Get the agent session for a path.
   * Returns undefined if the session doesn't exist.
   */
  getSession(sessionPath: string): AgentSession | undefined {
    const activeSession = this.sessions.get(sessionPath);
    return activeSession?.agentSession;
  }

  /**
   * Get the session path a client is currently viewing.
   * Returns undefined if the client is not viewing any session.
   */
  getClientSessionPath(clientId: string): string | undefined {
    return this.clientViewingSession.get(clientId);
  }

  /**
   * Track which session a client is currently viewing.
   * The client must already be subscribed to the session.
   */
  setClientViewingSession(clientId: string, sessionPath: string): void {
    // Validate that the client is subscribed to this session
    const clientSubs = this.clientSubscriptions.get(clientId);
    if (!clientSubs || !clientSubs.has(sessionPath)) {
      throw new Error(
        `Client ${clientId} is not subscribed to session ${sessionPath}`
      );
    }

    this.clientViewingSession.set(clientId, sessionPath);
  }

  /**
   * Get the agent session for direct access.
   * Alias for getSession() for clarity when accessing the underlying AgentSession.
   */
  getAgentSession(sessionPath: string): AgentSession | undefined {
    return this.getSession(sessionPath);
  }

  /**
   * Get the WebUIContext for a session.
   * Returns undefined if the session doesn't exist or has no WebUIContext.
   */
  getWebUIContext(sessionPath: string): WebUIContext | undefined {
    const activeSession = this.sessions.get(sessionPath);
    return activeSession?.webUIContext;
  }

  /**
   * Set the WebUIContext for a session.
   * This allows updating the context for extension binding after session creation.
   */
  setWebUIContext(sessionPath: string, context: WebUIContext): void {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      throw new Error(`Session ${sessionPath} does not exist`);
    }
    activeSession.webUIContext = context;
  }

  /**
   * Set a provider function that returns WebUIContext for a session path.
   * This is used by the WebSocket connection manager to provide contexts dynamically.
   */
  setWebUIContextProvider(provider: WebUIContextProvider): void {
    this.webUIContextProvider = provider;
  }

  /**
   * Get WebUIContext for a session path using the registered provider.
   * Returns undefined if no provider is set or the provider returns undefined.
   */
  getWebUIContextFromProvider(sessionPath: string): WebUIContext | undefined {
    return this.webUIContextProvider?.(sessionPath);
  }

  /**
   * Get the active session info for a path.
   * Returns the internal ActiveSession object for advanced use cases.
   */
  getActiveSession(sessionPath: string): ActiveSession | undefined {
    return this.sessions.get(sessionPath);
  }

  /**
   * Send a prompt to a session.
   * Requires the underlying AgentSession to have a prompt method.
   */
  async prompt(sessionPath: string, message: string): Promise<void> {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      throw new Error(`Session ${sessionPath} does not exist`);
    }

    // Update status to busy while processing
    activeSession.status = 'busy';
    activeSession.lastActivity = new Date();

    try {
      // The AgentSession should have a prompt method
      await activeSession.agentSession.prompt(message);
    } catch (error) {
      activeSession.status = 'error';
      throw error;
    }
  }

  /**
   * Steer/abort the current operation in a session.
   * Requires the underlying AgentSession to have a steer method.
   */
  async steer(sessionPath: string, message: string): Promise<void> {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      throw new Error(`Session ${sessionPath} does not exist`);
    }

    activeSession.lastActivity = new Date();

    try {
      // The AgentSession should have a steer method
      await activeSession.agentSession.steer(message);
    } catch (error) {
      console.error(`[MultiSessionManager] Error steering session ${sessionPath}:`, error);
      throw error;
    }
  }

  /**
   * Abort the current operation in a session.
   * Requires the underlying AgentSession to have an abort method.
   */
  async abort(sessionPath: string): Promise<void> {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      throw new Error(`Session ${sessionPath} does not exist`);
    }

    activeSession.lastActivity = new Date();

    try {
      // The AgentSession should have an abort method
      await activeSession.agentSession.abort();
      activeSession.status = 'idle';
    } catch (error) {
      console.error(`[MultiSessionManager] Error aborting session ${sessionPath}:`, error);
      throw error;
    }
  }

  /**
   * Clean up inactive sessions.
   * Returns the number of sessions cleaned up.
   */
  cleanupInactiveSessions(maxAge: number = this.sessionTimeoutMs): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [sessionPath, activeSession] of this.sessions.entries()) {
      // Skip sessions with subscribers
      if (activeSession.subscribers.size > 0) {
        continue;
      }

      // Skip sessions that are busy or streaming
      if (activeSession.status === 'busy' || activeSession.status === 'streaming') {
        continue;
      }

      // Check if session is old enough
      const age = now - activeSession.lastActivity.getTime();
      if (age >= maxAge) {
        console.log(
          '[MultiSessionManager]',
          `Cleaning up inactive session: ${sessionPath}`
        );

        // Dispose the agent session
        try {
          activeSession.agentSession.dispose();
        } catch (error) {
          console.error(
            `[MultiSessionManager] Error disposing session ${sessionPath}:`,
            error
          );
        }

        // Remove event handler
        this.piService.removeEventHandler(`multi-${sessionPath}`);

        // Remove from sessions map
        this.sessions.delete(sessionPath);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  /**
   * Dispose all sessions and clear internal state.
   */
  dispose(): void {
    // Clear cleanup timer if running
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // Dispose all sessions
    for (const [sessionPath, activeSession] of this.sessions.entries()) {
      try {
        activeSession.agentSession.dispose();
        this.piService.removeEventHandler(`multi-${sessionPath}`);
      } catch (error) {
        console.error(
          `[MultiSessionManager] Error disposing session ${sessionPath}:`,
          error
        );
      }
    }

    // Clear all maps
    this.sessions.clear();
    this.clientSubscriptions.clear();
    this.clientViewingSession.clear();
  }
}

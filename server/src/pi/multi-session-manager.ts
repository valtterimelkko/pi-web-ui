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
  // Note: cleanupIntervalMs and sessionTimeoutMs are deprecated.
  // Sessions now persist indefinitely until explicitly stopped or the server shuts down.
  // This ensures background processing continues even when clients disconnect.
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
  private webUIContextProvider?: WebUIContextProvider;

  constructor(
    piService: PiService,
    broadcast: BroadcastFunction,
    _options: MultiSessionManagerOptions = {}
  ) {
    this.piService = piService;
    this.broadcast = broadcast;
    // Note: No automatic cleanup timer. Sessions persist indefinitely until:
    // 1. User explicitly stops them (abort button)
    // 2. Server shuts down
    // This ensures background processing continues even when clients disconnect.
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
   * Check if an event contains skill content and extract info for transformation.
   */
  private getSkillContentInfo(event: any): { isSkillContent: boolean; skillName?: string } {
    if (event.type !== 'message_start' || !event.message) return { isSkillContent: false };
    
    const content = event.message.content;
    if (!Array.isArray(content)) return { isSkillContent: false };
    
    const contentText = content.map((c: {text?: string}) => c.text || '').join('');
    
    // Check for skill content injection markers - require BOTH opening AND closing tags
    const hasSkillOpenTag = contentText.includes('<skill name="');
    const hasSkillCloseTag = contentText.includes('</skill>');
    const hasFullSkillStructure = hasSkillOpenTag && hasSkillCloseTag;
    
    // Also check for specific skill content patterns
    const hasLectureHeader = contentText.startsWith('# Lecture Website Builder');
    const hasSkillHeader = contentText.startsWith('# Skill:');
    const hasSkillStructure = contentText.includes('### Skill Purpose') && contentText.includes('### Workflow');
    
    if (hasFullSkillStructure || hasLectureHeader || hasSkillHeader || hasSkillStructure) {
      // Extract skill name
      const skillNameMatch = contentText.match(/<skill name="([^"]+)"/);
      const skillName = skillNameMatch ? skillNameMatch[1] : undefined;
      return { isSkillContent: true, skillName };
    }
    
    return { isSkillContent: false };
  }

  /**
   * Transform skill content event to brief placeholder
   */
  private transformSkillContentEvent(event: any, skillName?: string): any {
    const placeholder = skillName 
      ? `📚 **Skill loaded: ${skillName}**`
      : '📚 **Skill loaded**';
    
    return {
      ...event,
      message: {
        ...event.message,
        content: [{ type: 'text', text: placeholder }]
      }
    };
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

    // Transform skill content messages
    const skillInfo = this.getSkillContentInfo(event);
    if (skillInfo.isSkillContent) {
      console.log(`[MultiSessionManager] Transforming skill content event for session: ${sessionPath}, skill: ${skillInfo.skillName || 'unknown'}`);
      event = this.transformSkillContentEvent(event, skillInfo.skillName);
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
   * Clean up sessions that are in error state with no subscribers.
   * Note: Sessions in idle/busy/streaming states are NOT cleaned up automatically.
   * They persist until explicitly stopped via stopSession() or server shutdown.
   * This ensures background processing continues even when clients disconnect.
   * Returns the number of sessions cleaned up.
   */
  cleanupInactiveSessions(): number {
    let cleanedCount = 0;

    for (const [sessionPath, activeSession] of this.sessions.entries()) {
      // Only cleanup sessions in error state with no subscribers
      if (activeSession.subscribers.size > 0) {
        continue;
      }

      // Only cleanup sessions that have errored
      if (activeSession.status !== 'error') {
        continue;
      }

      console.log(
        '[MultiSessionManager]',
        `Cleaning up errored session with no subscribers: ${sessionPath}`
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

    return cleanedCount;
  }

  /**
   * Explicitly stop and dispose a session.
   * This is called when a user clicks the stop button.
   * Returns true if the session was stopped, false if it didn't exist.
   */
  stopSession(sessionPath: string): boolean {
    const activeSession = this.sessions.get(sessionPath);
    if (!activeSession) {
      return false;
    }

    console.log(
      '[MultiSessionManager]',
      `Stopping session: ${sessionPath}`
    );

    // Abort any ongoing operation
    try {
      activeSession.agentSession.abort();
    } catch (error) {
      console.error(
        `[MultiSessionManager] Error aborting session ${sessionPath}:`,
        error
      );
    }

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

    // Clear client viewing references
    for (const [clientId, viewingPath] of this.clientViewingSession.entries()) {
      if (viewingPath === sessionPath) {
        this.clientViewingSession.delete(clientId);
      }
    }

    // Remove from client subscriptions
    for (const [clientId, subscriptions] of this.clientSubscriptions.entries()) {
      if (subscriptions.has(sessionPath)) {
        subscriptions.delete(sessionPath);
        if (subscriptions.size === 0) {
          this.clientSubscriptions.delete(clientId);
        }
      }
    }

    return true;
  }

  /**
   * Dispose all sessions and clear internal state.
   * Called when the server shuts down.
   */
  dispose(): void {
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

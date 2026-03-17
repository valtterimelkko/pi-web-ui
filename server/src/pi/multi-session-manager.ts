import type { PiService } from './pi-service.js';

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
  agentSession: any; // AgentSession from pi-coding-agent
  status: SessionStatus;
  subscribers: Set<string>;
  lastActivity: Date;
  messageCount: number;
  currentStep: number;
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
  private cleanupIntervalMs: number;
  private sessionTimeoutMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

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
  async subscribeClient(clientId: string, sessionPath: string): Promise<SessionStatusInfo> {
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
      };

      this.sessions.set(sessionPath, activeSession);
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

    // Broadcast the event to all subscribers
    this.broadcastToSubscribers(sessionPath, event);
  }

  /**
   * Get all session paths a client is subscribed to.
   */
  getClientSubscriptions(clientId: string): string[] {
    const subs = this.clientSubscriptions.get(clientId);
    return subs ? Array.from(subs) : [];
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
  }
}

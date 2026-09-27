import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiService, CreateSessionOptions } from './pi-service.js';
import { readSessionCwd } from './session-cwd.js';
import type { WebUIContext } from './extension-ui-adapter.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('SessionPool');


export interface ClientSession {
  clientId: string;
  sessionId: string;
  session: AgentSession;
  cwd: string;
  createdAt: Date;
  lastActivity: Date;
}

export class SessionPool {
  private clientSessions: Map<string, ClientSession> = new Map();
  private piService: PiService;
  private getWebUIContext?: (clientId: string) => WebUIContext | undefined;
  private streamingClients: Set<string> = new Set(); // Track which clients have active streaming

  constructor(piService: PiService) {
    this.piService = piService;
    // Set session pool reference in PiService for extension command context
    this.piService.setSessionPool(this);
  }

  /**
   * Set a function to retrieve WebUIContext for clients
   */
  setWebUIContextProvider(getContext: (clientId: string) => WebUIContext | undefined): void {
    this.getWebUIContext = getContext;
  }

  async createClientSession(clientId: string, options: Omit<CreateSessionOptions, 'clientId'>): Promise<ClientSession> {
    // Check if client already has a session - dispose it and create a new one
    const existing = this.clientSessions.get(clientId);
    if (existing) {
      // Dispose the old session and release every PiService-owned reference for
      // it (B1 heap retainer 1): removing only the event handler left the
      // AgentSession in PiService.sessions forever.
      existing.session.dispose();
      this.piService.releaseSessionRefs(existing.clientId, existing.sessionId);
      this.clientSessions.delete(clientId);
    }

    // Get Web UI context for extension binding
    const webUIContext = this.getWebUIContext?.(clientId);
    logger.info(`[SessionPool] Creating new session for ${clientId}, cwd=${options.cwd || 'default'}`);
    
    const session = await this.piService.createSession({
      ...options,
      clientId,
      webUIContext,
    });

    const clientSession: ClientSession = {
      clientId,
      sessionId: session.sessionId,
      session,
      cwd: options.cwd || process.cwd(),
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    logger.info(`[SessionPool] Client session created: sessionId=${session.sessionId}, cwd=${clientSession.cwd}`);
    this.clientSessions.set(clientId, clientSession);
    return clientSession;
  }

  getClientSession(clientId: string): ClientSession | undefined {
    return this.clientSessions.get(clientId);
  }

  async switchClientSession(clientId: string, sessionPath: string): Promise<ClientSession> {
    const existing = this.clientSessions.get(clientId);
    
    // Dispose the current session and drop its pool entry BEFORE attempting the
    // replacement. If opening the target then fails, the pool must not keep (and
    // return) an AgentSession that has already been disposed and released
    // (reviewer finding 2).
    if (existing) {
      existing.session.dispose();
      this.piService.releaseSessionRefs(existing.clientId, existing.sessionId);
      this.clientSessions.delete(clientId);
    }
    
    // Get Web UI context for extension binding
    const webUIContext = this.getWebUIContext?.(clientId);
    
    // Create new session pointing to existing file
    const session = await this.piService.createSession({
      clientId,
      sessionPath,
      allowCreate: false,
      webUIContext,
    });

    // Resolve the proper cwd from the session file header (single-file read),
    // not a full SessionManager.listAll() scan. See server/src/pi/session-cwd.ts.
    let cwd = existing?.cwd || process.cwd();
    try {
      const resolved = await readSessionCwd(sessionPath);
      if (resolved) {
        cwd = resolved;
      }
    } catch {
      // Fallback to existing cwd
    }

    const clientSession: ClientSession = {
      clientId,
      sessionId: session.sessionId,
      session,
      cwd,
      createdAt: existing?.createdAt || new Date(),
      lastActivity: new Date(),
    };

    logger.info(`[SessionPool] Switched to session: sessionId=${session.sessionId}, cwd=${cwd}`);
    this.clientSessions.set(clientId, clientSession);
    return clientSession;
  }

  updateActivity(clientId: string): void {
    const clientSession = this.clientSessions.get(clientId);
    if (clientSession) {
      clientSession.lastActivity = new Date();
    }
  }

  removeClient(clientId: string): void {
    const clientSession = this.clientSessions.get(clientId);
    this.clientSessions.delete(clientId);
    if (!clientSession) {
      this.piService.releaseSessionRefs(clientId, '');
      return;
    }    // Dispose the session unless another client entry still shares it, then
    // release every PiService-owned reference for this exact identity.
    const shared = Array.from(this.clientSessions.values()).some(
      (other) => other.sessionId === clientSession.sessionId,
    );
    if (!shared) {
      try {
        clientSession.session.dispose();
      } catch (error) {
        logger.error(`[SessionPool] Error disposing session for ${clientId}:`, error);
      }
    }
    this.piService.releaseSessionRefs(clientSession.clientId, clientSession.sessionId);
  }

  getActiveClients(): string[] {
    return Array.from(this.clientSessions.keys());
  }

  getClientCount(): number {
    return this.clientSessions.size;
  }

  // Cleanup inactive sessions (older than timeout)
  cleanupInactive(timeoutMs: number = 30 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [clientId, clientSession] of this.clientSessions.entries()) {
      if (now - clientSession.lastActivity.getTime() > timeoutMs) {
        this.removeClient(clientId);
        cleaned++;
      }
    }

    return cleaned;
  }

  // Set up event forwarding for a client
  setEventForwarder(clientId: string, handler: (event: AgentSessionEvent) => void): void {
    this.piService.setEventHandler(clientId, handler);
  }

  /**
   * Mark a client as streaming (agent is actively processing)
   */
  setStreaming(clientId: string, isStreaming: boolean): void {
    if (isStreaming) {
      this.streamingClients.add(clientId);
    } else {
      this.streamingClients.delete(clientId);
    }
  }

  /**
   * Check if a client's session is currently streaming
   */
  isSessionStreaming(clientId: string): boolean {
    return this.streamingClients.has(clientId);
  }
}

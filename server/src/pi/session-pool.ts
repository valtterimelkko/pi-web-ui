import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { PiService, CreateSessionOptions } from './pi-service.js';
import type { WebUIContext } from './extension-ui-adapter.js';

export interface ClientSession {
  clientId: string;
  sessionId: string;
  session: AgentSession;
  createdAt: Date;
  lastActivity: Date;
}

export class SessionPool {
  private clientSessions: Map<string, ClientSession> = new Map();
  private piService: PiService;
  private getWebUIContext?: (clientId: string) => WebUIContext | undefined;

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
    // Check if client already has a session
    const existing = this.clientSessions.get(clientId);
    if (existing) {
      return existing;
    }

    // Get Web UI context for extension binding
    const webUIContext = this.getWebUIContext?.(clientId);
    
    const session = await this.piService.createSession({
      ...options,
      clientId,
      webUIContext,
    });

    const clientSession: ClientSession = {
      clientId,
      sessionId: session.sessionId,
      session,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.clientSessions.set(clientId, clientSession);
    return clientSession;
  }

  getClientSession(clientId: string): ClientSession | undefined {
    return this.clientSessions.get(clientId);
  }

  async switchClientSession(clientId: string, sessionPath: string): Promise<ClientSession> {
    const existing = this.clientSessions.get(clientId);
    
    // Create new session pointing to existing file
    const session = await this.piService.createSession({
      clientId,
      sessionPath,
    });

    const clientSession: ClientSession = {
      clientId,
      sessionId: session.sessionId,
      session,
      createdAt: existing?.createdAt || new Date(),
      lastActivity: new Date(),
    };

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
    this.clientSessions.delete(clientId);
    this.piService.removeEventHandler(clientId);
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
}

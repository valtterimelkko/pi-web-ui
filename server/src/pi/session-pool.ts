import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { PiService, CreateSessionOptions } from './pi-service.js';
import type { WebUIContext } from './extension-ui-adapter.js';

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
      // Dispose the old session
      existing.session.dispose();
      this.piService.removeEventHandler(clientId);
      this.clientSessions.delete(clientId);
    }

    // Get Web UI context for extension binding
    const webUIContext = this.getWebUIContext?.(clientId);
    console.log(`[SessionPool] Creating new session for ${clientId}, cwd=${options.cwd || 'default'}`);
    
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

    console.log(`[SessionPool] Client session created: sessionId=${session.sessionId}, cwd=${clientSession.cwd}`);
    this.clientSessions.set(clientId, clientSession);
    return clientSession;
  }

  getClientSession(clientId: string): ClientSession | undefined {
    return this.clientSessions.get(clientId);
  }

  async switchClientSession(clientId: string, sessionPath: string): Promise<ClientSession> {
    const existing = this.clientSessions.get(clientId);
    
    // Dispose existing session if any
    if (existing) {
      existing.session.dispose();
      this.piService.removeEventHandler(clientId);
    }
    
    // Get Web UI context for extension binding
    const webUIContext = this.getWebUIContext?.(clientId);
    
    // Create new session pointing to existing file
    const session = await this.piService.createSession({
      clientId,
      sessionPath,
      webUIContext,
    });

    // Use existing cwd or default
    const cwd = existing?.cwd || process.cwd();

    const clientSession: ClientSession = {
      clientId,
      sessionId: session.sessionId,
      session,
      cwd,
      createdAt: existing?.createdAt || new Date(),
      lastActivity: new Date(),
    };

    console.log(`[SessionPool] Switched to session: sessionId=${session.sessionId}, cwd=${cwd}`);
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

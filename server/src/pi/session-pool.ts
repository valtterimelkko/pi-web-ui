import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { PiService, CreateSessionOptions } from './pi-service.js';
import { readSessionCwd } from './session-cwd.js';
import type { WebUIContext } from './extension-ui-adapter.js';
import { emitSessionShutdown, SESSION_SHUTDOWN_TIMEOUT_MS, type SessionShutdownInit } from './session-shutdown.js';
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
  /** B5 correction 01: one in-flight teardown per pool session id — exactly one emission, whoever races. */
  private poolTeardowns = new Map<string, Promise<void>>();

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
      // B5 correction 01: the replacement is the pool's `newSession` — emit
      // `session_shutdown` reason `new` (bounded, exactly once) so extension
      // cleanup runs, then release every PiService-owned reference (B1 heap
      // retainer 1). The entry is dropped BEFORE the await so a concurrent
      // removeClient cannot re-enter; the destination file is not known yet
      // (the replacement is created after), so no targetSessionFile.
      this.clientSessions.delete(clientId);
      await this.teardownPoolSession(existing, { reason: 'new' });
      this.piService.releaseSessionRefs(existing.clientId, existing.sessionId);
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
    // (reviewer finding 2). B5 correction 01: the replacement is the pool's
    // `switchSession` — emit `session_shutdown` reason `resume` with the
    // destination file (bounded, exactly once) so the successor adopts
    // extension state exactly like a CLI switch.
    if (existing) {
      this.clientSessions.delete(clientId);
      await this.teardownPoolSession(existing, { reason: 'resume', targetSessionFile: sessionPath });
      this.piService.releaseSessionRefs(existing.clientId, existing.sessionId);
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

  async removeClient(clientId: string): Promise<void> {
    const clientSession = this.clientSessions.get(clientId);
    this.clientSessions.delete(clientId);
    if (!clientSession) {
      this.piService.releaseSessionRefs(clientId, '');
      return;
    }    // Dispose the session unless another client entry still shares it, then
    // release every PiService-owned reference for this exact identity.
    // B5 correction 01: the disposal emits one bounded `session_shutdown`
    // (reason `quit`) through the pool funnel first.
    const shared = Array.from(this.clientSessions.values()).some(
      (other) => other.sessionId === clientSession.sessionId,
    );
    if (!shared) {
      await this.teardownPoolSession(clientSession, { reason: 'quit' });
    }
    this.piService.releaseSessionRefs(clientSession.clientId, clientSession.sessionId);
  }

  getActiveClients(): string[] {
    return Array.from(this.clientSessions.keys());
  }

  getClientCount(): number {
    return this.clientSessions.size;
  }

  /**
   * B5 correction 01: the one pool teardown funnel. Emits one bounded
   * `session_shutdown` (CLI-mapped reason from the caller) through the SDK's
   * public extensionRunner BEFORE the AgentSession is disposed, deduped per
   * session id so concurrent replacements/removals emit exactly once. Errors
   * are caught inside the helper and here — a teardown never rejects.
   */
  private teardownPoolSession(existing: ClientSession, shutdown: SessionShutdownInit): Promise<void> {
    const inFlight = this.poolTeardowns.get(existing.sessionId);
    if (inFlight) return inFlight;
    const run = (async () => {
      await emitSessionShutdown(existing.session, shutdown, SESSION_SHUTDOWN_TIMEOUT_MS);
      try {
        existing.session.dispose();
      } catch (error) {
        logger.error(`[SessionPool] Error disposing session ${existing.sessionId}:`, error);
      }
    })().finally(() => {
      this.poolTeardowns.delete(existing.sessionId);
    });
    this.poolTeardowns.set(existing.sessionId, run);
    return run;
  }

  // Cleanup inactive sessions (older than timeout)
  async cleanupInactive(timeoutMs: number = 30 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [clientId, clientSession] of this.clientSessions.entries()) {
      if (now - clientSession.lastActivity.getTime() > timeoutMs) {
        await this.removeClient(clientId);
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

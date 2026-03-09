import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { config } from '../config.js';
import type { SessionInfo } from '@pi-web-ui/shared';

export interface CreateSessionOptions {
  clientId: string;
  cwd?: string;
  sessionPath?: string;
  continueRecent?: boolean;
  inMemory?: boolean;
}

export class PiService {
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private resourceLoader: DefaultResourceLoader;
  private sessions: Map<string, AgentSession> = new Map();
  private clientSessionMap: Map<string, string> = new Map(); // clientId -> sessionId
  private eventHandlers: Map<string, (event: AgentSessionEvent) => void> = new Map();

  constructor() {
    this.authStorage = AuthStorage.create(config.piAgentDir
      ? `${config.piAgentDir}/auth.json`
      : undefined);
    
    this.modelRegistry = new ModelRegistry(this.authStorage);
    this.resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: config.piAgentDir || undefined,
    });
  }

  async initialize(): Promise<void> {
    await this.resourceLoader.reload();
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    const cwd = options.cwd || process.cwd();
    
    // Create session manager based on options
    let sessionManager: SessionManager;
    
    if (options.inMemory) {
      sessionManager = SessionManager.inMemory();
    } else if (options.sessionPath) {
      sessionManager = SessionManager.open(options.sessionPath, config.sessionDir);
    } else if (options.continueRecent) {
      sessionManager = await SessionManager.continueRecent(cwd, config.sessionDir);
    } else {
      sessionManager = SessionManager.create(cwd, config.sessionDir);
    }

    const { session } = await createAgentSession({
      sessionManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      resourceLoader: this.resourceLoader,
      cwd,
    });

    // Store client-to-session mapping
    this.clientSessionMap.set(options.clientId, session.sessionId);

    // Subscribe to events and forward to handler
    session.subscribe((event) => {
      const handler = this.eventHandlers.get(options.clientId);
      if (handler) {
        handler(event);
      }
    });

    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByClientId(clientId: string): AgentSession | undefined {
    const sessionId = this.clientSessionMap.get(clientId);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  getSessionIdByClientId(clientId: string): string | undefined {
    return this.clientSessionMap.get(clientId);
  }

  setEventHandler(clientId: string, handler: (event: AgentSessionEvent) => void): void {
    this.eventHandlers.set(clientId, handler);
  }

  removeEventHandler(clientId: string): void {
    this.eventHandlers.delete(clientId);
  }

  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    const sessions = await SessionManager.list(cwd || process.cwd(), config.sessionDir);
    return sessions.map(s => ({
      id: s.id,
      path: s.path,
      firstMessage: s.firstMessage,
      messageCount: s.messageCount,
      cwd: s.cwd,
      name: s.name,
      parentSessionPath: s.parentSessionPath,
      createdAt: s.created,
      lastActivity: s.modified,
    }));
  }

  async listAllSessions(): Promise<SessionInfo[]> {
    const sessions = await SessionManager.listAll();
    return sessions.map(s => ({
      id: s.id,
      path: s.path,
      firstMessage: s.firstMessage,
      messageCount: s.messageCount,
      cwd: s.cwd,
      name: s.name,
      parentSessionPath: s.parentSessionPath,
      createdAt: s.created,
      lastActivity: s.modified,
    }));
  }

  async deleteSession(sessionPath: string): Promise<void> {
    const fs = await import('fs/promises');
    await fs.unlink(sessionPath);
  }

  async getAvailableModels() {
    return this.modelRegistry.getAvailable();
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    // Parse modelId format "provider/model-name"
    const [provider, ...modelParts] = modelId.split('/');
    const modelName = modelParts.join('/');
    
    if (!provider || !modelName) {
      throw new Error(`Invalid model ID format: ${modelId}. Expected "provider/model-name"`);
    }
    
    const model = this.modelRegistry.find(provider, modelName);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }
    
    await session.setModel(model);
  }

  removeClient(clientId: string): void {
    const sessionId = this.clientSessionMap.get(clientId);
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.dispose();
        this.sessions.delete(sessionId);
      }
      this.clientSessionMap.delete(clientId);
    }
    this.eventHandlers.delete(clientId);
  }

  async cleanup(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.clientSessionMap.clear();
    this.eventHandlers.clear();
  }
}

// Singleton instance
let piService: PiService | null = null;

export function getPiService(): PiService {
  if (!piService) {
    piService = new PiService();
  }
  return piService;
}

export async function initializePiService(): Promise<PiService> {
  const service = getPiService();
  await service.initialize();
  return service;
}

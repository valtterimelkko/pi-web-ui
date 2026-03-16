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
import { createWebUIContext, createCommandContextActions, type WebUIContext, type CommandActionContext } from './extension-ui-adapter.js';
import type { SessionPool } from './session-pool.js';

export interface CreateSessionOptions {
  clientId: string;
  cwd?: string;
  sessionPath?: string;
  continueRecent?: boolean;
  inMemory?: boolean;
  webUIContext?: WebUIContext;
}

export class PiService {
  private authStorage: AuthStorage;
  private modelRegistry: ModelRegistry;
  private resourceLoader: DefaultResourceLoader;
  private sessions: Map<string, AgentSession> = new Map();
  private clientSessionMap: Map<string, string> = new Map(); // clientId -> sessionId
  private eventHandlers: Map<string, (event: AgentSessionEvent) => void> = new Map();
  private sessionPool: SessionPool | null = null;
  private clientWebUIContexts: Map<string, WebUIContext> = new Map(); // clientId -> WebUIContext

  setSessionPool(sessionPool: SessionPool): void {
    this.sessionPool = sessionPool;
  }

  constructor() {
    this.authStorage = AuthStorage.create(config.piAgentDir
      ? `${config.piAgentDir}/auth.json`
      : undefined);
    
    this.modelRegistry = new ModelRegistry(this.authStorage);
    
    // Log any ModelRegistry errors (e.g., models.json issues)
    const modelError = this.modelRegistry.getError();
    if (modelError) {
      console.error('[PiService] ModelRegistry error:', modelError);
    }
    
    // Log loaded providers at startup
    const allModels = this.modelRegistry.getAll();
    const availableModels = this.modelRegistry.getAvailable();
    const allProviders = [...new Set(allModels.map(m => m.provider))];
    const availableProviders = [...new Set(availableModels.map(m => m.provider))];
    console.log('[PiService] All providers loaded:', allProviders.join(', '));
    console.log('[PiService] Available providers (with auth):', availableProviders.join(', '));
    
    this.resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: config.piAgentDir || undefined,
    });
  }

  async initialize(): Promise<void> {
    await this.resourceLoader.reload();
    
    // Log loaded extensions for debugging
    const extensions = this.resourceLoader.getExtensions();
    if (extensions.extensions.length > 0) {
      console.log('Loaded extensions:');
      extensions.extensions.forEach(ext => {
        console.log(`  - ${ext.path}`);
        if (ext.commands.size > 0) {
          console.log(`    Commands: ${Array.from(ext.commands.keys()).join(', ')}`);
        }
        if (ext.tools.size > 0) {
          console.log(`    Tools: ${Array.from(ext.tools.keys()).join(', ')}`);
        }
      });
    }
    if (extensions.errors.length > 0) {
      console.error('Extension loading errors:');
      extensions.errors.forEach(err => console.error(`  - ${err.path}: ${err.error}`));
    }
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

    // Bind extensions with Web UI context if provided
    if (options.webUIContext) {
      this.clientWebUIContexts.set(options.clientId, options.webUIContext);
      
      const uiContext = createWebUIContext(options.webUIContext);
      const commandContext = createCommandContextActions({
        clientId: options.clientId,
        sessionId: session.sessionId,
        piService: {
          removeClient: this.removeClient.bind(this),
          cleanup: this.cleanup.bind(this),
        },
        sessionPool: this.sessionPool || {
          createClientSession: async () => ({ sessionId: '', session: {} }),
          switchClientSession: async () => ({ sessionId: '', session: {} }),
          removeClient: () => {},
        },
        getSessionManager: () => session.sessionManager,
      });

      // Bind extensions asynchronously (don't block session creation)
      void session.bindExtensions({
        uiContext,
        commandContextActions: commandContext,
      }).catch((error) => {
        console.error('Failed to bind extensions:', error);
      });
    }

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
    const models = this.modelRegistry.getAvailable();
    
    // Log available providers for debugging
    const providers = [...new Set(models.map(m => m.provider))];
    console.log('[PiService] Available model providers:', providers.join(', '));
    console.log(`[PiService] Total models available: ${models.length}`);
    
    return models;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    console.log(`[PiService.setModel] Setting model for session ${sessionId} to ${modelId}`);
    
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[PiService.setModel] Session not found: ${sessionId}`);
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    console.log(`[PiService.setModel] Found session: ${session.sessionId}, file: ${session.sessionFile || 'N/A'}`);
    console.log(`[PiService.setModel] Current model before change: ${session.model ? `${session.model.provider}/${session.model.id}` : 'none'}`);
    
    // Parse modelId format "provider/model-name"
    const [provider, ...modelParts] = modelId.split('/');
    const modelName = modelParts.join('/');
    
    if (!provider || !modelName) {
      console.error(`[PiService.setModel] Invalid model ID format: ${modelId}`);
      throw new Error(`Invalid model ID format: ${modelId}. Expected "provider/model-name"`);
    }
    
    console.log(`[PiService.setModel] Looking up model: provider=${provider}, name=${modelName}`);
    
    const model = this.modelRegistry.find(provider, modelName);
    if (!model) {
      console.error(`[PiService.setModel] Model not found in registry: ${modelId}`);
      console.log(`[PiService.setModel] Available models will be logged on next getAvailableModels call`);
      throw new Error(`Model not found: ${modelId}`);
    }
    
    console.log(`[PiService.setModel] Found model in registry: ${JSON.stringify(model)}`);
    
    try {
      await session.setModel(model);
      console.log(`[PiService.setModel] session.setModel() completed successfully`);
      
      // Verification: read back the model to confirm it was set
      const verifiedModel = session.model;
      if (!verifiedModel) {
        console.error(`[PiService.setModel] Verification failed: session.model is null after setModel`);
        throw new Error('Model change verification failed: session.model is null after setModel');
      }
      
      const expectedModelId = model.id || modelName;
      if (verifiedModel.id !== expectedModelId || verifiedModel.provider !== provider) {
        console.error(`[PiService.setModel] Verification failed: expected ${provider}/${expectedModelId}, got ${verifiedModel.provider}/${verifiedModel.id}`);
        throw new Error(`Model change verification failed: expected ${provider}/${expectedModelId}, got ${verifiedModel.provider}/${verifiedModel.id}`);
      }
      
      console.log(`[PiService.setModel] Verification passed: model is now ${verifiedModel.provider}/${verifiedModel.id}`);
    } catch (error) {
      console.error(`[PiService.setModel] Error during session.setModel() or verification:`, error);
      throw error;
    }
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
    this.clientWebUIContexts.delete(clientId);
  }

  /**
   * Set the Web UI context for a client (used for extension binding)
   */
  setClientWebUIContext(clientId: string, webUIContext: WebUIContext): void {
    this.clientWebUIContexts.set(clientId, webUIContext);
  }

  /**
   * Get the Web UI context for a client
   */
  getClientWebUIContext(clientId: string): WebUIContext | undefined {
    return this.clientWebUIContexts.get(clientId);
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

import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import type { SessionInfo } from '@pi-web-ui/shared';
import { createWebUIContext, createCommandContextActions, type WebUIContext } from './extension-ui-adapter.js';
import type { SessionPool } from './session-pool.js';
import {
  fetchOpenRouterCatalogue,
  transformOpenRouterCatalogue,
  readOpenRouterCache,
  writeOpenRouterCache,
  openRouterModelIds,
  buildModelSnapshot,
  diffModelSnapshots,
  readSnapshot,
  writeSnapshot,
  OPENROUTER_PROVIDER,
  type OpenRouterProviderConfig,
  type SnapshotDiff,
} from './pi-openrouter-refresh.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('PiService');


/**
 * Force-write a freshly-created SessionManager's in-memory entries to disk and
 * mark the file as flushed so the SDK does not later try to re-create it.
 *
 * Background: the SDK's `SessionManager._persist()` uses `openSync(path, "wx")`
 * (exclusive create) on the first assistant-message write when its internal
 * `flushed` flag is false. Pi Web UI calls `_rewriteFile()` at session creation
 * to make the file exist immediately for other components (registry, replay,
 * debug tooling). `_rewriteFile()` writes the file but does NOT set
 * `flushed = true`, so the SDK's later `_persist()` sees `flushed === false`,
 * assumes the file does not exist yet, calls `openSync(path, "wx")`, and throws
 * `EEXIST` — which masks any real error from the agent run (the EEXIST is
 * thrown from inside `handleRunFailure`, swallowing the original cause).
 *
 * Setting `flushed = true` after `_rewriteFile()` matches the SDK's own
 * internal contract (see `setSessionFile()` / `branch()` in session-manager.js,
 * which set `flushed = true` whenever they call `_rewriteFile()` on a file that
 * already contains entries).
 *
 * This is defensive against an upstream SDK quirk; if the SDK ever exposes a
 * public `flush()` method or changes the `_persist()` write flag from `wx` to
 * `w`/`a`, this helper can be simplified or removed.
 */
function forceFlushSessionManager(sessionManager: SessionManager): void {
  // Cast through unknown to avoid TS collapsing the intersection: the SDK's
  // `flushed` is private, so `SessionManager & { flushed?: boolean }` reduces
  // to `never`. Going through `unknown` sidesteps the private-field clash.
  const sm = sessionManager as unknown as {
    _rewriteFile?: () => void;
    flushed?: boolean;
  };
  if (typeof sm._rewriteFile === 'function') {
    sm._rewriteFile();
  }
  if ('flushed' in sm) {
    sm.flushed = true;
  }
}

export interface CreateSessionOptions {
  clientId: string;
  cwd?: string;
  sessionPath?: string;
  continueRecent?: boolean;
  inMemory?: boolean;
  webUIContext?: WebUIContext;
}

export class PiService {
  private modelRuntime: ModelRuntime | null = null;
  private initialization: Promise<void> | null = null;
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
    this.resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: config.piAgentDir || `${process.cwd()}/.pi/agent`,
    });
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      // Coalesce concurrent first loads into one initializeOnce(). On failure,
      // clear the cached promise so a later call can retry — a transient
      // first-load failure (e.g. a malformed models.json read) must not
      // permanently poison the service with a cached rejection.
      this.initialization = this.initializeOnce().catch((err) => {
        this.initialization = null;
        throw err;
      });
    }
    await this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    const agentDir = config.piAgentDir || `${process.cwd()}/.pi/agent`;
    const modelRuntime = await ModelRuntime.create({
      authPath: `${agentDir}/auth.json`,
      modelsPath: `${agentDir}/models.json`,
    });
    this.modelRuntime = modelRuntime;

    // Keep the explicit service-environment override. ModelRuntime owns
    // credential resolution and deliberately keeps runtime keys in memory.
    const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
    if (deepseekApiKey) {
      await modelRuntime.setRuntimeApiKey('deepseek', deepseekApiKey);
    }

    const modelError = modelRuntime.getError();
    if (modelError) {
      logger.error('[PiService] ModelRuntime error:', modelError);
    }

    const allModels = modelRuntime.getModels();
    const availableModels = await modelRuntime.getAvailable();
    const allProviders = [...new Set(allModels.map(m => m.provider))];
    const availableProviders = [...new Set(availableModels.map(m => m.provider))];
    logger.info('[PiService] All providers loaded:', allProviders.join(', '));
    logger.info('[PiService] Available providers (with auth):', availableProviders.join(', '));

    await this.resourceLoader.reload();
    this.logExtensions(this.resourceLoader.getExtensions());

    // Surface the cached OpenRouter catalogue (if any) so models survive a
    // server restart without a network fetch. See refreshOpenRouterModels().
    await this.loadOpenRouterCache();
  }

  private getModelRuntime(): ModelRuntime {
    if (!this.modelRuntime) {
      throw new Error('PiService has not been initialized');
    }
    return this.modelRuntime;
  }

  private logExtensions(extensions: ReturnType<DefaultResourceLoader['getExtensions']>): void {
    if (extensions.extensions.length > 0) {
      logger.info('Loaded extensions:');
      extensions.extensions.forEach(ext => {
        logger.info(`  - ${ext.path}`);
        if (ext.commands.size > 0) {
          logger.info(`    Commands: ${Array.from(ext.commands.keys()).join(', ')}`);
        }
        if (ext.tools.size > 0) {
          logger.info(`    Tools: ${Array.from(ext.tools.keys()).join(', ')}`);
        }
      });
    }
    if (extensions.errors.length > 0) {
      logger.error('Extension loading errors:');
      extensions.errors.forEach(err => logger.error(`  - ${err.path}: ${err.error}`));
    }
  }

  private async createSessionResourceLoader(cwd: string): Promise<DefaultResourceLoader> {
    const agentDir = config.piAgentDir || `${process.cwd()}/.pi/agent`;
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload();
    this.logExtensions(loader.getExtensions());
    return loader;
  }

  async createSession(options: CreateSessionOptions): Promise<AgentSession> {
    await this.initialize();
    const modelRuntime = this.getModelRuntime();
    const cwd = options.cwd || process.cwd();
    
    // Create session manager based on options
    let sessionManager: SessionManager;
    
    if (options.inMemory) {
      sessionManager = SessionManager.inMemory();
    } else if (options.sessionPath) {
      // Check if the session file already exists
      const fs = await import('fs/promises');
      let fileExists = false;
      try {
        await fs.access(options.sessionPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      
      if (fileExists) {
        // File exists - open it normally
        sessionManager = SessionManager.open(options.sessionPath, config.sessionDir);
      } else {
        // File doesn't exist yet - create with cwd, then set the session file path
        // Note: setSessionFile() on non-existent file calls newSession() which writes
        // to an auto-generated path. We need to override the path and force write again.
        logger.info(`[PiService.createSession] Session file doesn't exist yet, creating with cwd: ${cwd}`);
        sessionManager = SessionManager.create(cwd, config.sessionDir);
        sessionManager.setSessionFile(options.sessionPath);
        // Force immediate write to disk using internal _rewriteFile()
        // (public flush() not yet available in published SDK)
        forceFlushSessionManager(sessionManager);
      }
    } else if (options.continueRecent) {
      sessionManager = await SessionManager.continueRecent(cwd, config.sessionDir);
    } else {
      sessionManager = SessionManager.create(cwd, config.sessionDir);
      // Force immediate write to disk so session file exists before anything else needs it
      // (SDK defers writing until first assistant message by default)
      forceFlushSessionManager(sessionManager);
    }

    const sessionResourceLoader = await this.createSessionResourceLoader(cwd);

    const { session } = await createAgentSession({
      sessionManager,
      modelRuntime,
      resourceLoader: sessionResourceLoader,
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

    // Always bind extensions before exposing the session. bindExtensions()
    // emits session_start, which extension lifecycle guards rely on even for
    // browserless/Internal API sessions that have no Web UI context.
    try {
      if (options.webUIContext) {
        // Make the identity available to extension UI callbacks before
        // session_start runs; interactive startup requests must not wait for
        // bindExtensions() itself to return.
        options.webUIContext.sessionId = session.sessionId;
        this.clientWebUIContexts.set(options.clientId, options.webUIContext);

        const uiContext = createWebUIContext(options.webUIContext);
        const commandContext = createCommandContextActions({
          clientId: options.clientId,
          sessionId: session.sessionId,
          piService: {
            removeClient: this.removeClient.bind(this),
            cleanup: this.cleanup.bind(this),
            reloadSession: this.reloadSession.bind(this),
          },
          sessionPool: this.sessionPool || {
            createClientSession: async () => ({ sessionId: '', session: {} }),
            switchClientSession: async () => ({ sessionId: '', session: {} }),
            removeClient: () => {},
          },
          waitForIdle: () => session.waitForIdle(),
        });

        await session.bindExtensions({
          uiContext,
          commandContextActions: commandContext,
          onError: (error) => {
            options.webUIContext?.sendToClient({
              type: 'extension_error',
              extensionPath: error.extensionPath,
              event: error.event,
              error: error.error,
            });
          },
        });
      } else {
        await session.bindExtensions({});
      }
    } catch (error) {
      // Do not erase a newer concurrent creation for the same client ID.
      if (this.clientSessionMap.get(options.clientId) === session.sessionId) {
        this.clientSessionMap.delete(options.clientId);
        this.clientWebUIContexts.delete(options.clientId);
        this.removeEventHandler(options.clientId);
      }
      session.dispose();
      throw error;
    }

    this.sessions.set(session.sessionId, session);
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  async reloadSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await session.reload();
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
      sdkType: 'pi' as const,
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
      sdkType: 'pi' as const,
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
    await this.initialize();
    const models = await this.getModelRuntime().getAvailable();

    // Log available providers for debugging
    const providers = [...new Set(models.map(m => m.provider))];
    logger.info('[PiService] Available model providers:', providers.join(', '));
    logger.info(`[PiService] Total models available: ${models.length}`);

    return models;
  }

  /**
   * Register an OpenRouter provider config into the live ModelRuntime so its
   * models appear in the picker and route via the Pi SDK's built-in OpenRouter
   * support (env-detected key + attribution headers). No literal secret is
   * stored: the config uses an env-reference resolved lazily by the SDK.
   */
  registerOpenRouterProvider(providerConfig: OpenRouterProviderConfig): void {
    this.getModelRuntime().registerProvider(OPENROUTER_PROVIDER, {
      name: 'OpenRouter',
      baseUrl: providerConfig.baseUrl,
      api: providerConfig.api,
      apiKey: providerConfig.apiKey,
      models: providerConfig.models,
    });
    logger.info(
      `[PiService] Registered OpenRouter provider: ${providerConfig.models.length} models`,
    );
  }

  /**
   * Load the cached OpenRouter catalogue (if any) and register it so the full
   * gateway model list survives a server restart without a network fetch.
   * Idempotent; a no-op when disabled, unauthenticated, or no cache exists.
   */
  async loadOpenRouterCache(): Promise<void> {
    if (!config.piOpenrouterModelsEnabled) return;
    const cached = await readOpenRouterCache(config.piOpenrouterModelsCachePath);
    if (!cached || cached.models.length === 0) return;
    if (!this.getModelRuntime().hasConfiguredAuth(OPENROUTER_PROVIDER)) {
      logger.info(
        '[PiService] OpenRouter catalogue cached but provider not authenticated (no key in auth.json or OPENROUTER_API_KEY); skipping registration',
      );
      return;
    }
    this.registerOpenRouterProvider(cached);
  }

  /**
   * Refresh the OpenRouter model catalogue: fetch the public /api/v1/models
   * endpoint, cache it, register it into the running registry, and report a
   * snapshot diff. This is the Pi-SDK analogue of OpenCodeService.refreshModels()
   * and drives the weekly automation. No secrets are read or written.
   *
   * Fails closed (throws) on fetch failure so the cache/snapshot are never
   * clobbered with an empty or garbled result.
   */
  async refreshOpenRouterModels(): Promise<{
    available: boolean;
    cacheWarmed: boolean;
    registered: boolean;
    recycled: boolean;
    recycleDeferred: boolean;
    runningSessions: number;
    providerCount: number;
    modelCount: number;
    diff: SnapshotDiff;
    snapshotPath: string;
    generatedAt: string;
  }> {
    if (!config.piOpenrouterModelsEnabled) {
      throw new Error(
        'OpenRouter model surfacing is disabled (PI_OPENROUTER_MODELS_ENABLED=false)',
      );
    }
    const snapshotPath = config.piOpenrouterModelsSnapshotPath;

    const resp = await fetchOpenRouterCatalogue();
    const providerConfig = transformOpenRouterCatalogue(resp);

    await writeOpenRouterCache(config.piOpenrouterModelsCachePath, providerConfig).catch((err) => {
      logger.error('[PiService] Failed to persist OpenRouter model cache:', err);
    });

    // Registration only matters when the provider is authenticated (key in
    // auth.json or OPENROUTER_API_KEY); otherwise the models are cached and
    // ready, and will appear once auth is configured.
    await this.initialize();
    const registered = this.getModelRuntime().hasConfiguredAuth(OPENROUTER_PROVIDER);
    if (registered) {
      this.registerOpenRouterProvider(providerConfig);
    } else {
      logger.info(
        '[PiService] OpenRouter catalogue cached but provider not authenticated (no key in auth.json or OPENROUTER_API_KEY); not registering',
      );
    }

    const snapshot = buildModelSnapshot(openRouterModelIds(providerConfig));
    const prev = await readSnapshot(snapshotPath);
    const diff = diffModelSnapshots(prev, snapshot);
    await writeSnapshot(snapshotPath, snapshot).catch((err) => {
      logger.error('[PiService] Failed to persist OpenRouter model snapshot:', err);
    });

    logger.info(
      `[PiService] OpenRouter refresh: ${providerConfig.models.length} models${
        diff.changed ? `, ${diff.addedModels.length} added / ${diff.removedModels.length} removed` : ', no change'
      }`,
    );

    return {
      available: true,
      cacheWarmed: true,
      registered,
      recycled: false,
      recycleDeferred: false,
      runningSessions: this.sessions.size,
      providerCount: 1,
      modelCount: providerConfig.models.length,
      diff,
      snapshotPath,
      generatedAt: snapshot.generatedAt,
    };
  }

  /**
   * Get loaded skills from the resource loader.
   * Returns skill names and descriptions for slash command auto-complete.
   */
  getSkills() {
    const { skills, diagnostics } = this.resourceLoader.getSkills();
    
    // Log any skill loading diagnostics
    if (diagnostics.length > 0) {
      diagnostics.forEach(d => {
        logger.info(`[PiService] Skill diagnostic: ${d.type} - ${d.message} (${d.path})`);
      });
    }
    
    return skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    }));
  }

  /**
   * Get loaded extension commands from the resource loader.
   * Returns command names and descriptions for slash command auto-complete.
   */
  getExtensionCommands() {
    const extensionsResult = this.resourceLoader.getExtensions();
    const commands: Array<{ name: string; description: string; extension: string }> = [];
    
    for (const ext of extensionsResult.extensions) {
      for (const [cmdName, cmd] of ext.commands) {
        commands.push({
          name: cmdName,
          description: cmd.description || '',
          extension: ext.path,
        });
      }
    }
    
    return commands;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.initialize();
    logger.info(`[PiService.setModel] Setting model for session ${sessionId} to ${modelId}`);
    
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.error(`[PiService.setModel] Session not found: ${sessionId}`);
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    logger.info(`[PiService.setModel] Found session: ${session.sessionId}, file: ${session.sessionFile || 'N/A'}`);
    logger.info(`[PiService.setModel] Current model before change: ${session.model ? `${session.model.provider}/${session.model.id}` : 'none'}`);
    
    // Parse modelId format "provider/model-name"
    const [provider, ...modelParts] = modelId.split('/');
    const modelName = modelParts.join('/');
    
    if (!provider || !modelName) {
      logger.error(`[PiService.setModel] Invalid model ID format: ${modelId}`);
      throw new Error(`Invalid model ID format: ${modelId}. Expected "provider/model-name"`);
    }
    
    logger.info(`[PiService.setModel] Looking up model: provider=${provider}, name=${modelName}`);
    
    const model = this.getModelRuntime().getModel(provider, modelName);
    if (!model) {
      logger.error(`[PiService.setModel] Model not found in runtime: ${modelId}`);
      logger.info(`[PiService.setModel] Available models will be logged on next getAvailableModels call`);
      throw new Error(`Model not found: ${modelId}`);
    }
    
    logger.info(`[PiService.setModel] Found model in registry: ${JSON.stringify(model)}`);
    
    try {
      await session.setModel(model);
      logger.info(`[PiService.setModel] session.setModel() completed successfully`);
      
      // Verification: read back the model to confirm it was set
      const verifiedModel = session.model;
      if (!verifiedModel) {
        logger.error(`[PiService.setModel] Verification failed: session.model is null after setModel`);
        throw new Error('Model change verification failed: session.model is null after setModel');
      }
      
      const expectedModelId = model.id || modelName;
      if (verifiedModel.id !== expectedModelId || verifiedModel.provider !== provider) {
        logger.error(`[PiService.setModel] Verification failed: expected ${provider}/${expectedModelId}, got ${verifiedModel.provider}/${verifiedModel.id}`);
        throw new Error(`Model change verification failed: expected ${provider}/${expectedModelId}, got ${verifiedModel.provider}/${verifiedModel.id}`);
      }
      
      logger.info(`[PiService.setModel] Verification passed: model is now ${verifiedModel.provider}/${verifiedModel.id}`);
    } catch (error) {
      logger.error(`[PiService.setModel] Error during session.setModel() or verification:`, error);
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

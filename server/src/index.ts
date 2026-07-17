import dotenv from 'dotenv';
import { createLogger } from './logging/logger.js';

const logger = createLogger('Server');

dotenv.config();

import { createServer } from 'http';
import path from 'path';
import { createApp } from './app.js';
import { config } from './config.js';
import { WebSocketConnectionManager } from './websocket/index.js';
import { handleWebSocketUpgrade } from './websocket/upgrade-handler.js';
import { initializePiService, startSessionWatcher, getPiService, type SessionChangeEvent, type SessionInfo } from './pi/index.js';
import { SessionCleanupService } from './session-cleanup.js';
import { getSessionRegistry } from './session-registry.js';
import { createFatalErrorHandlers } from './fatal-error-handlers.js';

// State used by createApp's lazy notification-router getters. Declared before
// createApp() (which runs at module load) so the getters close over initialized
// bindings; they are populated later in initialize() and resolved per request.
let wsManager: WebSocketConnectionManager | null = null;
let sessionCleanup: SessionCleanupService | null = null;
let internalApiServer: import('./internal-api/index.js').InternalApiServer | null = null;
let notificationsRegistry: ReturnType<typeof getSessionRegistry> | null = null;

const app = createApp({
  getManager: () => internalApiServer?.getNotificationManager() ?? null,
});
const server = createServer(app);

// Initialize Pi service and WebSocket manager
async function initialize(): Promise<void> {
  try {
    // Initialize Pi service first
    await initializePiService();
    logger.info('Pi service initialized');

    // Create WebSocket connection manager
    wsManager = new WebSocketConnectionManager();

    // Handle WebSocket upgrade requests. One central pre-upgrade guard
    // (origin + cookie-auth + upgrade rate-limit) is applied to every accepted
    // path inside handleWebSocketUpgrade, before any handleUpgrade.
    server.on('upgrade', (request, socket, head) => {
      handleWebSocketUpgrade(request, socket, head, {
        wsManager: wsManager!,
        verbose: process.env.NODE_ENV === 'development',
      });
    });

    // Initialize CLI session watcher
    const sessionWatcher = startSessionWatcher(config.sessionDir || path.join(config.piAgentDir, 'sessions'));
    
    sessionWatcher.on('session_update', (event: SessionChangeEvent & { info?: SessionInfo }) => {
      // Broadcast to all connected WebSocket clients
      wsManager!.broadcast({
        type: 'session_update',
        changeType: event.type,
        path: event.path,
        sessionId: event.sessionId,
        cwd: event.cwd,
        info: event.info ? {
          id: event.info.id,
          path: event.info.path,
          cwd: event.info.cwd,
          firstMessage: event.info.firstMessage,
          messageCount: event.info.messageCount,
          name: event.info.name,
          createdAt: event.info.createdAt.toISOString(),
          lastActivity: event.info.lastActivity.toISOString(),
        } : undefined,
      });
    });

    sessionWatcher.on('error', (error: Error) => {
      logger.error('SessionWatcher error:', error);
    });

    logger.info('WebSocket server ready at /ws');

    // Rebuild session registry from disk (ensures Pi sessions are indexed).
    // Skipped in validation mode so the disposable instance never reads the
    // real Pi session directory into its (isolated) registry.
    if (config.validationMode) {
      logger.info('[Validation] Ephemeral validation mode: skipping real-session registry rebuild.');
    } else {
      try {
        const registry = getSessionRegistry(config.sessionRegistryPath);
        const piSessionDir = config.sessionDir || path.join(config.piAgentDir, 'sessions');
        await registry.rebuildFromPiSessions(piSessionDir);
      } catch (err) {
        logger.warn('[Startup] Failed to rebuild session registry from Pi sessions:', err instanceof Error ? err.message : String(err));
      }
    }

    // Start session cleanup service (auto-unpin after 24h, auto-delete archived
    // after 90 days). DISABLED in validation mode — a disposable validation
    // instance must never delete real session data as a side effect of booting.
    if (config.validationMode) {
      logger.info('[Validation] Ephemeral validation mode: session cleanup disabled.');
    } else {
      sessionCleanup = new SessionCleanupService();
      sessionCleanup.bindRuntimes({
        multiSessionManager: wsManager.getMultiSessionManager(),
        claudeService: wsManager.getClaudeService(),
        opencodeService: wsManager.getOpenCodeService(),
        antigravityService: wsManager.getAntigravityService(),
      });
      sessionCleanup.start();
    }

    // Start internal API server (local backend API for other applications)
    if (config.internalApiEnabled) {
      try {
        const { InternalApiServer } = await import('./internal-api/index.js');
        notificationsRegistry = getSessionRegistry(config.sessionRegistryPath);
        internalApiServer = new InternalApiServer({
          config: {
            socketPath: config.internalApiSocketPath,
            apiKey: config.internalApiKey || undefined,
            tokenPath: config.internalApiTokenPath,
            watchDir: config.internalApiWatchDir,
            runReceiptDir: config.internalApiRunReceiptDir,
            runReceiptIdempotencyTtlMs: config.internalApiRunIdempotencyTtlMs,
            pinDir: config.internalApiPinDir,
            pinDefaultTtlMs: config.internalApiPinDefaultTtlMs,
            pinMaxTtlMs: config.internalApiPinMaxTtlMs,
            pinExpiryIntervalMs: config.internalApiPinExpiryIntervalMs,
            enabled: config.internalApiEnabled,
            // Notify all WebSocket clients when a session is created via the API
            onSessionCreated: (sessionId, sessionPath, runtime) => {
              wsManager!.broadcast({
                type: 'session_update',
                changeType: 'add',
                path: sessionPath,
                sessionId,
                info: {
                  id: sessionId,
                  path: sessionPath,
                  sdkType: runtime,
                  cwd: process.cwd(),
                  firstMessage: '',
                  messageCount: 0,
                  name: `API: ${runtime}`,
                  createdAt: new Date().toISOString(),
                  lastActivity: new Date().toISOString(),
                },
              });
            },
          },
          claudeService: wsManager.getClaudeService(),
          opencodeService: wsManager.getOpenCodeService(),
          antigravityService: wsManager.getAntigravityService(),
          multiSessionManager: wsManager.getMultiSessionManager(),
          sessionRegistry: notificationsRegistry,
          piService: getPiService(),
        });
        await internalApiServer.start();
        logger.info(`[InternalAPI] Started on Unix socket: ${config.internalApiSocketPath}`);
      } catch (err) {
        logger.errorObject('Failed to start enabled internal API', err);
        throw err;
      }
    }
  } catch (error) {
    logger.errorObject('Failed to initialize', error);
    process.exit(1);
  }
}

// Start server
async function start(): Promise<void> {
  await initialize();

  server.listen(config.port, '0.0.0.0', () => {
    logger.info(`Pi Web UI Server running on port ${config.port}`);
    logger.info(`Health check: http://localhost:${config.port}/health`);
    logger.info(`WebSocket: ws://localhost:${config.port}/ws`);
    logger.info(`Allowed origins: ${config.allowedOrigins.join(', ')}`);
  });
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  logger.info('Shutting down...');

  // Stop session watcher
  const { stopSessionWatcher } = await import('./pi/index.js');
  await stopSessionWatcher();

  if (wsManager) {
    await wsManager.close();
  }

  if (sessionCleanup) {
    sessionCleanup.stop();
  }

  if (internalApiServer) {
    await internalApiServer.stop();
  }

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    logger.error('Forced shutdown');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Process-level fatal-error handlers: log message + stack + a context snapshot
// (active session count, uptime) via the central logger, then for
// uncaughtException trigger the same graceful shutdown as SIGTERM/SIGINT. Registered
// exactly once at startup. (Handler logic lives in ./fatal-error-handlers.js so
// it is unit-testable without killing the test runner.)
const fatalErrorHandlers = createFatalErrorHandlers({
  logger,
  shutdown: () => {
    void shutdown();
  },
  getContext: () => ({
    activeSessions: wsManager?.getMultiSessionManager()?.getAllSessionStatuses()?.length ?? 0,
    uptimeSeconds: Math.round(process.uptime()),
  }),
});
process.on('uncaughtException', fatalErrorHandlers.uncaughtException);
process.on('unhandledRejection', fatalErrorHandlers.unhandledRejection);

// Start the server
start().catch((error) => {
  logger.errorObject('Failed to start server', error);
  process.exit(1);
});

export { app, server, wsManager };

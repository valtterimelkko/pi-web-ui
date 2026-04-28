import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import path from 'path';
import { createApp } from './app.js';
import { config } from './config.js';
import { WebSocketConnectionManager } from './websocket/index.js';
import { handleTerminalWebSocket } from './terminal/terminal-websocket.js';
import { initializePiService, startSessionWatcher, getPiService, type SessionChangeEvent, type SessionInfo } from './pi/index.js';
import { SessionCleanupService } from './session-cleanup.js';
import { getSessionRegistry } from './session-registry.js';

const app = createApp();
const server = createServer(app);

// Initialize WebSocket connection manager
let wsManager: WebSocketConnectionManager | null = null;
let sessionCleanup: SessionCleanupService | null = null;
let internalApiServer: import('./internal-api/index.js').InternalApiServer | null = null;

// Initialize Pi service and WebSocket manager
async function initialize(): Promise<void> {
  try {
    // Initialize Pi service first
    await initializePiService();
    console.log('Pi service initialized');

    // Create WebSocket connection manager
    wsManager = new WebSocketConnectionManager();

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);

      // Main WebSocket endpoint
      if (url.pathname === '/ws') {
        wsManager!.handleUpgrade(request, socket, head);
        return;
      }

      // Per-session WebSocket endpoint: /ws/sessions/:sessionId
      const sessionMatch = url.pathname.match(/^\/ws\/sessions\/([^/?]+)$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];

        // Import handleSessionWebSocket dynamically to avoid circular dependencies
        import('./websocket/session-websocket.js').then(({ handleSessionWebSocket }) => {
          // Get the MultiSessionManager from WebSocketConnectionManager
          const multiSessionManager = wsManager!.getMultiSessionManager();

          // Handle the upgrade
          wsManager!.getWss().handleUpgrade(request, socket, head, (ws) => {
            handleSessionWebSocket(ws, request, sessionId, multiSessionManager);
          });
        }).catch((error) => {
          console.error('Failed to handle session WebSocket upgrade:', error);
          socket.destroy();
        });
        return;
      }

      // Terminal WebSocket endpoint: /ws/terminal
      if (url.pathname === '/ws/terminal') {
        wsManager!.getWss().handleUpgrade(request, socket, head, (ws) => {
          handleTerminalWebSocket(ws, request);
        });
        return;
      }

      // Unknown WebSocket path
      socket.destroy();
    });

    // Initialize CLI session watcher
    const sessionWatcher = startSessionWatcher();
    
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
      console.error('SessionWatcher error:', error);
    });

    console.log('WebSocket server ready at /ws');

    // Rebuild session registry from disk (ensures Pi sessions are indexed)
    try {
      const registry = getSessionRegistry(config.sessionRegistryPath);
      const piSessionDir = path.join(config.piAgentDir, 'sessions');
      await registry.rebuildFromPiSessions(piSessionDir);
    } catch (err) {
      console.warn('[Startup] Failed to rebuild session registry from Pi sessions:', err instanceof Error ? err.message : String(err));
    }

    // Start session cleanup service (auto-unpin after 24h, auto-delete archived after 90 days)
    sessionCleanup = new SessionCleanupService();
    sessionCleanup.bindRuntimes({
      multiSessionManager: wsManager.getMultiSessionManager(),
      claudeService: wsManager.getClaudeService(),
      opencodeService: wsManager.getOpenCodeService(),
    });
    sessionCleanup.start();

    // Start internal API server (local backend API for other applications)
    if (config.internalApiEnabled) {
      try {
        const { InternalApiServer } = await import('./internal-api/index.js');
        internalApiServer = new InternalApiServer({
          config: {
            socketPath: config.internalApiSocketPath,
            apiKey: config.internalApiKey || undefined,
            tokenPath: config.internalApiTokenPath,
            enabled: config.internalApiEnabled,
          },
          claudeService: wsManager.getClaudeService(),
          opencodeService: wsManager.getOpenCodeService(),
          multiSessionManager: wsManager.getMultiSessionManager(),
          sessionRegistry: getSessionRegistry(config.sessionRegistryPath),
          piService: getPiService(),
        });
        await internalApiServer.start();
        console.log(`[InternalAPI] Started on Unix socket: ${config.internalApiSocketPath}`);
      } catch (err) {
        console.error('[InternalAPI] Failed to start internal API:', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
}

// Start server
async function start(): Promise<void> {
  await initialize();

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Pi Web UI Server running on port ${config.port}`);
    console.log(`Health check: http://localhost:${config.port}/health`);
    console.log(`WebSocket: ws://localhost:${config.port}/ws`);
    console.log(`Allowed origins: ${config.allowedOrigins.join(', ')}`);
  });
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('Shutting down...');

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
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export { app, server, wsManager };

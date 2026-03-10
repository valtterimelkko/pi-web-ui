import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { createApp } from './app.js';
import { config } from './config.js';
import { WebSocketConnectionManager } from './websocket/index.js';
import { initializePiService, startSessionWatcher, type SessionChangeEvent, type SessionInfo } from './pi/index.js';

const app = createApp();
const server = createServer(app);

// Initialize WebSocket connection manager
let wsManager: WebSocketConnectionManager | null = null;

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
      if (request.url === '/ws') {
        wsManager!.handleUpgrade(request, socket, head);
      } else {
        socket.destroy();
      }
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

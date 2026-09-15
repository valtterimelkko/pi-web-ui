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
import { ShutdownCoordinator } from './shutdown-coordinator.js';
import { CommandCodeService } from './command-code/command-code-service.js';
import { setCommandCodeService } from './command-code/command-code-instance.js';
import { startSystemdNotifier } from './systemd-notifier.js';
import { closeHttpServer } from './http-server-close.js';
import {
  DEFAULT_ESCAPE_POLL_INTERVAL_MS,
  installStopSignalHandlers,
  resolveEscapeAfterMs,
  spawnShutdownEscapeWorker,
} from './shutdown-signal.js';
import { createSignalReceivedBuffer } from './shutdown-signal.js';

// State used by createApp's lazy notification-router getters. Declared before
// createApp() (which runs at module load) so the getters close over initialized
// bindings; they are populated later in initialize() and resolved per request.
let wsManager: WebSocketConnectionManager | null = null;
let sessionCleanup: SessionCleanupService | null = null;
let internalApiServer: import('./internal-api/index.js').InternalApiServer | null = null;
let notificationsRegistry: ReturnType<typeof getSessionRegistry> | null = null;
let stopSystemdNotifier: () => void = () => {};
let browserCommandCodeSessionResolver: ((sessionId: string, runtime: import('./notifications/types.js').NotificationRuntime, sessionPath: string) => Promise<boolean>) | undefined;

const app = createApp({
  getManager: () => internalApiServer?.getNotificationManager() ?? null,
  resolveSession: async (sessionId, runtime, sessionPath) => browserCommandCodeSessionResolver
    ? browserCommandCodeSessionResolver(sessionId, runtime, sessionPath)
    : runtime !== 'commandcode',
});
const server = createServer(app);

// Initialize Pi service and WebSocket manager
async function initialize(): Promise<void> {
  try {
    // Initialize Pi service first
    await initializePiService();
    logger.info('Pi service initialized');

    const sharedRegistry = getSessionRegistry(config.sessionRegistryPath);

    // One process-owned Command Code service is shared by browser WebSocket
    // traffic and the authenticated Internal API.
    const commandCodeService = new CommandCodeService({
      config: {
        enabled: config.commandCodeEnabled,
        executablePath: config.commandCodeExecutablePath,
        stateDir: config.commandCodeStateDir,
        nativeHomeDir: config.commandCodeNativeHomeDir,
        allowedCwdRoots: config.commandCodeAllowedCwdRoots,
        maxTurns: config.commandCodeMaxTurns,
        maxWallTimeMs: config.commandCodeMaxWallTimeMs,
        concurrency: config.commandCodeConcurrency,
      },
      sessionRegistry: sharedRegistry,
    });

    setCommandCodeService(commandCodeService);
    // Complete bounded Command Code discovery before the server exposes any
    // browser/WebSocket or Internal API session path.
    await commandCodeService.init();
    browserCommandCodeSessionResolver = async (sessionId, runtime, sessionPath) => {
      if (runtime !== 'commandcode') return true;
      return sessionId === sessionPath && await commandCodeService.hasSession(sessionId);
    };

    // Create WebSocket connection manager
    wsManager = new WebSocketConnectionManager(commandCodeService);

    // Handle WebSocket upgrade requests. One central pre-upgrade guard
    // (origin + cookie-auth + upgrade rate-limit) is applied to every accepted
    // path inside handleWebSocketUpgrade, before any handleUpgrade.
    server.on('upgrade', (request, socket, head) => {
      handleWebSocketUpgrade(request, socket, head, {
        wsManager: wsManager!,
        verbose: process.env.NODE_ENV === 'development',
      });
    });

    // Initialize CLI session watcher. Each already-observed add/change is
    // incrementally indexed; this does not trigger a directory-wide rescan.
    const watcherRegistry = sharedRegistry;
    const sessionWatcher = startSessionWatcher(
      config.sessionDir || path.join(config.piAgentDir, 'sessions'),
      watcherRegistry,
    );
    
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

      // Watch-defect brief fix 3: bridge native CLI session activity into the
      // Internal API event broker so watches observe sessions driven from
      // bare CLI/external tools (tmux pi, claude -p, …) without any prompt
      // path involved. Published under both broker aliases (path and id) —
      // the watch layer dedupes the shared object. Distinct copies per key so
      // broker replay buffers hold independent records.
      const broker = internalApiServer?.getEventBroker();
      if (broker && event.sessionId) {
        const base = {
          type: 'session_update',
          timestamp: Date.now(),
          data: {
            changeType: event.type,
            sessionId: event.sessionId,
            path: event.path,
            ...(event.cwd ? { cwd: event.cwd } : {}),
            ...(event.info ? {
              messageCount: event.info.messageCount,
              lastActivity: event.info.lastActivity.toISOString(),
            } : {}),
          },
        } as import('@pi-web-ui/shared').NormalizedEvent;
        try {
          broker.publish(event.path, base);
          if (event.sessionId !== event.path) {
            broker.publish(event.sessionId, { ...base });
          }
        } catch { /* bridging is best-effort */ }
      }
    });

    sessionWatcher.on('error', (error: Error) => {
      logger.error('SessionWatcher error:', error);
    });

    logger.info('WebSocket server ready at /ws');

    // Pi registry discovery is incremental via SessionWatcher add/change.
    // Existing files remain discoverable through session listing and the exact
    // debug:where filename fallback; no boot-time directory rescan is allowed.

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
        // Contract 1.27.0: browser goal-control for claude/commandcode rides
        // the Internal API goal-control handler once the server is started.
        queueMicrotask(() => {
          const handler = internalApiServer?.getGoalControlHandler() ?? null;
          if (wsManager && handler) {
            wsManager.goalControlApi = (sessionId, body) => handler(sessionId, body);
          }
        });
        notificationsRegistry = sharedRegistry;
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
            admissionMaxActiveTurns: config.internalApiAdmissionMaxActiveTurns,
            admissionInteractiveReserve: config.internalApiAdmissionInteractiveReserve,
            admissionMinimumHeadroomBytes: config.internalApiAdmissionMinimumHeadroomBytes,
            admissionHostMinimumHeadroomBytes: config.internalApiAdmissionHostMinimumHeadroomBytes,
            admissionReservedBytesPerTurn: config.internalApiAdmissionReservedBytesPerTurn,
            admissionReservedPidsPerTurn: config.internalApiAdmissionReservedPidsPerTurn,
            commandCodeConcurrency: config.commandCodeConcurrency,
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
          commandCodeService,
          // Contract 1.27.0 goal function: goal events bridge to the browser
          // as extension-UI-grammar messages the client goal surface parses.
          onBrowserMessage: (message: Record<string, unknown>) => {
            wsManager?.broadcast(message);
          },
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
    stopSystemdNotifier = startSystemdNotifier({ logger });
  });
}

// Graceful shutdown — single-flight, resilient (every owner is attempted even
// if an earlier step throws), clean exit(0) with the force timer cancelled.
// The hard exit(1) deadline stays below systemd's TimeoutStopSec window.
const shutdownCoordinator = new ShutdownCoordinator({
  steps: [
    { name: 'systemd-notifier', run: () => { stopSystemdNotifier(); } },
    { name: 'session-watcher', run: async () => { const { stopSessionWatcher } = await import('./pi/index.js'); await stopSessionWatcher(); } },
    { name: 'websocket-clients', run: async () => { if (wsManager) await wsManager.close(); } },
    { name: 'session-cleanup', run: () => { sessionCleanup?.stop(); } },
    { name: 'internal-api', run: async () => { if (internalApiServer) await internalApiServer.stop(); } },
    // Bounded close (2026-09-15). `server.close()` alone only calls back once
    // every connection has gone, and this process holds long-lived WebSocket
    // clients by design: on 2026-09-14 18:04:17 and 21:15:56 this step never
    // completed at all, so the coordinator's own deadline was the only thing
    // that ended the stop, a few seconds inside systemd's TimeoutStopSec=30.
    // A stop that reaches systemd's escalation is a SIGKILL of the whole
    // control group — every orchestration child with it.
    { name: 'http-server', run: async () => { await closeHttpServer(server, { timeoutMs: 5_000 }); } },
  ],
  onStepError: (name, err) => logger.errorObject(`Shutdown step '${name}' failed`, err),
  onForceExit: () => logger.error('Forced shutdown: teardown exceeded the deadline'),
    // 2026-09-14: four systemd SIGKILLs in one afternoon could not be explained from
    // the journal - teardown either completed or it did not, with nothing recording
    // WHICH owner was slow, or indeed whether the graceful path ran at all. A clean
    // SIGTERM on a disposable server exits in ~2s, so a production stop that instead
    // runs to TimeoutStopSec leaves no record of why. These lines are that record.
    onStepComplete: (name, durationMs, failed) =>
      logger.info(`Shutdown step '${name}' ${failed ? 'FAILED ' : ''}in ${durationMs}ms`),
    onComplete: (totalMs) => logger.info(`Shutdown complete in ${totalMs}ms`),
});

function shutdown(): void {
  logger.info('Shutting down...');
  void shutdownCoordinator.shutdown();
}

// ---- Stop-signal instrumentation (2026-09-15) -----------------------------
//
// The 2026-09-14/15 stops that ran to `TimeoutStopSec` could not be explained
// because the journal recorded neither a stop job nor a receipt of the signal:
// the app's only record lived inside `shutdown()`, behind an async logger. The
// instrument is therefore in three parts, and they are deliberately ordered so
// the cheapest and most durable happens first:
//
//   1. `handleStopSignal` writes the received signal to stderr synchronously,
//      before any await, and arms a hard-exit deadline in the same handler.
//   2. the same handler publishes the signal time into a SharedArrayBuffer.
//   3. a worker thread (armed now, long before any stop) watches that buffer and
//      force-exits the process if the main thread has not finished inside the
//      grace window. A backstop on the loop it must survive is not a backstop —
//      the same reasoning that moved the watchdog ping off the main loop.
//
// The worker is intentionally NOT terminated once teardown starts: a teardown
// that takes longer than the window is exactly the case it exists for. A clean
// teardown calls `process.exit(0)` well inside the window and the worker dies
// with the process. The window is configurable via
// `PI_WEB_UI_SHUTDOWN_ESCAPE_MS` (default 12s, against systemd's 30s).
const signalReceived = createSignalReceivedBuffer();
spawnShutdownEscapeWorker({
  signalReceived,
  escapeAfterMs: resolveEscapeAfterMs(),
  pollIntervalMs: DEFAULT_ESCAPE_POLL_INTERVAL_MS,
});

installStopSignalHandlers({
  signalReceived,
  onShutdown: shutdown,
});

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

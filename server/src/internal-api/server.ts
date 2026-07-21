/**
 * Internal API Server
 *
 * HTTP server bound to a Unix domain socket (or 127.0.0.1) that exposes
 * the Pi Web UI backend for programmatic consumption by other local
 * applications.
 *
 * Key properties:
 * - Reuses existing runtime services (no backend duplication)
 * - Sessions created via this API appear in the web UI sidebar
 * - Model lists are always live (no caching)
 * - Three verbosity levels: answers, tasks, full
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { randomBytes } from 'crypto';
import { writeFile, readFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createAuthMiddleware } from './middleware/auth.js';
import { ErrorCode } from './error-codes.js';
import { RequestBodyTooLargeError } from './request-body.js';
import { closeServerWithGrace } from './server-shutdown.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createModelsRoutes, type ModelsRoutesDeps } from './routes/models.js';
import { createHealthRoutes, type HealthRoutesDeps } from './routes/health.js';
import { createCapabilitiesRoutes, type CapabilitiesRoutesDeps } from './routes/capabilities.js';
import { createDiagnosticsRoutes } from './routes/diagnostics.js';
import { createEventTypesRoutes } from './routes/event-types.js';
import { createNotificationsRoutes } from './routes/notifications.js';
import { RunReceiptManager } from './run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from './run-receipts/run-receipt-store.js';
import { NotificationManager } from '../notifications/notification-manager.js';
import { NotificationStore } from '../notifications/notification-store.js';
import { NotificationIngressSpool } from '../notifications/notification-ingress-spool.js';
import { ChannelRouter } from '../notifications/channels/notification-channel.js';
import { pickNotificationChannel } from '../notifications/channel-factory.js';
import { readPreferences, deriveLegacyArrays } from '../routes/preferences.js';
import { createRequestLoggingMiddleware } from './request-logging.js';
import { pushDiagnosticsRecord } from './diagnostics-buffer.js';
import { setLogTap } from '../logging/logger.js';
import type { ClaudeService } from '../claude/claude-service.js';
import type { OpenCodeService } from '../opencode/opencode-service.js';
import type { AntigravityService } from '../antigravity/antigravity-service.js';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../session-registry.js';
import type { PiService } from '../pi/pi-service.js';
import { config } from '../config.js';
import { createLogger } from '../logging/logger.js';
import { bindOwnerOnlyUnixSocket, UnixSocketOwner } from './unix-socket-owner.js';
import { getWorkerPool } from '../routes/sessions.js';

const logger = createLogger('InternalAPI');


// ─── Configuration ───────────────────────────────────────────────────────────

export interface InternalApiConfig {
  /** Unix socket path (primary) */
  socketPath?: string;
  /** Fallback: bind to 127.0.0.1 on this port */
  port?: number;
  /** Pre-set API key (auto-generated if not provided) */
  apiKey?: string;
  /** Path to store the auto-generated API token */
  tokenPath?: string;
  /** Directory for durable long-horizon watch ledgers */
  watchDir?: string;
  /** Directory for the durable API-pin expiry ledger */
  pinDir?: string;
  /** Directory for persisted Internal-API run receipts. */
  runReceiptDir?: string;
  /** Idempotency replay window for accepted runs. */
  runReceiptIdempotencyTtlMs?: number;
  /** Default API-pin lifetime (ms) */
  pinDefaultTtlMs?: number;
  /** Hard maximum API-pin lifetime (ms) */
  pinMaxTtlMs?: number;
  /** How often the pin-expiry sweep runs (ms) */
  pinExpiryIntervalMs?: number;
  /** Enable the API (default: true if config present) */
  enabled?: boolean;
  /** Maximum graceful shutdown wait before persistent clients are closed. */
  shutdownGraceMs?: number;
  /** Callback invoked when a session is created via the API */
  onSessionCreated?: (sessionId: string, sessionPath: string, runtime: string) => void;
}

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock');
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.pi-web-ui', 'internal-api-token');
const DEFAULT_WATCH_DIR = path.join(os.homedir(), '.pi-web-ui', 'watches');
const DEFAULT_PIN_DIR = path.join(os.homedir(), '.pi-web-ui', 'pins');
const DEFAULT_RUN_RECEIPT_DIR = path.join(os.homedir(), '.pi-web-ui', 'run-receipts');
const DEFAULT_NOTIFICATIONS_DIR = path.join(os.homedir(), '.pi-web-ui', 'notifications');

// ─── Server ──────────────────────────────────────────────────────────────────

export class InternalApiServer {
  private server: Server | null = null;
  private config: InternalApiConfig;
  private apiKey: string;
  private startTime: number = Date.now();

  // Service dependencies
  private claudeService: ClaudeService;
  private opencodeService: OpenCodeService;
  private antigravityService: AntigravityService;
  private multiSessionManager: MultiSessionManager;
  private sessionRegistry: SessionRegistryManager;
  private piService: PiService;
  private runReceiptManager: RunReceiptManager | null = null;
  private notificationManager: NotificationManager | null = null;
  private socketOwner: UnixSocketOwner | null = null;
  private sessionRoutesShutdown: (() => Promise<void>) | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly connections = new Set<Socket>();

  // Unique ID for this internal API's Pi SDK sessions
  private internalClientId: string;

  constructor(deps: {
    config: InternalApiConfig;
    claudeService: ClaudeService;
    opencodeService: OpenCodeService;
    antigravityService: AntigravityService;
    multiSessionManager: MultiSessionManager;
    sessionRegistry: SessionRegistryManager;
    piService: PiService;
  }) {
    this.config = deps.config;
    this.apiKey = deps.config.apiKey || '';
    this.claudeService = deps.claudeService;
    this.opencodeService = deps.opencodeService;
    this.antigravityService = deps.antigravityService;
    this.multiSessionManager = deps.multiSessionManager;
    this.sessionRegistry = deps.sessionRegistry;
    this.piService = deps.piService;
    this.internalClientId = `internal-api-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Start the internal API server.
   * Generates an API key if one wasn't provided.
   */
  async start(): Promise<void> {
    const socketPath = this.config.socketPath || DEFAULT_SOCKET_PATH;
    const tokenPath = this.config.tokenPath || DEFAULT_TOKEN_PATH;
    const socketOwner = new UnixSocketOwner(socketPath);
    await socketOwner.prepareForBind();

    try {
    // Generate or load API key
    if (!this.apiKey) {
      this.apiKey = await this.resolveApiKey(tokenPath);
    }

    // Load durable run receipts before binding the socket. A restart must
    // recover in-flight records before a caller can retry an idempotent key.
    const runReceiptManager = new RunReceiptManager({
      store: new RunReceiptStore(this.config.runReceiptDir || DEFAULT_RUN_RECEIPT_DIR),
      idempotencyTtlMs: this.config.runReceiptIdempotencyTtlMs ?? config.internalApiRunIdempotencyTtlMs,
    });
    await runReceiptManager.init();
    this.runReceiptManager = runReceiptManager;

    // Create routes
    const sessionRoutes = createSessionRoutes({
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
      multiSessionManager: this.multiSessionManager,
      sessionRegistry: this.sessionRegistry,
      piService: this.piService,
      internalClientId: this.internalClientId,
      watchDir: this.config.watchDir || DEFAULT_WATCH_DIR,
      runReceiptManager,
      pinDir: this.config.pinDir || DEFAULT_PIN_DIR,
      pinDefaultTtlMs: this.config.pinDefaultTtlMs,
      pinMaxTtlMs: this.config.pinMaxTtlMs,
      pinExpiryIntervalMs: this.config.pinExpiryIntervalMs,
      onSessionCreated: this.config.onSessionCreated,
      piSessionDir: config.sessionDir || path.join(config.piAgentDir, 'sessions'),
      claudeSessionDir: config.claudeSessionDir,
      antigravitySessionDir: config.antigravitySessionDir,
    });
    this.sessionRoutesShutdown = sessionRoutes.shutdown;
    await sessionRoutes.ready;

    const modelsDeps: ModelsRoutesDeps = {
      piService: this.piService,
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
    };
    const modelsRoutes = createModelsRoutes(modelsDeps);

    const healthDeps: HealthRoutesDeps = {
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
      startTime: this.startTime,
      enabled: {
        claude: true,
        opencode: config.opencodeServerEnabled,
        antigravity: config.antigravityEnabled,
      },
    };
    const healthRoutes = createHealthRoutes(healthDeps);

    const capabilitiesDeps: CapabilitiesRoutesDeps = {
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
    };
    const capabilitiesRoutes = createCapabilitiesRoutes(capabilitiesDeps);

    const diagnosticsRoutes = createDiagnosticsRoutes({
      sessionRegistry: this.sessionRegistry,
      workerSummary: () => {
        const pool = getWorkerPool();
        const crashes = pool.getCrashStats();
        return {
          pool: pool.getStats(),
          crashes: {
            totalCrashes: crashes.totalCrashes,
            crashesLast24h: crashes.crashesLast24h,
            crashesLastHour: crashes.crashesLastHour,
            byType: crashes.byType,
            oomStats: crashes.oomStats,
          },
        };
      },
    });

    const eventTypesRoutes = createEventTypesRoutes();

    // Notification layer (Telegram on agent_end; explicit POST). Inert when
    // NOTIFICATIONS_ENABLED is off: no observers are attached and the outbox is
    // not drained. Credentials come from env only (never committed).
    const notificationsDir = config.notificationsDir || DEFAULT_NOTIFICATIONS_DIR;
    const notificationStore = new NotificationStore(notificationsDir);
    const notificationRouter = new ChannelRouter();
    notificationRouter.register(
      pickNotificationChannel({
        validationMode: config.validationMode,
        telegramBotToken: config.telegramBotToken,
        telegramChatId: config.telegramChatId,
        timeoutMs: config.notificationsChannelTimeoutMs,
      }),
    );
    const notificationManager = new NotificationManager({
      enabled: config.notificationsEnabled,
      store: notificationStore,
      router: notificationRouter,
      services: {
        pi: this.multiSessionManager,
        claude: this.claudeService,
        opencode: this.opencodeService,
        antigravity: this.antigravityService,
      },
      tailMaxChars: config.notificationsTailMaxChars,
      publicBaseUrl: config.notificationsPublicBaseUrl ?? config.allowedOrigins[0],
      debounceMs: config.notificationsDebounceMs,
      maxAttempts: config.notificationsMaxDeliveryAttempts,
      ingressSpool: new NotificationIngressSpool(path.join(notificationsDir, 'ingress')),
      ingressPollMs: config.notificationsIngressPollMs,
      // Live-resolve the renamed display name (web-ui-prefs.json) so the
      // notification header reflects a rename even after opt-in. Best-effort:
      // a read failure falls back through the snapshot label → runtime label.
      resolveLabel: async (sessionPath: string) => {
        try {
          const prefs = await readPreferences();
          const name = deriveLegacyArrays(prefs).sessionDisplayNames[sessionPath];
          return typeof name === 'string' && name.trim() ? name.trim() : undefined;
        } catch {
          return undefined;
        }
      },
    });
    await notificationManager.init();
    this.notificationManager = notificationManager;
    const notificationRoutes = createNotificationsRoutes({
      manager: notificationManager,
      sessionRegistry: this.sessionRegistry,
    });

    // Capture recent structured logs into the diagnostics ring buffer so the
    // /diagnostics endpoints can self-serve them. The buffer scrubs secrets on
    // push, so the tap never persists tokens/credentials.
    setLogTap((record) => pushDiagnosticsRecord(record));

    const authMiddleware = createAuthMiddleware(this.apiKey);

    const requestLogging = createRequestLoggingMiddleware(logger);

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS for local development (permissive because local-only)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Verbosity, Idempotency-Key');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Route matching
      const url = req.url || '/';
      const parsed = parseUrl(url);

      // Request logging (debug) wraps auth + routing so the per-request
      // requestId is shared with prompt correlation lines.
      requestLogging(req, res, () => {
        // Apply auth middleware (except health)
        authMiddleware(req, res, () => {
          void this.routeRequest(req, res, parsed, {
            sessionRoutes,
            modelsRoutes,
            healthRoutes,
            capabilitiesRoutes,
            diagnosticsRoutes,
            eventTypesRoutes,
            notificationRoutes,
          }).catch((error) => {
            const tooLarge = error instanceof RequestBodyTooLargeError;
            const malformedPath = error instanceof URIError;
            if (tooLarge || malformedPath) {
              logger.warn(`Internal API request rejected: ${error instanceof Error ? error.message : String(error)}`);
            } else {
              logger.errorObject('Internal API request failed', error);
            }
            if (res.headersSent) {
              res.destroy(error instanceof Error ? error : undefined);
              return;
            }
            sendJson(res, tooLarge ? 413 : malformedPath ? 400 : 500, {
              error: tooLarge ? error.message : malformedPath ? 'Malformed URL path encoding.' : 'Internal API request failed.',
              code: tooLarge
                ? ErrorCode.PAYLOAD_TOO_LARGE
                : malformedPath ? ErrorCode.INVALID_REQUEST : ErrorCode.INTERNAL_ERROR,
            });
          });
        });
      });
    });
    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });

    // Bind under the process-lifetime ownership lock. Node removes its own Unix
    // socket on close; the lock prevents a cooperative successor from binding
    // the pathname until shutdown has completed.
    await this.bindToSocket(socketPath);
    await socketOwner.captureOwnership();
    this.socketOwner = socketOwner;

    logger.info(`[InternalAPI] Listening on Unix socket: ${socketPath}`);
    logger.info(`[InternalAPI] API token ready at: ${tokenPath}`);
    } catch (error) {
      const notificationManager = this.notificationManager;
      notificationManager?.shutdown();
      await notificationManager?.waitForIdle();
      this.notificationManager = null;
      if (this.sessionRoutesShutdown) {
        await this.sessionRoutesShutdown().catch(() => { /* preserve startup error */ });
        this.sessionRoutesShutdown = null;
      }
      if (this.runReceiptManager) {
        await this.runReceiptManager.shutdown().catch(() => { /* preserve startup error */ });
        this.runReceiptManager = null;
      }
      await this.closeHttpServer().catch(() => { /* preserve startup error */ });
      await socketOwner.release().catch(() => { /* preserve startup error */ });
      throw error;
    }
  }

  /**
   * Stop the server and clean up the socket file.
   */
  /** The notification manager (built in start()), or null. Exposed so the cookie-auth browser route can reach it. */
  getNotificationManager(): NotificationManager | null {
    return this.notificationManager;
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const failures: unknown[] = [];
    try {
      const notificationManager = this.notificationManager;
      notificationManager?.shutdown();
      await notificationManager?.waitForIdle().catch((error) => failures.push(error));
      this.notificationManager = null;
      if (this.sessionRoutesShutdown) {
        await this.sessionRoutesShutdown().catch((error) => failures.push(error));
        this.sessionRoutesShutdown = null;
      }
      if (this.runReceiptManager) {
        await this.runReceiptManager.shutdown().catch((error) => failures.push(error));
        this.runReceiptManager = null;
      }
      await this.closeHttpServer().catch((error) => failures.push(error));
    } finally {
      await this.socketOwner?.release().catch((error) => failures.push(error));
      this.socketOwner = null;
    }
    logger.info('[InternalAPI] Server stopped');
    if (failures.length > 0) throw new AggregateError(failures, 'Internal API shutdown encountered errors');
  }

  private async closeHttpServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await closeServerWithGrace(server, this.connections, this.config.shutdownGraceMs ?? 2000);
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  private async routeRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: { path: string[]; query: URLSearchParams },
    deps: {
      sessionRoutes: ReturnType<typeof createSessionRoutes>;
      modelsRoutes: ReturnType<typeof createModelsRoutes>;
      healthRoutes: ReturnType<typeof createHealthRoutes>;
      capabilitiesRoutes: ReturnType<typeof createCapabilitiesRoutes>;
      diagnosticsRoutes: ReturnType<typeof createDiagnosticsRoutes>;
      eventTypesRoutes: ReturnType<typeof createEventTypesRoutes>;
      notificationRoutes: ReturnType<typeof createNotificationsRoutes>;
    },
  ): Promise<void> {
    // Skip 'api' prefix if present: /api/v1/health → ['api', 'v1', 'health']
    const segments = parsed.path[0] === 'api' ? parsed.path.slice(1) : parsed.path;
    const [version, resource, id, action, subId, subAction] = segments;

    if (version !== 'v1') {
      sendJson(res, 404, { error: 'API version not found', code: ErrorCode.NOT_FOUND });
      return;
    }

    switch (resource) {
      case 'sessions': {
        if (!id) {
          // /api/v1/sessions
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleListSessions(req, res);
          } else if (req.method === 'POST') {
            await deps.sessionRoutes.handleCreateSession(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        // /api/v1/sessions/batch and /api/v1/sessions/usage are reserved words
        if (id === 'batch' && !action) {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleBatchCreate(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        if (id === 'batch' && action === 'prompt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleBatchPrompt(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        if (id === 'usage') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAggregateUsage(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        const sessionId = decodeURIComponent(id);

        if (action === 'prompt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSendPrompt(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'abort') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAbort(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'info') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionInfo(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'diagnostics') {
          if (req.method === 'GET') {
            await deps.diagnosticsRoutes.handleGetSessionDiagnostics(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'evidence') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionEvidence(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'history') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionHistory(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'transcript') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionTranscript(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'events') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionEvents(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'notifications') {
          // /api/v1/sessions/:id/notifications[/opt-in]
          if (subId === 'opt-in') {
            if (req.method === 'POST') {
              await deps.notificationRoutes.handleOptIn(req, res, sessionId);
            } else if (req.method === 'DELETE') {
              await deps.notificationRoutes.handleOptOut(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
          if (!subId) {
            if (req.method === 'GET') {
              await deps.notificationRoutes.handleGetSessionState(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
        }

        if (action === 'wait') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionWait(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'watch') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleRegisterWatch(req, res, sessionId);
          } else if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetWatch(req, res, sessionId, parsed.query);
          } else if (req.method === 'DELETE') {
            await deps.sessionRoutes.handleDeleteWatch(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'transfer') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionTransfer(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'control') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionControl(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'approvals') {
          // /api/v1/sessions/:id/approvals/pending
          if (subId === 'pending' && !subAction) {
            if (req.method === 'GET') {
              await deps.sessionRoutes.handleListPendingApprovals(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
          // /api/v1/sessions/:id/approvals/:requestId/respond
          if (subId && subAction === 'respond') {
            if (req.method === 'POST') {
              await deps.sessionRoutes.handleRespondApproval(req, res, sessionId, decodeURIComponent(subId));
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
          sendJson(res, 404, { error: 'Unknown approvals endpoint', code: ErrorCode.NOT_FOUND });
          return;
        }

        // /api/v1/sessions/:id
        if (req.method === 'GET') {
          await deps.sessionRoutes.handleGetSession(req, res, sessionId);
        } else if (req.method === 'DELETE') {
          await deps.sessionRoutes.handleDeleteSession(req, res, sessionId);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'runs': {
        if (id && req.method === 'GET') {
          await deps.sessionRoutes.handleGetRunReceipt(req, res, decodeURIComponent(id));
        } else {
          sendJson(res, id ? 405 : 404, {
            error: id ? 'Method not allowed' : 'Run id is required',
            code: id ? ErrorCode.METHOD_NOT_ALLOWED : ErrorCode.NOT_FOUND,
          });
        }
        return;
      }

      case 'models': {
        if (id === 'refresh') {
          if (req.method === 'POST') {
            await deps.modelsRoutes.handleRefreshModels(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        if (req.method === 'GET') {
          await deps.modelsRoutes.handleListModels(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'health': {
        await deps.healthRoutes.handleHealth(req, res);
        return;
      }

      case 'capabilities': {
        if (req.method === 'GET') {
          await deps.capabilitiesRoutes.handleGetCapabilities(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'diagnostics': {
        if (req.method === 'GET') {
          await deps.diagnosticsRoutes.handleGetDiagnostics(req, res, parsed.query);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'events': {
        // GET /api/v1/events/types — structured event-type registry
        if (id === 'types') {
          if (req.method === 'GET') {
            await deps.eventTypesRoutes.handleGetEventTypes(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        sendJson(res, 404, { error: 'Unknown events endpoint', code: ErrorCode.NOT_FOUND });
        return;
      }

      case 'notifications': {
        // POST /api/v1/notifications — explicit durable acceptance
        // GET  /api/v1/notifications — recent delivery log
        // GET  /api/v1/notifications/:id — one delivery status
        if (id) {
          if (req.method === 'GET') {
            await deps.notificationRoutes.handleGetDeliveryStatus(req, res, decodeURIComponent(id));
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
        } else if (req.method === 'POST') {
          await deps.notificationRoutes.handleExplicitNotify(req, res);
        } else if (req.method === 'GET') {
          await deps.notificationRoutes.handleGetRecentDeliveries(req, res, parsed.query);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      default: {
        sendJson(res, 404, { error: 'Unknown endpoint', code: ErrorCode.NOT_FOUND });
      }
    }
  }

  // ── Socket binding ───────────────────────────────────────────────────────

  private async bindToSocket(socketPath: string): Promise<void> {
    // Ensure parent directory exists
    const dir = path.dirname(socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // Do not advertise readiness until owner-only permissions are confirmed.
    if (!this.server) throw new Error('Internal API HTTP server was not initialized.');
    await bindOwnerOnlyUnixSocket(this.server, socketPath);
  }

  // ── API key management ───────────────────────────────────────────────────

  private async resolveApiKey(tokenPath: string): Promise<string> {
    // Check env var first
    if (process.env.INTERNAL_API_KEY) {
      return process.env.INTERNAL_API_KEY;
    }

    // Try to read existing token file
    try {
      const existing = await readFile(tokenPath, 'utf-8');
      const trimmed = existing.trim();
      if (trimmed.length >= 16) {
        return trimmed;
      }
    } catch {
      // Token file doesn't exist, generate new
    }

    // Generate and persist a new random token
    const token = randomBytes(48).toString('hex'); // 96 chars
    await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, token, { mode: 0o600 });
    return token;
  }
}

// ─── URL Parsing ─────────────────────────────────────────────────────────────

function parseUrl(url: string): { path: string[]; query: URLSearchParams } {
  // Handle /api/v1/resource/id/action format
  const parts = url.split('?')[0].split('/').filter(Boolean);
  const queryString = url.includes('?') ? url.split('?')[1] : '';
  const query = new URLSearchParams(queryString);
  return { path: parts, query };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

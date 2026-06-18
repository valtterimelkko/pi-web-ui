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
import { randomBytes } from 'crypto';
import { writeFile, readFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createAuthMiddleware } from './middleware/auth.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createModelsRoutes, type ModelsRoutesDeps } from './routes/models.js';
import { createHealthRoutes, type HealthRoutesDeps } from './routes/health.js';
import { createCapabilitiesRoutes, type CapabilitiesRoutesDeps } from './routes/capabilities.js';
import type { ClaudeService } from '../claude/claude-service.js';
import type { OpenCodeService } from '../opencode/opencode-service.js';
import type { AntigravityService } from '../antigravity/antigravity-service.js';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../session-registry.js';
import type { PiService } from '../pi/pi-service.js';

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
  /** Enable the API (default: true if config present) */
  enabled?: boolean;
  /** Callback invoked when a session is created via the API */
  onSessionCreated?: (sessionId: string, sessionPath: string, runtime: string) => void;
}

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock');
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.pi-web-ui', 'internal-api-token');
const DEFAULT_WATCH_DIR = path.join(os.homedir(), '.pi-web-ui', 'watches');

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

    // Generate or load API key
    if (!this.apiKey) {
      this.apiKey = await this.resolveApiKey(tokenPath);
    }

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
      onSessionCreated: this.config.onSessionCreated,
    });

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
    };
    const healthRoutes = createHealthRoutes(healthDeps);

    const capabilitiesDeps: CapabilitiesRoutesDeps = {
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
    };
    const capabilitiesRoutes = createCapabilitiesRoutes(capabilitiesDeps);

    const authMiddleware = createAuthMiddleware(this.apiKey);

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS for local development (permissive because local-only)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Verbosity');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Route matching
      const url = req.url || '/';
      const parsed = parseUrl(url);

      // Apply auth middleware (except health)
      authMiddleware(req, res, () => {
        void this.routeRequest(req, res, parsed, {
          sessionRoutes,
          modelsRoutes,
          healthRoutes,
          capabilitiesRoutes,
        });
      });
    });

    // Bind to Unix socket
    await this.bindToSocket(socketPath);

    console.log(`[InternalAPI] Listening on Unix socket: ${socketPath}`);
    console.log(`[InternalAPI] API token ready at: ${tokenPath}`);
  }

  /**
   * Stop the server and clean up the socket file.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        const socketPath = this.config.socketPath || DEFAULT_SOCKET_PATH;
        unlink(socketPath).catch(() => { /* socket may not exist */ });
        console.log('[InternalAPI] Server stopped');
        resolve();
      });
    });
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
    },
  ): Promise<void> {
    // Skip 'api' prefix if present: /api/v1/health → ['api', 'v1', 'health']
    const segments = parsed.path[0] === 'api' ? parsed.path.slice(1) : parsed.path;
    const [version, resource, id, action, subId, subAction] = segments;

    if (version !== 'v1') {
      sendJson(res, 404, { error: 'API version not found', code: 'NOT_FOUND' });
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
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        // /api/v1/sessions/batch and /api/v1/sessions/usage are reserved words
        if (id === 'batch' && !action) {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleBatchCreate(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }
        if (id === 'batch' && action === 'prompt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleBatchPrompt(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }
        if (id === 'usage') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAggregateUsage(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        const sessionId = decodeURIComponent(id);

        if (action === 'prompt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSendPrompt(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'abort') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAbort(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'info') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionInfo(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'history') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionHistory(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'transcript') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionTranscript(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'events') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionEvents(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'wait') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionWait(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
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
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'transfer') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionTransfer(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'control') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionControl(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }

        if (action === 'approvals') {
          // /api/v1/sessions/:id/approvals/pending
          if (subId === 'pending' && !subAction) {
            if (req.method === 'GET') {
              await deps.sessionRoutes.handleListPendingApprovals(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
            }
            return;
          }
          // /api/v1/sessions/:id/approvals/:requestId/respond
          if (subId && subAction === 'respond') {
            if (req.method === 'POST') {
              await deps.sessionRoutes.handleRespondApproval(req, res, sessionId, decodeURIComponent(subId));
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
            }
            return;
          }
          sendJson(res, 404, { error: 'Unknown approvals endpoint', code: 'NOT_FOUND' });
          return;
        }

        // /api/v1/sessions/:id
        if (req.method === 'GET') {
          await deps.sessionRoutes.handleGetSession(req, res, sessionId);
        } else if (req.method === 'DELETE') {
          await deps.sessionRoutes.handleDeleteSession(req, res, sessionId);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
        }
        return;
      }

      case 'models': {
        if (id === 'refresh') {
          if (req.method === 'POST') {
            await deps.modelsRoutes.handleRefreshModels(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
          }
          return;
        }
        if (req.method === 'GET') {
          await deps.modelsRoutes.handleListModels(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
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
          sendJson(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
        }
        return;
      }

      default: {
        sendJson(res, 404, { error: 'Unknown endpoint', code: 'NOT_FOUND' });
      }
    }
  }

  // ── Socket binding ───────────────────────────────────────────────────────

  private async bindToSocket(socketPath: string): Promise<void> {
    // Ensure parent directory exists
    const dir = path.dirname(socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // Remove existing socket if stale
    try {
      await unlink(socketPath);
    } catch {
      // Doesn't exist, fine
    }

    return new Promise((resolve, reject) => {
      this.server!.listen(socketPath, () => {
        // Set restrictive permissions
        import('fs').then((fs) => {
          fs.chmod(socketPath, 0o600, (err) => {
            if (err) console.warn(`[InternalAPI] Failed to set socket permissions:`, err.message);
          });
        });
        resolve();
      });

      this.server!.on('error', (err) => {
        reject(err);
      });
    });
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

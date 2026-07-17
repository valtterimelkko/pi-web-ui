/**
 * Central WebSocket upgrade handler.
 *
 * One pre-upgrade guard (`decideWsUpgrade`: origin + cookie-auth + upgrade rate
 * limit) is applied to EVERY accepted path before any `handleUpgrade`. Rejected
 * sockets are answered with an HTTP status and destroyed — they never emit
 * `connection` and never create session/terminal resources.
 *
 * Path dispatch (the "runtime routers") is intentionally kept here and narrow:
 * `/ws`, `/ws/sessions/:id` and `/ws/session/:id`, and `/ws/terminal`. Anything
 * else is destroyed.
 *
 * Extracted from `index.ts` so the guard + dispatch are unit/integration
 * testable without booting the whole server.
 */

import type { IncomingMessage } from 'http';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';
import { decideWsUpgrade, type WsUpgradeDecision } from '../security/websocket.js';
import { handleSessionWebSocket } from './session-websocket.js';
import { handleTerminalWebSocket } from '../terminal/terminal-websocket.js';
import { createLogger } from '../logging/logger.js';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';

const logger = createLogger('WebSocket');

export type SessionHandler = typeof handleSessionWebSocket;
export type TerminalHandler = typeof handleTerminalWebSocket;

export interface UpgradeDeps {
  /** The connection manager (or a test double) used to perform the upgrades. */
  wsManager: {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
    getWss(): {
      handleUpgrade(
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        cb: (ws: WebSocket) => void,
      ): void;
    };
    getMultiSessionManager(): MultiSessionManager;
  };
  /** Optional handler overrides (used by tests to observe invocation). */
  handlers?: {
    onSession?: SessionHandler;
    onTerminal?: TerminalHandler;
  };
  verbose?: boolean;
}

const REASON_PHRASE: Record<WsUpgradeDecision['reason'], string> = {
  origin: 'Not Allowed',
  auth: 'Unauthorized',
  rate: 'Too Many Requests',
  ok: 'OK',
};

function rejectUpgrade(socket: Duplex, decision: WsUpgradeDecision): void {
  try {
    socket.write(
      `HTTP/1.1 ${decision.statusCode} ${REASON_PHRASE[decision.reason]}\r\nConnection: close\r\n\r\n`,
    );
  } catch {
    // Socket may already be closed; destruction below is best-effort.
  }
  socket.destroy();
}

export function handleWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: UpgradeDeps,
): void {
  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Central pre-upgrade guard for every accepted path.
  const decision = decideWsUpgrade(req);
  if (!decision.allowed) {
    logger.info(`WebSocket upgrade rejected (${decision.reason}) for ${url.pathname}`);
    rejectUpgrade(socket, decision);
    return;
  }

  // Main WebSocket endpoint.
  if (url.pathname === '/ws') {
    deps.wsManager.handleUpgrade(req, socket, head);
    return;
  }

  // Per-session WebSocket endpoint: /ws/sessions/:sessionId or /ws/session/:sessionId
  const sessionMatch = url.pathname.match(/^\/ws\/sessions?\/([^/?]+)$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const multiSessionManager = deps.wsManager.getMultiSessionManager();
    deps.wsManager.getWss().handleUpgrade(req, socket, head, (ws) => {
      const onSession = deps.handlers?.onSession ?? handleSessionWebSocket;
      onSession(ws, req, sessionId, multiSessionManager, { verboseLogging: !!deps.verbose });
    });
    return;
  }

  // Terminal WebSocket endpoint.
  if (url.pathname === '/ws/terminal') {
    deps.wsManager.getWss().handleUpgrade(req, socket, head, (ws) => {
      const onTerminal = deps.handlers?.onTerminal ?? handleTerminalWebSocket;
      onTerminal(ws, req);
    });
    return;
  }

  // Unknown WebSocket path.
  socket.destroy();
}

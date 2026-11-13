/**
 * Shared proxy-key transport gate (security review 2026-11-12, finding 7).
 *
 * The server binds 0.0.0.0 and is reached legitimately only (a) through Caddy —
 * which connects from the Docker bridge (non-loopback) and sets X-Forwarded-For
 * itself — and (b) from loopback on this host. Before this gate any other
 * container on the bridge could connect directly and set X-Forwarded-For
 * freely, keying the login throttle's express `trust proxy` req.ip on a
 * spoofable address.
 *
 * The gate runs before every HTTP route and before every WebSocket upgrade:
 *   - socket peer (req.socket.remoteAddress — never req.ip or X-Forwarded-*)
 *     loopback → allowed exactly as before;
 *   - any other peer must present `x-pwu-proxy-key` equal to the shared key
 *     (crypto.timingSafeEqual on equal-length buffers; a single string header
 *     value only — duplicates are refused);
 *   - refusal: HTTP 403, and for upgrades a 403 line followed by socket
 *     destruction before any handshake is accepted.
 *
 * The key is read once at startup from the file named by
 * `PI_WEB_UI_PROXY_KEY_FILE` (trimmed). Missing, unreadable or empty fails
 * closed: every non-loopback peer is refused while loopback is unaffected. One
 * startup warning line is emitted; the key itself is never logged.
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('ProxyKey');

export const PROXY_KEY_HEADER = 'x-pwu-proxy-key';
export const PROXY_KEY_FILE_ENV = 'PI_WEB_UI_PROXY_KEY_FILE';

/** Test-only seam: how the socket peer is resolved. Production is always the socket. */
export type RemoteAddressResolver = (req: IncomingMessage) => string | undefined;

const socketPeerAddress: RemoteAddressResolver = (req) => req.socket?.remoteAddress;

function isV4Loopback(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  if (parts[0] !== '127') return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 127.0.0.0/8, ::1, or an IPv4-mapped ::ffff:127.x address. */
export function isLoopbackPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  const mapped = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : null;
  if (mapped !== null) return isV4Loopback(mapped);
  if (addr.includes(':')) return false;
  return isV4Loopback(addr);
}

/**
 * Read the shared key once at startup. Returns null — fail closed for every
 * non-loopback peer — when the path is unset/blank or the file is missing,
 * unreadable or empty after trimming. Emits exactly one warning line per call
 * in the failure cases; the key material is never passed to `warn`.
 */
export function loadProxyKey(
  keyFilePath: string | undefined,
  warn: (message: string) => void,
): Buffer | null {
  const fail = (reason: string): null => {
    warn(`[ProxyKey] ${reason}; refusing every non-loopback connection (loopback unaffected).`);
    return null;
  };
  const trimmedPath = keyFilePath?.trim();
  if (!trimmedPath) {
    return fail(`${PROXY_KEY_FILE_ENV} is not set`);
  }
  let raw: string;
  try {
    raw = readFileSync(trimmedPath, 'utf8');
  } catch {
    return fail(`cannot read ${PROXY_KEY_FILE_ENV} (${trimmedPath})`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return fail(`${PROXY_KEY_FILE_ENV} (${trimmedPath}) is empty`);
  }
  return Buffer.from(trimmed, 'utf8');
}

export interface ProxyKeyGuard {
  /** True when the socket peer is loopback or presents the shared key. */
  allow(req: IncomingMessage): boolean;
}

export interface ProxyKeyGuardOptions {
  /** Expected key bytes; null fails closed for every non-loopback peer. */
  key: Buffer | null;
  /** Test-only override of the socket-peer lookup. Never req.ip / X-Forwarded-*. */
  resolveRemoteAddress?: RemoteAddressResolver;
}

export function createProxyKeyGuard(options: ProxyKeyGuardOptions): ProxyKeyGuard {
  const resolve = options.resolveRemoteAddress ?? socketPeerAddress;
  const key = options.key;
  return {
    allow(req: IncomingMessage): boolean {
      if (isLoopbackPeer(resolve(req))) return true;
      if (!key) return false;
      const presented = req.headers[PROXY_KEY_HEADER];
      // A single string value only: an array (or any non-string) is refused.
      // On the wire Node also comma-joins duplicate headers, which then fail
      // the equality check below.
      if (typeof presented !== 'string') return false;
      const presentedBuffer = Buffer.from(presented, 'utf8');
      if (presentedBuffer.length !== key.length) return false;
      return timingSafeEqual(presentedBuffer, key);
    },
  };
}

/**
 * The guard the server itself uses, resolved once at module load (= startup):
 * the key file is read exactly once here and shared by every request.
 */
const sharedProxyKeyGuard: ProxyKeyGuard = createProxyKeyGuard({
  key: loadProxyKey(config.proxyKeyFile, (message) => logger.warn(message)),
});

/**
 * Express middleware installed before every route. Loopback peers pass
 * through; everyone else needs the shared key, else 403 with a short body.
 */
export function proxyKeyMiddleware(guard: ProxyKeyGuard = sharedProxyKeyGuard): RequestHandler {
  return (req, res, next) => {
    if (guard.allow(req)) {
      next();
      return;
    }
    res.status(403).type('text/plain').send('Forbidden');
  };
}

/**
 * Upgrade-time counterpart of {@link proxyKeyMiddleware}, called at the top of
 * the HTTP server's 'upgrade' handling before any WebSocket handshake is
 * accepted. A refused peer gets an HTTP 403 on the wire and its socket is
 * destroyed. Returns true when the upgrade may proceed.
 */
export function proxyKeyUpgradeAllowed(
  req: IncomingMessage,
  socket: Duplex,
  guard: ProxyKeyGuard = sharedProxyKeyGuard,
): boolean {
  if (guard.allow(req)) return true;
  try {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  } catch {
    // Socket may already be closed; destruction below is best-effort.
  }
  socket.destroy();
  return false;
}

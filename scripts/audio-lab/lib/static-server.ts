/**
 * A tiny lab-owned static file server.
 *
 * Browsers cannot load ES modules from `file://` (CORS), so the lab bundle has
 * to be served over HTTP. It is deliberately minimal: read-only, GET/HEAD only,
 * path-traversal refused, and bound to loopback on an ephemeral port. It serves
 * exactly one directory (the built lab bundle) and nothing else on the host.
 */

import { createServer, type Server } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

export interface StaticServer {
  origin: string;
  port: number;
  close(): Promise<void>;
}

/** Resolve a URL path inside `root`, refusing anything that escapes it. */
export function safeResolve(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) return null;
  return resolved;
}

export async function startStaticServer(root: string, port = 0): Promise<StaticServer> {
  const rootResolved = path.resolve(root);
  const server: Server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const target = safeResolve(rootResolved, request.url ?? '/');
    if (!target) {
      response.writeHead(400).end('bad path');
      return;
    }
    let stats;
    try {
      stats = statSync(target);
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    const file = stats.isDirectory() ? path.join(target, 'index.html') : target;
    let fileStats;
    try {
      fileStats = statSync(file);
    } catch {
      response.writeHead(404).end('not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(fileStats.size),
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Static server did not report a TCP address');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Locate the built lab page inside a bundle directory. */
export function labPagePath(bundleDir: string, htmlRelative = 'scripts/audio-lab/browser/lab.html'): string {
  return path.join(bundleDir, htmlRelative);
}

#!/usr/bin/env npx tsx
/**
 * Validation Logging Proxy
 *
 * A small, runtime-agnostic, SSE-safe logging reverse-proxy for live
 * validation. It sits between an agent runtime and its model provider so you
 * can SEE the actual wire requests — model id, reasoning effort, context-window
 * beta flags, endpoint — without trusting the transcript (which often omits
 * them, e.g. reasoning effort).
 *
 * It forwards every request unchanged to an upstream base URL and streams the
 * response back UNBUFFERED (so Server-Sent Events are not stalled), while
 * appending a redacted, structured JSONL line per request.
 *
 * It is provider-agnostic: it always captures method/path + an allowlisted set
 * of headers, and additionally extracts a configurable list of JSON body paths
 * (dot notation) so you can pull out whatever the provider calls "model" or
 * "effort". Secrets are never logged.
 *
 * ── Typical use ───────────────────────────────────────────────────────────────
 *   # 1. start the proxy in front of z.ai's Anthropic-compatible endpoint
 *   npm run validate:proxy -- \
 *     --upstream https://api.z.ai/api/anthropic \
 *     --port 8799 \
 *     --log /tmp/reqs.jsonl \
 *     --extract model,output_config.effort,thinking.type \
 *     --header-allowlist anthropic-beta
 *
 *   # 2. point the runtime at it. For a Claude profile, set the profile baseUrl
 *   #    (or ANTHROPIC_BASE_URL) to http://127.0.0.1:8799 — see the
 *   #    pi-web-ui-internal-api-orchestration skill for per-runtime recipes.
 *
 *   # 3. drive a prompt through the Internal API, then read /tmp/reqs.jsonl:
 *   #    {"ts":...,"model":"glm-5.2","output_config.effort":"high",
 *   #     "headers":{"anthropic-beta":"...context-1m-2025-08-07..."}}
 *
 * Tip: the proxy is for WIRE INSPECTION. You only need enough requests to
 * confirm the shape — capture, then abort the turn. Measure latency/completion
 * against the real endpoint WITHOUT the proxy.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import {
  createValidationLogWriter,
  sanitizeValidationCapture,
  sanitizeValidationExtract,
  sanitizeValidationRequestPath,
} from '../server/src/live-validation/validation-proxy-log.js';

// ─── Args ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const get = (flag: string, dflt?: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const upstream = get('--upstream');
  if (!upstream) {
    console.error('validation-logging-proxy: --upstream <url> is required');
    console.error('  e.g. --upstream https://api.z.ai/api/anthropic --port 8799 --log /tmp/reqs.jsonl');
    process.exit(2);
  }
  const log = get('--log') ?? '/tmp/validation-proxy-reqs.jsonl';
  const extract = get('--extract') ?? 'model,output_config.effort';
  const headerAllowlist = get('--header-allowlist') ?? 'anthropic-beta';
  if (argv.includes('--log-body')) {
    console.error('validation-logging-proxy: --log-body was removed; use --unsafe-log-redacted-body for bounded, recursively redacted capture');
    process.exit(2);
  }
  return {
    upstream,
    port: Number(get('--port') ?? '8799'),
    log,
    // Dot-path JSON fields to extract from request bodies (provider-agnostic).
    extract: extract.split(',').map((s) => s.trim()).filter(Boolean),
    // Request headers worth logging (e.g. provider beta flags). Never secrets.
    headerAllowlist: headerAllowlist.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Only paths containing this substring are body-parsed/extracted (others just pass through).
    pathFilter: get('--path-filter') ?? '',
    unsafeLogRedactedBody: argv.includes('--unsafe-log-redacted-body'),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Headers that must never be logged, regardless of allowlist. */
const SECRET_HEADERS = new Set([
  'authorization', 'x-api-key', 'anthropic-auth-token', 'proxy-authorization',
  'cookie', 'set-cookie', 'api-key', 'x-goog-api-key',
]);

/** Read a dot-path (supports numeric array indices) out of a parsed object. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ─── Main ───────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
let logWriter;
try {
  logWriter = createValidationLogWriter(args.log);
} catch (error) {
  console.error(`validation-logging-proxy: cannot open owner-only log ${args.log}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const upstreamUrl = new URL(args.upstream);
const upstreamClient = upstreamUrl.protocol === 'http:' ? http : https;
const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === 'http:' ? 80 : 443);
const upstreamBasePath = upstreamUrl.pathname.replace(/\/$/, ''); // no trailing slash

function logLine(obj: Record<string, unknown>): boolean {
  return logWriter.append(obj);
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const interesting = !args.pathFilter || (req.url ?? '').includes(args.pathFilter);

    if (interesting) {
      const entry: Record<string, unknown> = {
        ts: Date.now(),
        method: req.method,
        path: sanitizeValidationRequestPath(req.url),
      };
      // Allowlisted, non-secret headers only.
      const hdrs: Record<string, string> = {};
      for (const h of args.headerAllowlist) {
        if (SECRET_HEADERS.has(h)) continue;
        const v = req.headers[h];
        if (v != null) hdrs[h] = String(sanitizeValidationCapture(Array.isArray(v) ? v.join(',') : String(v), 1000));
      }
      if (Object.keys(hdrs).length) entry.headers = hdrs;
      // Extracted JSON body fields.
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        for (const p of args.extract) {
          const val = getPath(parsed, p);
          if (val !== undefined) entry[p] = sanitizeValidationExtract(p, val, 2000);
        }
        if (args.unsafeLogRedactedBody) {
          entry.body = sanitizeValidationCapture(parsed, 16 * 1024);
        }
      } catch {
        entry.nonJsonBytes = body.length;
      }
      if (!logLine(entry)) {
        res.writeHead(507, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('validation-logging-proxy: evidence log write failed');
        return;
      }
    }

    // ── Forward upstream, streaming the response UNBUFFERED ──────────────────
    const headers = { ...req.headers, host: upstreamUrl.host };
    const upReq = upstreamClient.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamPort,
        method: req.method,
        path: upstreamBasePath + (req.url ?? ''),
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        // SSE-safe: disable Nagle and stream each chunk straight through.
        res.socket?.setNoDelay(true);
        upRes.pipe(res);
      },
    );
    upReq.on('error', (e) => {
      logLine({
        ts: Date.now(),
        proxyError: sanitizeValidationCapture(e.message, 500),
        path: sanitizeValidationRequestPath(req.url),
      });
      if (!res.headersSent) res.writeHead(502);
      res.end('validation-logging-proxy: upstream error');
    });
    req.on('aborted', () => upReq.destroy());
    if (body.length) upReq.write(body);
    upReq.end();
  });
});

server.listen(args.port, '127.0.0.1', () => {
  console.error('────────────────────────────────────────────────────────');
  console.error(' Validation Logging Proxy');
  console.error(`   listening : http://127.0.0.1:${args.port}`);
  console.error(`   upstream  : ${args.upstream}`);
  console.error(`   log       : ${args.log}`);
  console.error(`   extract   : ${args.extract.join(', ')}`);
  console.error(`   headers   : ${args.headerAllowlist.join(', ') || '(none)'}`);
  console.error(' Point a runtime base URL here, drive a prompt, read the log.');
  console.error(' Stop with Ctrl-C.');
  console.error('────────────────────────────────────────────────────────');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      logWriter.close();
      process.exit(0);
    });
  });
}

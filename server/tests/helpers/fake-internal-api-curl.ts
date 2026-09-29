/**
 * A PATH `curl` stand-in for restart-script tests (B4).
 *
 * In this agent sandbox, connect() from any process spawned below the vitest
 * worker is blackholed (TCP and unix socket alike), so a spawned `curl` cannot
 * reach a fake Internal API. The scripts' HTTP conversation is therefore served
 * by this shim: it answers ONLY requests on the expected socket with the
 * expected bearer token, from a routes file keyed by `METHOD /path`, and logs
 * every invocation (argv + request body) for assertions. It honours the curl
 * flags the scripts use: --unix-socket, -H, -X, --data-binary/-d, -o, -w
 * '%{http_code}', --max-time, -s/-S. A route may also emulate a curl transport
 * failure (`curlExit`, e.g. 7 = could not connect, 28 = timed out).
 *
 * The real `curl --unix-socket` transport is production behaviour and is proven
 * by the disposable live validation, not here.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface FakeRoute {
  status?: number;
  body?: unknown;
  /** Emulate a curl transport failure with this exit code (no HTTP exchange). */
  curlExit?: number;
}

export interface FakeCurlRequest {
  argv: string[];
  method: string;
  path: string;
  body?: string;
  authorization?: string;
  socket?: string;
  maxTime?: string;
}

export interface FakeInternalApiCurl {
  binDir: string;
  env: Record<string, string>;
  setRoute(key: string, route: FakeRoute): void;
  requests(): FakeCurlRequest[];
}

export function installFakeInternalApiCurl(dir: string, options: { socketPath: string; token: string }): FakeInternalApiCurl {
  const binDir = path.join(dir, 'fake-curl-bin');
  const routesFile = path.join(dir, 'fake-curl-routes.json');
  const logFile = path.join(dir, 'fake-curl-requests.log');
  const routes: Record<string, FakeRoute> = {};
  const save = (): void => writeFileSync(routesFile, JSON.stringify(routes));
  save();
  mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, 'curl');
  writeFileSync(shim, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('node:fs');",
    'const argv = process.argv.slice(2);',
    'let method = "GET", body, out, writeOut, socket, auth, maxTime, url;',
    'for (let i = 0; i < argv.length; i++) {',
    '  const a = argv[i];',
    "  if (a === '-X') method = argv[++i];",
    "  else if (a === '--data-binary' || a === '-d' || a === '--data') { body = argv[++i]; if (method === 'GET') method = 'POST'; }",
    "  else if (a === '-o') out = argv[++i];",
    "  else if (a === '-w') writeOut = argv[++i];",
    "  else if (a === '--unix-socket') socket = argv[++i];",
    "  else if (a === '--max-time' || a === '-m') maxTime = argv[++i];",
    "  else if (a === '-H') { const h = argv[++i]; if (/^authorization:/i.test(h)) auth = h.replace(/^authorization:\\s*/i, ''); }",
    "  else if (a.startsWith('-')) { /* -s, -S, -f: no value */ }",
    '  else url = a;',
    '}',
    "const p = url ? new URL(url).pathname : '';",
    'fs.appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify({ argv, method, path: p, body, authorization: auth, socket, maxTime }) + "\\n");',
    'const routes = JSON.parse(fs.readFileSync(process.env.FAKE_CURL_ROUTES, "utf8"));',
    'if (socket !== process.env.FAKE_CURL_SOCKET || auth !== "Bearer " + process.env.FAKE_CURL_TOKEN) {',
    "  process.stderr.write('curl: (7) Failed to connect\\n'); process.exit(7);",
    '}',
    'const route = routes[method + " " + p];',
    "if (!route) { process.stderr.write('fake-curl: no route for ' + method + ' ' + p + '\\n'); process.exit(7); }",
    'if (route.curlExit) { process.stderr.write("curl: (" + route.curlExit + ") emulated failure\\n"); process.exit(route.curlExit); }',
    "const payload = route.body === undefined ? '' : (typeof route.body === 'string' ? route.body : JSON.stringify(route.body));",
    'if (out) fs.writeFileSync(out, payload); else process.stdout.write(payload);',
    "if (writeOut) process.stdout.write(writeOut.replace('%{http_code}', String(route.status ?? 200)));",
    'process.exit(0);',
    '',
  ].join('\n'));
  chmodSync(shim, 0o755);
  return {
    binDir,
    env: {
      FAKE_CURL_ROUTES: routesFile,
      FAKE_CURL_LOG: logFile,
      FAKE_CURL_SOCKET: options.socketPath,
      FAKE_CURL_TOKEN: options.token,
    },
    setRoute(key, route) { routes[key] = route; save(); },
    requests() {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeCurlRequest);
    },
  };
}

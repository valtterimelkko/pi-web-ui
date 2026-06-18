#!/usr/bin/env npx tsx
/**
 * Ephemeral validation server.
 *
 * Boots a fully isolated, disposable Pi Web UI server for live validation so an
 * agent can validate changes against a real runtime **without touching the
 * user's running server, web UI, or real session data**.
 *
 * Isolation:
 *  - separate port, Unix socket, and API token
 *  - separate session registry, watch dir, and Claude/Antigravity session dirs
 *    (all under a throwaway validation directory)
 *  - validation mode ON → session cleanup disabled and the real-session
 *    registry rebuild skipped, so booting can never delete real data
 *
 * Pi keeps its real agent dir (for auth/models); any Pi sessions created during
 * validation are ephemeral and should be deleted by the validator. Because
 * cleanup is disabled, nothing else is ever removed.
 *
 * Usage:
 *   npm run validate:server                 # boots, prints socket + token, stays up
 *   npm run validate:server -- --port 3092  # override the port
 * Then point a validator at the printed socket/token, e.g.:
 *   npm run validate:long-horizon -- --socket <sock> --token-path <token> ...
 * Stop it with Ctrl-C (or kill the process); the socket is cleaned up on exit.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

function getFlag(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const validationDir = getFlag('--dir')
  ?? process.env.PI_WEB_UI_VALIDATION_DIR
  ?? path.join(os.homedir(), '.pi-web-ui', 'validation');
const port = getFlag('--port') ?? process.env.PI_WEB_UI_VALIDATION_PORT ?? '3091';

mkdirSync(path.join(validationDir, 'watches'), { recursive: true });

const socketPath = path.join(validationDir, 'internal-api.sock');
const tokenPath = path.join(validationDir, 'internal-api-token');

// Set the isolation env BEFORE importing the server (config reads env at import).
Object.assign(process.env, {
  PI_WEB_UI_VALIDATION_MODE: 'true',
  PORT: port,
  INTERNAL_API_SOCKET_PATH: socketPath,
  INTERNAL_API_TOKEN_PATH: tokenPath,
  INTERNAL_API_WATCH_DIR: path.join(validationDir, 'watches'),
  SESSION_REGISTRY_PATH: path.join(validationDir, 'session-registry.json'),
  CLAUDE_SESSION_DIR: path.join(validationDir, 'claude-sessions'),
  ANTIGRAVITY_SESSION_DIR: path.join(validationDir, 'antigravity-sessions'),
});

console.error('────────────────────────────────────────────────────────');
console.error(' Pi Web UI — EPHEMERAL VALIDATION SERVER');
console.error(' (isolated & disposable; your real server is untouched)');
console.error('────────────────────────────────────────────────────────');
console.error(` port   : ${port}`);
console.error(` socket : ${socketPath}`);
console.error(` token  : ${tokenPath}`);
console.error(` dir    : ${validationDir}`);
console.error('');
console.error(' Point a validator at it, e.g.:');
console.error(`   npm run validate:long-horizon -- --socket ${socketPath} --token-path ${tokenPath} ...`);
console.error(' Stop with Ctrl-C.');
console.error('────────────────────────────────────────────────────────');

// Booting the server entry runs start() and registers its own SIGINT/SIGTERM
// shutdown (which unlinks the socket). Importing after env is set is what makes
// the isolation take effect. (No top-level await — tsx transforms to CJS.)
import('../server/src/index.js').catch((err) => {
  console.error('[validation-server] Failed to boot:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

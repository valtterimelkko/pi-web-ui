#!/usr/bin/env npx tsx
/**
 * Ephemeral validation server.
 *
 * Boots a fully isolated, disposable Pi Web UI server for live validation so an
 * agent can validate changes against a real runtime **without touching the
 * user's running server, web UI, or real session data**.
 *
 * Isolation:
 *  - separate port, Unix socket, API token, and runtime companion ports
 *  - separate session registry, watch/pin/run-receipt/notification dirs, and
 *    Claude/Antigravity session dirs (all under a throwaway validation directory)
 *  - validation mode ON → session cleanup disabled and the real-session
 *    registry rebuild skipped, so booting can never delete real data
 *
 * Pi keeps its real agent dir (for auth/models); any Pi sessions created during
 * validation are ephemeral and should be deleted by the validator. Because
 * cleanup is disabled, nothing else is ever removed. Notification opt-ins and
 * run receipts are isolated so validation cannot rehydrate production state.
 *
 * Usage:
 *   npm run validate:server                 # boots, prints socket + token, stays up
 *   npm run validate:server -- --port 3092  # override the port
 *   npm run validate:server -- --env-file .env.production --env-key GLM_CODING_PLAN_TOKEN
 * Then point a validator at the printed socket/token, e.g.:
 *   npm run validate:long-horizon -- --socket <sock> --token-path <token> ...
 * Stop it with Ctrl-C (or kill the process); the socket is cleaned up on exit.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  buildValidationIsolationEnv,
  loadValidationEnvFile,
  resolveValidationEnvFile,
  resolveValidationEnvKeys,
} from '../server/src/live-validation/validation-server-env.js';

function getFlag(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const validationArgs = process.argv.slice(2);
const validationEnvFile = resolveValidationEnvFile(validationArgs);
const validationEnvKeys = resolveValidationEnvKeys(validationArgs);
if (validationEnvFile) loadValidationEnvFile(validationEnvFile, validationEnvKeys);
if (!validationEnvFile && validationEnvKeys.length > 0) {
  throw new Error('--env-key requires --env-file (or PI_WEB_UI_VALIDATION_ENV_FILE).');
}

const validationDir = getFlag('--dir')
  ?? process.env.PI_WEB_UI_VALIDATION_DIR
  ?? path.join(os.homedir(), '.pi-web-ui', 'validation');
const port = getFlag('--port') ?? process.env.PI_WEB_UI_VALIDATION_PORT ?? '3091';
const claudeWsPort = getFlag('--claude-ws-port') ?? process.env.PI_WEB_UI_VALIDATION_CLAUDE_WS_PORT ?? '43110';
const claudeHookPort = getFlag('--claude-hook-port') ?? process.env.PI_WEB_UI_VALIDATION_CLAUDE_HOOK_PORT ?? '43111';
const opencodePort = getFlag('--opencode-port') ?? process.env.PI_WEB_UI_VALIDATION_OPENCODE_PORT ?? '44097';

for (const dir of [
  'watches',
  'pins',
  'run-receipts',
  'notifications',
  'pi-sessions',
  'workspace',
  'opencode-workspace',
  'claude-config',
  'claude-channel-plugin',
]) {
  mkdirSync(path.join(validationDir, dir), { recursive: true });
}

const isolationEnv = buildValidationIsolationEnv({
  validationDir,
  port,
  claudeWsPort,
  claudeHookPort,
  opencodePort,
});
const socketPath = path.join(validationDir, 'internal-api.sock');
const tokenPath = path.join(validationDir, 'internal-api-token');

// Set the isolation env BEFORE importing the server (config reads env at import).
// These assignments intentionally win over the shell, .env, and --env-file.
Object.assign(process.env, isolationEnv);

console.error('────────────────────────────────────────────────────────');
console.error(' Pi Web UI — EPHEMERAL VALIDATION SERVER');
console.error(' (isolated & disposable; your real server is untouched)');
console.error('────────────────────────────────────────────────────────');
console.error(` port        : ${port}`);
console.error(` socket      : ${socketPath}`);
console.error(` token       : ${tokenPath}`);
console.error(` dir         : ${validationDir}`);
console.error(` env file    : ${validationEnvFile ?? '(default .env only)'}`);
console.error(` env keys    : ${validationEnvKeys.join(', ') || '(none)'}`);
console.error(` claude ws   : ${claudeWsPort}`);
console.error(` claude hook : ${claudeHookPort}`);
console.error(` opencode    : ${opencodePort}`);
console.error('');
console.error(' Point a validator at it, e.g.:');
console.error(`   npm run validate:long-horizon -- --socket ${socketPath} --token-path ${tokenPath} ...`);
console.error(' Stop with Ctrl-C.');
console.error('────────────────────────────────────────────────────────');

// Some native dependencies inspect process.argv at import time. Keep validation
// server flags local to this wrapper so imported server modules don't interpret
// flags like --dir as their own options.
process.argv = process.argv.slice(0, 2);

// Booting the server entry runs start() and registers its own SIGINT/SIGTERM
// shutdown (which unlinks the socket). Importing after env is set is what makes
// the isolation take effect. (No top-level await — tsx transforms to CJS.)
import('../server/src/index.js').catch((err) => {
  console.error('[validation-server] Failed to boot:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

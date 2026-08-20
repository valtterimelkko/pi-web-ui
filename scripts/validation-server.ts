#!/usr/bin/env npx tsx
/**
 * Ephemeral validation server.
 *
 * Boots a disposable Pi Web UI server with its own socket, token, state dirs,
 * and runtime companion ports. A no-argument launch now creates a short unique
 * directory and selects available ports so concurrent agents cannot collide.
 */

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  buildValidationIsolationEnv,
  loadValidationEnvFile,
  resolveValidationEnvFile,
  resolveValidationEnvKeys,
} from '../server/src/live-validation/validation-server-env.js';
import { createCommandCodeValidationFixture } from '../server/src/live-validation/command-code-fixture.js';
import {
  acquireValidationDirectoryLock,
  assertSafeValidationDirectory,
  createDefaultValidationDirectory,
  reserveValidationPorts,
} from '../server/src/live-validation/validation-server-options.js';

function getFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function explicitPort(args: string[], flag: string, envName: string): number | undefined {
  const value = getFlag(args, flag) ?? process.env[envName];
  if (!value || value === '0') return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a whole-number port.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flag} must be an integer between 0 and 65535.`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const validationArgs = process.argv.slice(2);
  const validationEnvFile = resolveValidationEnvFile(validationArgs);
  const validationEnvKeys = resolveValidationEnvKeys(validationArgs);
  if (validationEnvFile) loadValidationEnvFile(validationEnvFile, validationEnvKeys);
  if (!validationEnvFile && validationEnvKeys.length > 0) {
    throw new Error('--env-key requires --env-file (or PI_WEB_UI_VALIDATION_ENV_FILE).');
  }

  const explicitDir = getFlag(validationArgs, '--dir') ?? process.env.PI_WEB_UI_VALIDATION_DIR;
  const validationDir = explicitDir
    ? path.resolve(explicitDir)
    : createDefaultValidationDirectory(path.join(os.tmpdir(), 'pi-web-ui-validation'));
  const commandCodeFixture = validationArgs.includes('--command-code-fixture');
  // Legacy alias from the deleted browser partition: still required for
  // cookie-authenticated UI driving, now with the single fixture CLI.
  const commandCodeBrowserFixture = validationArgs.includes('--command-code-browser-fixture');
  if (commandCodeBrowserFixture && !commandCodeFixture) {
    throw new Error('--command-code-browser-fixture requires --command-code-fixture.');
  }
  const commandCodeReal = validationArgs.includes('--command-code-real');
  if (commandCodeReal && commandCodeFixture) {
    throw new Error('--command-code-real and --command-code-fixture are mutually exclusive.');
  }
  const defaultStateRoot = path.join(os.homedir(), '.pi-web-ui');
  const productionFiles = [
    process.env.INTERNAL_API_SOCKET_PATH ?? path.join(defaultStateRoot, 'internal-api.sock'),
    process.env.INTERNAL_API_TOKEN_PATH ?? path.join(defaultStateRoot, 'internal-api-token'),
    process.env.SESSION_REGISTRY_PATH ?? path.join(defaultStateRoot, 'session-registry.json'),
  ];
  const productionDirs = [
    process.env.INTERNAL_API_WATCH_DIR ?? path.join(defaultStateRoot, 'watches'),
    process.env.INTERNAL_API_RUN_RECEIPTS_DIR ?? path.join(defaultStateRoot, 'run-receipts'),
    process.env.INTERNAL_API_PIN_DIR ?? path.join(defaultStateRoot, 'pins'),
    process.env.NOTIFICATIONS_DIR ?? path.join(defaultStateRoot, 'notifications'),
    process.env.CLAUDE_SESSION_DIR ?? path.join(defaultStateRoot, 'claude-sessions'),
    process.env.ANTIGRAVITY_SESSION_DIR ?? path.join(defaultStateRoot, 'antigravity-sessions'),
  ];
  assertSafeValidationDirectory(validationDir, [
    ...productionFiles,
    ...productionDirs.map((dir) => path.join(dir, '.production-state-marker')),
  ]);
  const directoryLock = acquireValidationDirectoryLock(validationDir);
  process.once('exit', () => directoryLock.release());
  if (!explicitDir) {
    process.once('exit', () => rmSync(validationDir, { recursive: true, force: true }));
  }
  // Defect 12 (Part 3): record the process identity so teardown can terminate
  // the WHOLE process group of a known pid. Terminating only the npm parent
  // orphaned the server's subprocesses in their process group on a supervised
  // host; broad command-line matching is explicitly not acceptable. The stopper
  // (scripts/validation-server-stop.mjs) reads this record.
  const processRecord = {
    pid: process.pid,
    pgid: (() => {
      try {
        // Linux: pgrp is field 5 of /proc/self/stat (after the comm field in parens).
        const stat = readFileSync('/proc/self/stat', 'utf8');
        const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
        const fields = afterComm.split(' ');
        const pgrp = Number(fields[2]);
        if (Number.isInteger(pgrp) && pgrp > 1) return pgrp;
      } catch { /* fall through */ }
      return process.pid;
    })(),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(validationDir, 'server-process.json'), `${JSON.stringify(processRecord, null, 2)}\n`, { mode: 0o600 });
  process.once('exit', () => { try { rmSync(path.join(validationDir, 'server-process.json'), { force: true }); } catch { /* best effort */ } });

  try {
    const portReservation = await reserveValidationPorts([
      explicitPort(validationArgs, '--port', 'PI_WEB_UI_VALIDATION_PORT'),
      explicitPort(validationArgs, '--claude-ws-port', 'PI_WEB_UI_VALIDATION_CLAUDE_WS_PORT'),
      explicitPort(validationArgs, '--claude-hook-port', 'PI_WEB_UI_VALIDATION_CLAUDE_HOOK_PORT'),
      explicitPort(validationArgs, '--opencode-port', 'PI_WEB_UI_VALIDATION_OPENCODE_PORT'),
    ], path.join(os.tmpdir(), 'pi-web-ui-validation-port-locks'));
    process.once('exit', () => portReservation.release());
    const [port, claudeWsPort, claudeHookPort, opencodePort] = portReservation.ports.map(String);

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
      mkdirSync(path.join(validationDir, dir), { recursive: true, mode: 0o700 });
    }

    if (commandCodeFixture) await createCommandCodeValidationFixture(validationDir);
    if (commandCodeBrowserFixture || commandCodeReal) {
      // Browser validation uses the same cookie-authenticated route as the UI.
      // The wrapper may inherit NODE_ENV=production from .env, so use a
      // disposable bcrypt hash rather than weakening production auth checks.
      process.env.AUTH_PASSWORD = '$2b$10$EJfE4MVDcyjSjCNpztQ74O/Y10CKuzAWexXatmlrSqY5yg5RY4C9u';
    }
    const isolationEnv = buildValidationIsolationEnv({
      validationDir,
      port,
      claudeWsPort,
      claudeHookPort,
      opencodePort,
      commandCodeFixture,
      commandCodeReal,
    });
    const socketPath = path.join(validationDir, 'internal-api.sock');
    const tokenPath = path.join(validationDir, 'internal-api-token');

    // Set isolation before importing the server: config reads env at import time.
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
    console.error(` commandcode : ${commandCodeFixture ? (commandCodeBrowserFixture ? 'fixture enabled (browser/UI auth)' : 'deterministic fixture enabled') : commandCodeReal ? 'REAL CLI enabled' : 'disabled'}`);
    console.error('');
    console.error(' Point a validator at it, e.g.:');
    console.error(`   npm run validate:long-horizon -- --socket ${socketPath} --token-path ${tokenPath} ...`);
    console.error(' Stop with Ctrl-C.');
    console.error('────────────────────────────────────────────────────────');

    // Imported native dependencies must not see this wrapper's flags.
    process.argv = process.argv.slice(0, 2);
    await import('../server/src/index.js');
  } catch (error) {
    directoryLock.release();
    throw error;
  }
}

main().catch((error) => {
  console.error('[validation-server] Failed to boot:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

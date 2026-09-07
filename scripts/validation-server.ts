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
import { mkdirSync, rmSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  // Supervised child state, assigned once the child is spawned inside the try
  // block below; the exit hooks consult it.
  let serverChild: ChildProcess | undefined;
  let preserveDir = false;
  if (!explicitDir) {
    process.once('exit', () => {
      // The implicit directory is disposable ONLY once nothing owned is left
      // running and no uncertain outcome needs its evidence. Deleting it while
      // descendants remain (or while the stop outcome is unverified) would
      // destroy the records recovery depends on.
      const childGroupStillRunning = serverChild?.pid !== undefined && groupHasLiveMembers(serverChild.pid);
      if (preserveDir || childGroupStillRunning) {
        console.error(
          `[validation-server] NOT removing validation directory (owned descendants remain or stop outcome unverified): ${validationDir}`,
        );
        return;
      }
      rmSync(validationDir, { recursive: true, force: true });
    });
  }
  // Defect 12 (Part 3) / capacity review 2026-09-07 §3: the identity record is
  // NOT written here. This wrapper runs inside the caller's npm/tsx process
  // group; recording any pid from this chain invited the old false-success
  // teardown (stopper probed a group that never existed and claimed "already
  // gone" while the listener stayed up). Instead the wrapper spawns the server
  // as a DETACHED child below: the child becomes the leader of a brand-new
  // process group, verifies that leadership via /proc, and only then writes
  // scripts/validation-server-stop.mjs's trusted record.

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
    console.error(' Stop with Ctrl-C (forwarded teardown), or from another shell:');
    console.error(`   node scripts/validation-server-stop.mjs --dir ${validationDir}`);
    console.error();
    console.error('────────────────────────────────────────────────────────');

    // The server runs as a DETACHED child: the spawn itself makes it the
    // leader of a brand-new process group that no wrapper, shell or caller
    // shares. The child verifies that leadership via /proc and writes the
    // identity record; this wrapper stays in the foreground as the signal
    // funnel so Ctrl-C keeps working, and forwards teardown through the
    // stopper — the single teardown authority with bounded TERM/KILL and
    // verification.
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    const stopperScript = path.join(scriptsDir, 'validation-server-stop.mjs');
    const childScript = path.join(scriptsDir, 'validation-server-child.ts');
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PI_WEB_UI_VALIDATION_SERVER_CHILD: '1',
      PI_WEB_UI_VALIDATION_RECORD_DIR: validationDir,
      PI_WEB_UI_VALIDATION_BOUND_PORT: port,
    };
    let child: ChildProcess;
    try {
      // The tsx loader runs in-process for this entry shape (single process,
      // like the previous single-file launcher), so the detached child IS the
      // group leader. Note Node's spawn() does not inherit execArgv — that is
      // a fork() behaviour — so no loader flags reach this child; an earlier
      // double-loader failure here came from the child loading tsx's
      // programmatic API itself, not from inherited flags.
      child = spawn(process.execPath, ['--import', 'tsx', childScript], { detached: true, stdio: 'inherit', env: childEnv });
    } catch (spawnError) {
      throw new Error(`Failed to spawn the dedicated validation server child: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`);
    }
    serverChild = child;
    let tearingDown = false;
    const forwardToStopper = (signal: NodeJS.Signals) => {
      if (tearingDown) return;
      tearingDown = true;
      try {
        if (child.pid === undefined) return;
        const stop = spawnSync(process.execPath, [stopperScript, '--dir', validationDir, '--timeout-ms', '8000'], { stdio: 'inherit' });
        if ((stop.status ?? 1) !== 0) {
          // The stopper could not act (e.g. SIGINT arrived before the child
          // wrote its record). Fall back to the ONE group this wrapper
          // unambiguously owns — the child it spawned detached — and VERIFY
          // the outcome instead of assuming it. An unverified outcome
          // preserves the validation directory's evidence.
          if (!boundedKillOwnedGroup(child.pid)) {
            preserveDir = true;
            console.error(
              `[validation-server] fallback teardown could not verify group ${child.pid} is gone — ` +
              `preserving ${validationDir} for investigation.`,
            );
          }
        }
      } finally {
        process.exit(128 + SIGNAL_EXIT_OFFSET[signal]);
      }
    };
    process.on('SIGINT', () => forwardToStopper('SIGINT'));
    process.on('SIGTERM', () => forwardToStopper('SIGTERM'));
    process.on('SIGHUP', () => forwardToStopper('SIGHUP'));
    child.once('exit', (code, signal) => {
      if (tearingDown) return;
      tearingDown = true;
      const exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGKILL' ? 137 : 1);
      if (child.pid !== undefined && groupHasLiveMembers(child.pid)) {
        // The child exited while owned descendants remain (crash, or a
        // TERM-ignoring helper outliving it): supervise them through this
        // wrapper's own authority, and preserve evidence on uncertainty.
        if (!boundedKillOwnedGroup(child.pid)) {
          preserveDir = true;
          console.error(
            `[validation-server] child exited with live group members (group ${child.pid}) that survived bounded cleanup — ` +
            `preserving ${validationDir} for investigation.`,
          );
        }
      }
      process.exit(exitCode);
    });
    child.once('error', (childError) => {
      if (tearingDown) return;
      tearingDown = true;
      preserveDir = true;
      console.error('[validation-server] dedicated server child failed:', childError);
      process.exit(1);
    });
  } catch (error) {
    directoryLock.release();
    throw error;
  }
}

const SIGNAL_EXIT_OFFSET: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/** Sleep without keeping the event loop involved — used only while tearing down. */
function blockingWait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Live non-zombie members of a process group, from the process table. */
function groupHasLiveMembers(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    const probe = spawnSync('ps', ['-e', '-o', 'pgid=,stat='], { encoding: 'utf8' });
    if (probe.status === 0) {
      return probe.stdout.split('\n').some((line) => {
        const match = line.trim().match(/^(\d+)\s+(\w+)/);
        return match !== null && Number(match[1]) === pgid && !/^[ZX]/.test(match[2]);
      });
    }
  } catch { /* fall through to the signal probe */ }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Bounded TERM→KILL for the one group this wrapper unambiguously owns: the
 * child it spawned detached. Returns whether the group is verifiably gone.
 */
function boundedKillOwnedGroup(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  const termDeadline = Date.now() + 2000;
  while (groupHasLiveMembers(pgid) && Date.now() < termDeadline) blockingWait(200);
  if (groupHasLiveMembers(pgid)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already gone */ }
    const killDeadline = Date.now() + 2000;
    while (groupHasLiveMembers(pgid) && Date.now() < killDeadline) blockingWait(100);
  }
  return !groupHasLiveMembers(pgid);
}

main().catch((error) => {
  console.error('[validation-server] Failed to boot:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Phase 0 fence fixture — INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md
 *
 * Emulates the 23 Sep incident shape: a foreign runtime (a tmux `pi` CLI in the
 * incident; this fixture here) holding the session lease from
 * pi-enhancement/auto-compact-75/session-ownership.mjs while the disposable
 * pi-web-ui validation server loads the same session.
 *
 * Usage:
 *   node fence-fixture.mjs --session-file <path> --lease-dir <dir> [--mode tui]
 *
 * Acquires the lease, heartbeats it every 10s (the extension's staleness
 * window is 30s), and holds until SIGTERM/SIGINT. Prints one JSON status line
 * on acquisition. Never touches the session file itself.
 */
import { acquireSessionLease, refreshSessionLease } from '/root/pi-enhancement/auto-compact-75/session-ownership.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionFile = arg('--session-file');
const leaseDir = arg('--lease-dir');
const mode = arg('--mode') ?? 'tui';
if (!sessionFile || !leaseDir) {
  console.error('usage: fence-fixture.mjs --session-file <path> --lease-dir <dir> [--mode tui]');
  process.exit(2);
}

const result = acquireSessionLease(sessionFile, {
  leaseDir,
  pid: process.pid,
  mode,
  extensionVersion: 'phase0-fixture',
  sourceFingerprint: 'phase0-fixture',
});
console.log(JSON.stringify({ event: 'acquire', result: { ...result, handle: undefined }, pid: process.pid, sessionFile, leaseDir }));
if (result.status !== 'owned') {
  console.error(`fixture: could not acquire lease: ${result.status} ${result.reason ?? ''}`);
  process.exit(1);
}

const handle = result.handle;
const heartbeat = setInterval(() => {
  const ok = refreshSessionLease(handle);
  console.log(JSON.stringify({ event: 'heartbeat', ok, at: new Date().toISOString() }));
}, 10_000);

const stop = () => {
  clearInterval(heartbeat);
  console.log(JSON.stringify({ event: 'exit', pid: process.pid }));
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

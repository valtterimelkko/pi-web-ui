import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Tripwire for the shared temporary directory's mode (the /tmp 0700 incident).
 *
 * A test must never change the mode of a directory it does not own. On
 * 2026-10-05, 10-16, 10-21 and 11-01 a suite left `/tmp` at 0700, which breaks
 * every agent and service on the host (nothing else can create files there).
 * The proven cause class: a lock/scratch path named directly inside a shared
 * directory, whose owner then applies `chmod 700` to its parent
 * (`scripts/with-production-lock.sh`; default path in `tests/setup-env.ts`).
 *
 * Vitest global setup runs this in the main process around the whole run: the
 * start mode is recorded, and a change fails the run with a message naming the
 * class rather than leaving the host broken and the culprit unnamed.
 */

/** Directory mode as a plain octal mask (e.g. 0o1777), or null if unreadable. */
export function readDirMode(dir: string): number | null {
  try {
    return statSync(dir).mode & 0o7777;
  } catch {
    return null;
  }
}

/** `0o1777` → `1777`, for messages a human reads. */
export function formatMode(mode: number): string {
  return mode.toString(8);
}

/**
 * The failure message for a mode change, or null when the mode is unchanged
 * (or could not be read at all, in which case this run cannot judge).
 */
export function tmpModeChangeMessage(dir: string, startMode: number | null, endMode: number | null): string | null {
  if (startMode === null || endMode === null || startMode === endMode) return null;
  return [
    `The shared temporary directory ${dir} changed mode from ${formatMode(startMode)} to ${formatMode(endMode)} during this test run.`,
    'A test changed the mode of a shared directory it does not own.',
    'Cause class: a lock or scratch directory owner applies "chmod 700" to its parent — scripts/with-production-lock.sh repairs the lock directory, and a lock path named directly inside a shared directory made that repair hit the shared directory itself (server/tests/setup-env.ts supplies the test default).',
    `Restore the mode (chmod ${formatMode(startMode)} ${dir}) and stop naming a lock path directly inside a shared directory.`,
  ].join(' ');
}

let startMode: number | null = null;

/** Vitest globalSetup: record the mode before any test body runs. */
export function setup(): void {
  startMode = readDirMode(tmpdir());
}

/** Vitest globalSetup teardown: fail the run if the shared directory moved. */
export function teardown(): void {
  const message = tmpModeChangeMessage(tmpdir(), startMode, readDirMode(tmpdir()));
  if (message) throw new Error(message);
}

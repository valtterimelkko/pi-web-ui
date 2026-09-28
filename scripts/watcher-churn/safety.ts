/**
 * Fail-closed guard for the B1.1 churn harness (review minor 7).
 *
 * The churn writes synthetic session JSONL files and persistent `churn-ws-*`
 * directories into whatever `--sessions-dir` it is given. A path mistake would
 * mutate production state and trigger the production watcher, so the CLI
 * refuses a protected root and requires positive evidence that the target is a
 * disposable validation directory — unless the caller passes an explicit
 * override.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Paths a churn run must never write into. */
export function protectedSessionRoots(homeDir = os.homedir()): string[] {
  return [
    path.join(homeDir, '.pi', 'agent', 'sessions'),
    path.join(homeDir, '.pi-web-ui'),
  ];
}

/** Markers the disposable validation server creates in its own directory. */
export const DISPOSABLE_MARKERS = ['.validation-server.lock', 'server-process.json'];

export interface DisposableDirOptions {
  maxAncestors?: number;
  /**
   * Directories a marker must never be accepted from. Defaults to the
   * filesystem root, the OS temp root and `$HOME` — a stray marker file in one
   * of those would otherwise turn the guard into a no-op for every path.
   */
  excludedDirs?: string[];
}

export function defaultExcludedMarkerDirs(sessionsDir: string): string[] {
  return [path.parse(path.resolve(sessionsDir)).root, os.tmpdir(), os.homedir()];
}

export function isDisposableValidationDir(sessionsDir: string, options: DisposableDirOptions = {}): boolean {
  const excluded = new Set(
    (options.excludedDirs ?? defaultExcludedMarkerDirs(sessionsDir)).map((dir) => path.resolve(dir)),
  );
  let dir = path.resolve(sessionsDir);
  for (let i = 0; i < (options.maxAncestors ?? 4); i += 1) {
    if (!excluded.has(dir) && DISPOSABLE_MARKERS.some((marker) => existsSync(path.join(dir, marker)))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Pure decision used by both the guard and its test: a protected root is always
 * refused; otherwise a disposable-validation marker must be present in an
 * ancestor, or the caller must explicitly override.
 */
export function checkSessionsDirSafety(input: {
  sessionsDir: string;
  homeDir?: string;
  allowUnsafe?: boolean;
  hasDisposableMarker: boolean;
}): SafetyVerdict {
  const resolved = path.resolve(input.sessionsDir);
  for (const root of protectedSessionRoots(input.homeDir ?? os.homedir())) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return { ok: false, reason: `refusing protected sessions dir ${resolved} (under ${root})` };
    }
  }
  if (input.allowUnsafe) return { ok: true };
  if (!input.hasDisposableMarker) {
    return {
      ok: false,
      reason:
        `refusing ${resolved}: no disposable-validation marker ` +
        `(${DISPOSABLE_MARKERS.join(' / ')}) found in an ancestor; ` +
        `pass --allow-unsafe-sessions-dir to override`,
    };
  }
  return { ok: true };
}

/** Throwing wrapper used by the CLI. */
export function assertSessionsDirSafe(sessionsDir: string, options: { allowUnsafe?: boolean } = {}): void {
  const verdict = checkSessionsDirSafety({
    sessionsDir,
    allowUnsafe: options.allowUnsafe,
    hasDisposableMarker: isDisposableValidationDir(sessionsDir),
  });
  if (!verdict.ok) throw new Error(verdict.reason);
}

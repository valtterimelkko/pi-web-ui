/**
 * Fail-closed guard for the B1.1 churn harness (review minors 7 and r2 major 2).
 *
 * The churn writes synthetic session JSONL files and persistent `churn-ws-*`
 * directories into whatever `--sessions-dir` it is given. A path mistake would
 * mutate production state and trigger the production watcher, so the CLI
 * refuses a protected root and requires positive evidence that the target is a
 * disposable validation directory — unless the caller passes an explicit
 * override.
 *
 * All decisions are made on **canonical (realpath) paths**: a symlink inside a
 * marked validation directory that points at a protected root must not pass
 * either check, and the resolved sessions directory must remain inside the
 * resolved validation directory that carries the marker.
 */
import { existsSync, realpathSync } from 'node:fs';
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

/**
 * Resolve symlinks as far as the path exists, then append the non-existent tail
 * lexically. `realpathSync` alone throws for a not-yet-created sessions dir.
 */
export function realpathWithMissingTail(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const resolved = realpathSync(current);
  return tail.length === 0 ? resolved : path.join(resolved, ...tail);
}

/**
 * The nearest ancestor (canonicalised) that carries a disposable marker and is
 * not an excluded directory. Returns undefined when there is none.
 */
export function findDisposableValidationRoot(
  sessionsDir: string,
  options: DisposableDirOptions = {},
): string | undefined {
  const excluded = new Set(
    (options.excludedDirs ?? defaultExcludedMarkerDirs(sessionsDir)).map(realpathWithMissingTail),
  );
  let dir = realpathWithMissingTail(sessionsDir);
  for (let i = 0; i < (options.maxAncestors ?? 4); i += 1) {
    if (!excluded.has(dir) && DISPOSABLE_MARKERS.some((marker) => existsSync(path.join(dir, marker)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function isDisposableValidationDir(sessionsDir: string, options: DisposableDirOptions = {}): boolean {
  return findDisposableValidationRoot(sessionsDir, options) !== undefined;
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface SafetyVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Pure decision over canonical paths (used by the guard and its tests). A
 * protected real target is always refused; otherwise the resolved sessions
 * directory must sit inside the resolved marker-carrying validation directory,
 * or the caller must explicitly override.
 */
export function checkSessionsDirSafety(input: {
  realSessionsDir: string;
  realProtectedRoots: string[];
  realDisposableRoot?: string;
  allowUnsafe?: boolean;
}): SafetyVerdict {
  const sessionsDir = path.resolve(input.realSessionsDir);
  for (const root of input.realProtectedRoots) {
    if (isWithin(sessionsDir, path.resolve(root))) {
      return { ok: false, reason: `refusing protected sessions dir ${sessionsDir} (under ${root})` };
    }
  }
  if (input.allowUnsafe) return { ok: true };
  if (!input.realDisposableRoot) {
    return {
      ok: false,
      reason:
        `refusing ${sessionsDir}: no disposable-validation marker ` +
        `(${DISPOSABLE_MARKERS.join(' / ')}) found in an ancestor; ` +
        `pass --allow-unsafe-sessions-dir to override`,
    };
  }
  if (!isWithin(sessionsDir, path.resolve(input.realDisposableRoot))) {
    return {
      ok: false,
      reason:
        `refusing ${sessionsDir}: resolved target is outside the marked ` +
        `disposable validation directory ${input.realDisposableRoot}`,
    };
  }
  return { ok: true };
}

/** Throwing wrapper used by the CLI. `protectedRoots` is a test seam. */
export function assertSessionsDirSafe(
  sessionsDir: string,
  options: { allowUnsafe?: boolean; protectedRoots?: string[] } = {},
): void {
  const realSessionsDir = realpathWithMissingTail(sessionsDir);
  const realProtectedRoots = (options.protectedRoots ?? protectedSessionRoots()).map(realpathWithMissingTail);
  const realDisposableRoot = findDisposableValidationRoot(sessionsDir);
  const verdict = checkSessionsDirSafety({
    realSessionsDir,
    realProtectedRoots,
    realDisposableRoot,
    allowUnsafe: options.allowUnsafe,
  });
  if (!verdict.ok) throw new Error(verdict.reason);
}

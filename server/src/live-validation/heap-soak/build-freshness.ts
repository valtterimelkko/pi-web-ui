/**
 * Stale-`dist` guard (B0.1 defect 1).
 *
 * The heap-soak launcher runs `server/dist` (`scripts/validation-server.ts
 * --compiled`) from the checkout the harness lives in. Wave 1 lost a soak to a
 * pre-fix `dist`: the run looked leaky because the build predated the fix, and
 * nothing checked. This is the pure decision; the caller gathers the facts
 * (compiled artefact mtimes, `git log -1 --format=%ct -- server/src shared/src`,
 * `git status --porcelain -- server/src shared/src`) with real I/O.
 *
 * A build is fresh only when ALL of:
 *   - a compiled artefact exists;
 *   - `server/src` and `shared/src` have no uncommitted changes;
 *   - the newest commit touching those trees is at or before the build's mtime.
 *
 * `checkBuildFreshness` refuses (never warns) when any of these cannot be
 * established: an unverifiable build is treated as stale, because the whole
 * point of the guard is to not trust a `dist` this process did not build.
 */

/** The compiled artefacts whose mtimes must be current (relative to the repo root). */
export const COMPILED_ARTEFACT_PATHS = ['server/dist/index.js', 'shared/dist/index.js'] as const;

/** The source trees whose newest commit must predate the compiled artefacts. */
export const WATCHED_SOURCE_TREES = ['server/src', 'shared/src'] as const;

export interface BuildFreshnessInput {
  /** Epoch ms of the OLDEST compiled artefact mtime, or undefined when no artefact exists. */
  compiledMtimeMs?: number;
  /** Epoch ms of the newest commit touching the watched source trees (git `%ct` × 1000), when readable. */
  newestSourceCommitMs?: number;
  /** true when `git status --porcelain` reported changes under the watched source trees. */
  sourceTreeDirty: boolean;
}

export interface BuildFreshness {
  fresh: boolean;
  reason: string;
}

/** The record persisted in run-state.json and rendered at the top of report.md. */
export interface BuildRecord {
  /** `git rev-parse HEAD` of the checkout the run's `dist` came from. */
  headSha?: string;
  /** `git log -1 --format=%ct` (× 1000) for `server/src shared/src`. */
  newestSourceCommitMs?: number;
  /** SHA of that newest commit touching the watched source trees, when known. */
  newestSourceCommitSha?: string;
  /** Oldest compiled-artefact mtime (ms). */
  compiledMtimeMs?: number;
  /** Whether `server/src` or `shared/src` was dirty at check time. */
  sourceTreeDirty: boolean;
  /** ISO timestamp the check ran. */
  checkedAt: string;
  /** Human-readable result, e.g. why a run was refused. */
  reason: string;
  fresh: boolean;
}

function formatMs(ms: number | undefined): string {
  return ms === undefined ? 'unknown' : new Date(ms).toISOString();
}

export function checkBuildFreshness(input: BuildFreshnessInput): BuildFreshness {
  const trees = WATCHED_SOURCE_TREES.join(', ');
  const artefacts = COMPILED_ARTEFACT_PATHS.join(', ');
  if (input.compiledMtimeMs === undefined) {
    return {
      fresh: false,
      reason: `no compiled build found at ${artefacts} — run \`npm run build\` in this checkout before starting a soak`,
    };
  }
  if (input.sourceTreeDirty) {
    return {
      fresh: false,
      reason: `${trees} has uncommitted changes — the compiled ${artefacts} cannot be trusted; commit or stash them and run \`npm run build\``,
    };
  }
  if (input.newestSourceCommitMs === undefined) {
    return {
      fresh: false,
      reason: `could not read git history for ${trees} — build freshness cannot be verified; run \`npm run build\` after checking the checkout's git state`,
    };
  }
  if (input.compiledMtimeMs < input.newestSourceCommitMs) {
    return {
      fresh: false,
      reason: `${artefacts} (built ${formatMs(input.compiledMtimeMs)}) is older than the newest commit touching ${trees} (${formatMs(input.newestSourceCommitMs)}) — a stale build makes the run untrustworthy; run \`npm run build\``,
    };
  }
  return {
    fresh: true,
    reason: `${artefacts} (built ${formatMs(input.compiledMtimeMs)}) is newer than the newest commit touching ${trees} (${formatMs(input.newestSourceCommitMs)})`,
  };
}

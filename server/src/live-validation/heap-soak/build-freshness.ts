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
 *   - every listed compiled artefact exists;
 *   - `server/src` and `shared/src` have no uncommitted changes (positively established);
 *   - the newest commit touching those trees is at or before the build's mtime.
 *
 * `checkBuildFreshness` refuses (never warns) when any of these cannot be
 * established: an unverifiable build is treated as stale, because the whole
 * point of the guard is to not trust a `dist` this process did not build.
 *
 * **Heuristic, not proof (review item 7).** The comparison is between the
 * compiled-artefact mtime and the newest commit's committer time (`%ct`,
 * second resolution). It catches the case that motivated it — a `dist` built
 * before a later `server/src`/`shared/src` commit — and a dirty tree. It is not
 * build provenance: a `dist` built from modified files inside the same second,
 * a backdated commit, or an mtime copied from elsewhere defeats it. A stronger
 * identity (embedded build-manifest source hash) would need a build-script
 * change, which this step excludes, so the heuristic is documented here, in the
 * harness README and in the evidence bundle.
 */

/** The compiled artefacts whose mtimes must be current (relative to the repo root). */
export const COMPILED_ARTEFACT_PATHS = ['server/dist/index.js', 'shared/dist/index.js'] as const;

/** The source trees whose newest commit must predate the compiled artefacts. */
export const WATCHED_SOURCE_TREES = ['server/src', 'shared/src'] as const;

export interface BuildFreshnessInput {
  /** Epoch ms of the OLDEST compiled artefact mtime, or undefined when no artefact exists. */
  compiledMtimeMs?: number;
  /** Listed artefacts that do not exist (review item 6): any one refuses the run. */
  compiledMissing?: readonly string[];
  /** Epoch ms of the newest commit touching the watched source trees (git `%ct` × 1000), when readable. */
  newestSourceCommitMs?: number;
  /** true when `git status --porcelain` reported changes under the watched source trees. */
  sourceTreeDirty: boolean;
  /** false when `git status` could not be read at all — unknown cleanliness refuses (review item 5). */
  sourceTreeStateKnown: boolean;
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
  /** Listed compiled artefacts that are absent (review item 6). */
  compiledMissing?: string[];
  /** Whether `server/src` or `shared/src` was dirty at check time. */
  sourceTreeDirty: boolean;
  /** false when `git status` could not be read (so cleanliness is unknown, not clean). */
  sourceTreeStateKnown: boolean;
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
  const missing = input.compiledMissing ?? [];
  if (missing.length > 0) {
    return {
      fresh: false,
      reason: `missing compiled artefact(s): ${missing.join(', ')} — every one of ${artefacts} is required; run \`npm run build\` in this checkout before starting a soak`,
    };
  }
  if (input.compiledMtimeMs === undefined) {
    return {
      fresh: false,
      reason: `no compiled build found at ${artefacts} — run \`npm run build\` in this checkout before starting a soak`,
    };
  }
  if (!input.sourceTreeStateKnown) {
    return {
      fresh: false,
      reason: `could not read \`git status\` for ${trees} — their cleanliness is unknown, and an unverified tree is not a clean one; check the checkout's git state and run \`npm run build\``,
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

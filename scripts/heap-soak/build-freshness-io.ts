/**
 * Real-I/O half of the stale-`dist` guard (B0.1 defect 1): gather the git and
 * filesystem facts from a checkout and hand them to the pure
 * `checkBuildFreshness` decision. Read-only; never builds or mutates.
 */
import { execFile as execFileCb } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  COMPILED_ARTEFACT_PATHS,
  WATCHED_SOURCE_TREES,
  checkBuildFreshness,
  type BuildRecord,
} from '../../server/src/live-validation/heap-soak/build-freshness.js';

const execFile = promisify(execFileCb);

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['-C', root, ...args], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Oldest existing compiled-artefact mtime (ms) plus any listed artefact that is absent. */
function inspectCompiledArtefacts(root: string): { mtimeMs?: number; missing: string[] } {
  const mtimes: number[] = [];
  const missing: string[] = [];
  for (const rel of COMPILED_ARTEFACT_PATHS) {
    try {
      mtimes.push(statSync(path.join(root, rel)).mtimeMs);
    } catch {
      missing.push(rel);
    }
  }
  return { ...(mtimes.length > 0 ? { mtimeMs: Math.min(...mtimes) } : {}), missing };
}

/**
 * Inspect the checkout at `root`: HEAD, the newest commit touching
 * `server/src`/`shared/src` (with its committer timestamp), whether those
 * trees are dirty, and the oldest compiled-artefact mtime. The returned record
 * is what run-state.json and report.md carry.
 */
export async function inspectCheckoutBuild(root: string): Promise<BuildRecord> {
  const [headSha, newestLog, status] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['log', '-1', '--format=%ct%n%H', '--', ...WATCHED_SOURCE_TREES]),
    git(root, ['status', '--porcelain', '--', ...WATCHED_SOURCE_TREES]),
  ]);

  let newestSourceCommitMs: number | undefined;
  let newestSourceCommitSha: string | undefined;
  if (newestLog) {
    const [ct, sha] = newestLog.split('\n');
    const seconds = Number(ct);
    if (Number.isFinite(seconds) && seconds > 0) newestSourceCommitMs = seconds * 1000;
    newestSourceCommitSha = sha || undefined;
  }

  const compiled = inspectCompiledArtefacts(root);
  // Correction 03 item 5: a `git status` we could not read means the tree's
  // cleanliness is UNKNOWN, and unknown must refuse — never fall back to
  // "clean" (or to the misleading "dirty" refusal).
  const sourceTreeStateKnown = status !== undefined;
  const sourceTreeDirty = status !== undefined && status.length > 0;
  const freshness = checkBuildFreshness({
    ...(compiled.mtimeMs !== undefined ? { compiledMtimeMs: compiled.mtimeMs } : {}),
    ...(compiled.missing.length > 0 ? { compiledMissing: compiled.missing } : {}),
    ...(newestSourceCommitMs !== undefined ? { newestSourceCommitMs } : {}),
    sourceTreeDirty,
    sourceTreeStateKnown,
  });

  return {
    ...(headSha ? { headSha } : {}),
    ...(newestSourceCommitMs !== undefined ? { newestSourceCommitMs } : {}),
    ...(newestSourceCommitSha ? { newestSourceCommitSha } : {}),
    ...(compiled.mtimeMs !== undefined ? { compiledMtimeMs: compiled.mtimeMs } : {}),
    ...(compiled.missing.length > 0 ? { compiledMissing: compiled.missing } : {}),
    sourceTreeDirty,
    sourceTreeStateKnown,
    checkedAt: new Date().toISOString(),
    reason: freshness.reason,
    fresh: freshness.fresh,
  };
}

/** Throw a start-refusing error when the checkout's build is not fresh (never a warning). */
export function assertFreshBuild(build: BuildRecord): void {
  if (!build.fresh) {
    throw new Error(`refusing to start the soak on a stale or unverifiable build: ${build.reason}`);
  }
}

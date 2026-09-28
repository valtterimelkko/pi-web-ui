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

/** Oldest existing compiled-artefact mtime (ms), or undefined when none exists. */
function oldestCompiledMtimeMs(root: string): number | undefined {
  const mtimes: number[] = [];
  for (const rel of COMPILED_ARTEFACT_PATHS) {
    try {
      mtimes.push(statSync(path.join(root, rel)).mtimeMs);
    } catch { /* missing artefact: the pure check refuses when none exist */ }
  }
  return mtimes.length === 0 ? undefined : Math.min(...mtimes);
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

  const compiledMtimeMs = oldestCompiledMtimeMs(root);
  // A `git status` we could not read is not evidence of a clean tree, but
  // treating it as dirty would hide the more honest "git history unreadable"
  // refusal; the pure check covers the both-unreadable case explicitly.
  const sourceTreeDirty = status !== undefined && status.length > 0;
  const freshness = checkBuildFreshness({ compiledMtimeMs, newestSourceCommitMs, sourceTreeDirty });

  return {
    ...(headSha ? { headSha } : {}),
    ...(newestSourceCommitMs !== undefined ? { newestSourceCommitMs } : {}),
    ...(newestSourceCommitSha ? { newestSourceCommitSha } : {}),
    ...(compiledMtimeMs !== undefined ? { compiledMtimeMs } : {}),
    sourceTreeDirty,
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

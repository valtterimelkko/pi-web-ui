/**
 * Child OOM score reset (lane oom). The service runs with `OOMScoreAdjust=-500`
 * (deploy drop-in 62-d0-placement.conf) and every forked child inherits it — so
 * under memory pressure the kernel once picked the single largest task at that
 * score: the control plane's own main process (the 2026-11-10 OOM kill).
 *
 * Every child-runtime process the server spawns is reset to 0 — the same value
 * the placement wrapper writes for placed commands — right after spawn, so its
 * whole descendant tree is a normal victim while the server keeps -500. Placed
 * spawns already reset inside the wrapper; this write is idempotent for them.
 * The drop-in's rule still holds: OOMScoreAdjust is never installed without
 * placement, and this helper only ever LOWERS a child's protection, never the
 * server's own.
 *
 * Fail-open by contract: a failed write is logged once per call site and never
 * fails the spawn.
 */
import fs from 'node:fs';
import { createLogger } from './logging/logger.js';

const logger = createLogger('OomScoreAdj');

/** The oom_score_adj every spawned child-runtime process is reset to. */
export const CHILD_OOM_SCORE_ADJ = '0';

export interface ChildPidHandle {
  pid?: number;
}

export interface ChildOomScoreAdjDeps {
  /** Writes the score file (default fs.writeFileSync). */
  writeScore?: (path: string, value: string) => void;
  /** Score-file path for a pid (default `/proc/<pid>/oom_score_adj`). */
  scoreFilePath?: (pid: number) => string;
  /** Warning sink (default logger.warn). */
  warn?: (message: string) => void;
}

/** Call-site labels that already logged a failed write (the "logged once" latch). */
const loggedSites = new Set<string>();

export function childOomScoreFilePath(pid: number): string {
  return `/proc/${pid}/oom_score_adj`;
}

/**
 * Reset one spawned child's oom_score_adj to {@link CHILD_OOM_SCORE_ADJ}.
 * Returns true when the write landed; false when there was no pid or the
 * write failed (fail-open: the failure is logged once per `site` label and
 * the spawn is never affected).
 */
export function applyChildOomScoreAdj(
  child: ChildPidHandle | null | undefined,
  site: string,
  deps: ChildOomScoreAdjDeps = {},
): boolean {
  const pid = child?.pid;
  if (typeof pid !== 'number' || pid <= 0) return false;
  const writeScore = deps.writeScore ?? ((p: string, v: string) => { fs.writeFileSync(p, v); });
  const scoreFilePath = deps.scoreFilePath ?? childOomScoreFilePath;
  try {
    writeScore(scoreFilePath(pid), CHILD_OOM_SCORE_ADJ);
    return true;
  } catch (error) {
    if (!loggedSites.has(site)) {
      loggedSites.add(site);
      const warn = deps.warn ?? ((message: string) => logger.warn(message));
      warn(`oom_score_adj reset failed for ${site} child pid ${pid} (child keeps its inherited score): ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

/** Test seam: clears the once-per-site warning latch. */
export function resetChildOomScoreAdjWarnings(): void {
  loggedSites.clear();
}

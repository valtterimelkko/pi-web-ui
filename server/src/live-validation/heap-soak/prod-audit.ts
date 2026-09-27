/**
 * Production-write audit (owner amendment 2026-09-26, board-pollution
 * incident; attribution corrected at B0): a file changing under a guarded
 * production root is NOT itself proof of harness interference — these hosts
 * see real, ambient traffic (see isolation.ts's session-registry.json finding).
 * The precise proof is: a file that changed DURING the run and whose content
 * references a marker ONLY a soak child emits — the child's isolated workspace
 * path (`<runDir>/children/<lane>-<id>`, the child's cwd) or one of its
 * server-issued child session ids.
 *
 * B0 defect 5: neither the bare run id NOR the bare run-dir path is a marker.
 * Both appear in operator sessions, orchestration logs (e.g. the harness's own
 * bg-task logs) and Agent OS captures that merely DISCUSS the run. The child
 * workspace path is emitted by a soak child's own cwd; a file that mentions
 * only the run dir is not flagged.
 *
 * File discovery (`find -newer`) and content grep are I/O
 * (scripts/heap-soak/prod-audit-io.ts); this module is the pure decision logic,
 * kept unit-testable.
 */
import path from 'node:path';

export interface NeedleMatch {
  path: string;
  needle: string;
}

/** Pure: given already-read file contents and a set of needles, find which files reference the run. */
export function findNeedleMatches(
  changedFiles: readonly { path: string; content: string }[],
  needles: readonly string[],
): NeedleMatch[] {
  const usableNeedles = needles.filter((n) => n && n.length >= 4); // guard against a trivially short needle matching everything
  const matches: NeedleMatch[] = [];
  for (const file of changedFiles) {
    for (const needle of usableNeedles) {
      if (file.content.includes(needle)) {
        matches.push({ path: file.path, needle });
        break; // one match per file is enough to flag it
      }
    }
  }
  return matches;
}

/**
 * Build the needle list for a run: the child workspace path (which only a soak
 * child's cwd uses) and every child session id created so far. Neither the bare
 * run id nor the bare run-dir path is included — see the module doc comment.
 */
export function buildAuditNeedles(runDir: string, sessionIds: readonly string[]): string[] {
  return [path.join(runDir, 'children'), ...sessionIds];
}

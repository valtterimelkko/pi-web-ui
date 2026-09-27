/**
 * Production-write audit (owner amendment 2026-09-26, board-pollution
 * incident; attribution corrected at B0): a file changing under a guarded
 * production root is NOT itself proof of harness interference — these hosts
 * see real, ambient traffic (see isolation.ts's session-registry.json finding).
 * The precise proof is: a file that changed DURING the run and whose content
 * references a marker ONLY a soak child emits — the run's isolated cwd/run dir
 * path, or one of its server-issued child session ids.
 *
 * B0 defect 5: the bare run id is deliberately NOT a marker. It appears in
 * operator sessions, Agent OS captures and reports that merely DISCUSS the run,
 * which produced seven false "LEAK DETECTED" hits in A1. A genuine
 * soak-attributable write carries the isolated cwd path or a session id.
 *
 * File discovery (`find -newer`) and content grep are I/O
 * (scripts/heap-soak/prod-audit-io.ts); this module is the pure decision logic,
 * kept unit-testable.
 */

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
 * Build the needle list for a run: its isolated run-dir path (which only soak
 * children's cwd/workspace uses) and every child session id created so far.
 * The bare run id is intentionally excluded — see the module doc comment.
 */
export function buildAuditNeedles(runDir: string, sessionIds: readonly string[]): string[] {
  return [runDir, ...sessionIds];
}

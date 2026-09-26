/**
 * Production-write audit (owner amendment 2026-09-26, board-pollution
 * incident): a file changing under a guarded production root is NOT itself
 * proof of harness interference — these hosts see real, ambient traffic (see
 * isolation.ts's session-registry.json finding). The precise proof is:
 * a file that changed DURING the run and whose content references this run
 * (its run id, run dir, or one of its child session ids). File discovery
 * (`find -newer`) and content grep are I/O (scripts/heap-soak/prod-audit-io.ts);
 * this module is the pure decision logic, kept unit-testable.
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

/** Build the needle list for a run: its id, its run dir, and every child session id created so far. */
export function buildAuditNeedles(runId: string, runDir: string, sessionIds: readonly string[]): string[] {
  return [runId, runDir, ...sessionIds];
}

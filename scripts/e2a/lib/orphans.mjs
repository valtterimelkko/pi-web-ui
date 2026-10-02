// E2a-3 harness — orphan reconciliation + cgroup parsing (arm 4) and disposable-topology unit builders.

/** Extract the cgroup v2 unified hierarchy path from /proc/<pid>/cgroup content. */
export function parseProcCgroupPath(text) {
  for (const line of String(text ?? '').split('\n')) {
    const m = /^0::(.+)$/.exec(line.trim());
    if (m) return m[1];
  }
  throw new Error('no 0:: (unified hierarchy) line in cgroup file');
}

/** Parse a cgroup.procs file into a pid array. */
export function parseCgroupProcs(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

/**
 * Diff placed-process snapshots taken before and after an event.
 * before/after: { cgroupPath: [pid, …] }. Returns stillAlive, gone, newcomers.
 */
export function reconcileSurvivors(before, after) {
  const beforeSet = new Map(Object.entries(before).flatMap(([g, pids]) => pids.map((p) => [p, g])));
  const afterSet = new Map(Object.entries(after).flatMap(([g, pids]) => pids.map((p) => [p, g])));
  const stillAlive = [];
  const gone = [];
  const newcomers = [];
  for (const [pid] of afterSet) {
    if (beforeSet.has(pid)) stillAlive.push(pid);
    else newcomers.push(pid);
  }
  for (const [pid] of beforeSet) {
    if (!afterSet.has(pid)) gone.push(pid);
  }
  return { stillAlive, gone, newcomers };
}

/** What the next server start's placement sweep did to the orphaned pids (D0.md §9). */
export function interpretSweepEffect({ orphanedBeforeRestart, presentAfterRestart }) {
  const after = new Set(presentAfterRestart);
  const swept = [];
  const survived = [];
  for (const pid of orphanedBeforeRestart) {
    if (after.has(pid)) survived.push(pid);
    else swept.push(pid);
  }
  return { swept, survived };
}

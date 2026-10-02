// E2a-3 harness — OOM victim ranking (arm 2a) and contained-OOM interpretation (arm 2b).

/** Parse an oom_score / oom_score_adj file value. */
export function parseOomScoreFile(text) {
  const trimmed = String(text ?? '').trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`not an integer oom score value: ${JSON.stringify(text)}`);
  return Number(trimmed);
}

/**
 * Rank OOM candidates the way the kernel's oom_badness() picks victims:
 * highest oom_score first (oom_score already folds in oom_score_adj);
 * ties broken by the raw oom_score_adj (higher wins). Input is NOT mutated.
 */
export function rankCandidates(entries) {
  return [...entries].sort((a, b) => (b.oomScore - a.oomScore) || (b.oomScoreAdj - a.oomScoreAdj));
}

export function pickVictim(ranked) {
  return ranked[0];
}

/** Parse a cgroup v2 memory.events file into {high, max, oom, oom_kill, …}. */
export function parseMemoryEvents(text) {
  const events = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(\S+)\s+(\d+)$/.exec(line.trim());
    if (m) events[m[1]] = Number(m[2]);
  }
  return events;
}

/**
 * Verdict for arm 2b: two self-capped allocators inside one MemoryMax-capped
 * unit (MemorySwapMax=0, OOMPolicy=continue) — the 0-score allocator must be
 * killed (exit 137 = SIGKILL), the -500 allocator must survive, the kernel
 * must have recorded an oom_kill, and the unit must still be active.
 */
export function interpretOomProof({ lowAdjProcessAlive, zeroAdjProcessExitCode, unitOomKills, unitActiveAfter }) {
  const failures = [];
  if (!lowAdjProcessAlive) failures.push('the -500 (control-plane-role) allocator did not survive');
  if (zeroAdjProcessExitCode !== 137) failures.push(`the 0-score (placed-tool-role) allocator exit was ${zeroAdjProcessExitCode}, not 137 (SIGKILL)`);
  if (!(unitOomKills >= 1)) failures.push('unit memory.events shows no oom_kill');
  if (!unitActiveAfter) failures.push('unit not active after the contained OOM (OOMPolicy=continue did not hold)');
  return { pass: failures.length === 0, failures };
}

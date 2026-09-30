/**
 * D0 measured sizing (plan 01-answer.md amendment A): the heaviest ordinary command
 * class on this host — the full Pi Web UI server unit suite (`tests/unit`) and
 * `npm run build` — run inside a placed cgroup on the disposable `d0-sizing` unit
 * (Delegate=yes, MemoryMax=24G, CPUQuota=400%, Nice=10; no per-child limits set:
 * this run measures, it does not bound).
 *
 * Recorded numbers (group `sized`, cgroup v2 `memory.peak` / `pids.peak`):
 *  - after the unit suite: memory.peak = <FILL>, pids.peak = <FILL>
 *  - after the build:      memory.peak = <FILL>, pids.peak = <FILL>
 * (filled by the sizing run; see D0.md for the receipts)
 *
 * Amendment A decision rule (fixed by the parent):
 *   per-child memory.max = max(8 GiB, 1.5 × peak)
 *   per-child memory.high = max(6 GiB, 1.2 × peak)
 *   per-child pids.max    = max(2048, 2 × peak)
 */
export const GiB = 1024 * 1024 * 1024;

/** Peak memory.peak (bytes) and pids.peak observed across the sizing run. */
export const MEASURED_SIZING = {
  // d0-sizing unit (Delegate=yes, MemoryMax=24G, CPUQuota=400%, Nice=10), group `sized`,
  // 2026-09-30: full server unit suite = 6051 passed | 3 skipped (exit 0);
  // memory.peak 1 855 492 096 B (1.73 GiB, includes page cache; anon peak ~430 MB),
  // pids.peak 138. `npm run build` peaked below the suite (monotonic peak unchanged).
  memoryPeakBytes: 1855492096,
  /** Peak anon (RSS-like) memory of the sizing group, bytes (memory.stat `anon`, KiB × 1024). */
  anonPeakBytes: 434176 * 1024,
  pidsPeak: 138,
  measuredAt: '2026-09-30T14:52Z',
  commandClasses: ['server tests/unit (vitest)', 'npm run build'],
} as const;

export const DEFAULT_PER_CHILD = {
  memoryMaxBytes: Math.max(8 * GiB, Math.ceil(1.5 * MEASURED_SIZING.memoryPeakBytes)),
  memoryHighBytes: Math.max(6 * GiB, Math.ceil(1.2 * MEASURED_SIZING.memoryPeakBytes)),
  pidsMax: Math.max(2048, 2 * MEASURED_SIZING.pidsPeak),
  swapMaxBytes: 2 * GiB,
} as const;

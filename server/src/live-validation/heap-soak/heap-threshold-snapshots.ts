/**
 * Heap-threshold snapshots: besides the scheduled start/mid/end snapshots, take
 * one snapshot the first time post-GC heap crosses each threshold. The Gate 1
 * micro-soak (2026-09-26) grew ~146 -> 620 MB in 20 min, so a 24 h run could hit
 * the 4 GiB cap and crash before the mid-run snapshot, losing the evidence of
 * what retains memory. Thresholds stay at or below 2 GiB because generating a
 * snapshot needs its own heap headroom.
 */
export const HEAP_SNAPSHOT_THRESHOLDS_MB: readonly number[] = [1024, 2048];

/** The highest crossed threshold above every fired one, or undefined. A fired
 *  threshold covers all lower ones (no later, lower snapshot after a higher one). */
export function nextHeapThresholdSnapshot(heapUsedBytes: number, firedMB: readonly number[]): number | undefined {
  const heapMB = heapUsedBytes / (1024 * 1024);
  const highestFired = firedMB.length ? Math.max(...firedMB) : 0;
  const crossed = HEAP_SNAPSHOT_THRESHOLDS_MB.filter((t) => heapMB >= t && t > highestFired);
  return crossed.length ? Math.max(...crossed) : undefined;
}

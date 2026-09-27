import { describe, expect, it } from 'vitest';
import {
  A1_RSS_AT_HEAP_CAP_MIB,
  SOAK_MEMORY_SAFETY_CAP_MIB,
  admissionThrottleThresholdMiB,
  heapCapBindsFirst,
  resolveSoakMemoryLimits,
} from '../../../src/live-validation/heap-soak/resources.js';

/**
 * B0 defect 4: the soak unit ran with `MemoryMax=6G` while production runs
 * 18 GiB. Admission's `memory_pressure` (projected headroom < minimum headroom,
 * with a 512 MiB per-turn reservation) then refused 574 prompts from minute 21
 * of A1 — throttling the load profile long before the 4 GiB V8 heap cap bound.
 * These tests lock the chosen soak limits and the arithmetic behind them.
 */
describe('soak memory limits (B0 defect 4)', () => {
  const limits = resolveSoakMemoryLimits();

  it('chooses a MemoryMax with a lower MemoryHigh, under a host-safety cap', () => {
    expect(limits.memoryMaxMiB).toBe(12288);
    expect(limits.memoryHighMiB).toBeLessThan(limits.memoryMaxMiB);
    expect(limits.memoryMaxMiB).toBeLessThanOrEqual(SOAK_MEMORY_SAFETY_CAP_MIB);
  });

  it('makes the V8 heap cap bind before cgroup admission throttles, at the soak load concurrency', () => {
    // At the measured RSS when A1 hit its 4 GiB heap cap, projected headroom
    // must still exceed the admission minimum headroom (i.e. no memory_pressure).
    expect(admissionThrottleThresholdMiB(limits)).toBeGreaterThan(A1_RSS_AT_HEAP_CAP_MIB);
    expect(heapCapBindsFirst(limits)).toBe(true);
  });

  it('measures the A1 heap-cap RSS as a positive, plausible number', () => {
    expect(A1_RSS_AT_HEAP_CAP_MIB).toBeGreaterThan(4096); // > the 4096 MiB heap cap itself
    expect(A1_RSS_AT_HEAP_CAP_MIB).toBeLessThan(12288);
  });
});

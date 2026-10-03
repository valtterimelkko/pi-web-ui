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

/**
 * E2a-1: the run's brief binds this soak's disposable server to
 * MemoryMax ≤ 8G / MemoryHigh ≤ 6G (the host guard soft-alerts below 8 GiB
 * MemAvailable). The override is env-driven so the launch command carries it,
 * validated fail-closed, and the default stays the B0 12G/10G.
 */
describe('soak memory limits env override (HEAP_SOAK_MEMORY_MAX_MIB / HEAP_SOAK_MEMORY_HIGH_MIB)', () => {
  it('defaults to the B0 12G/10G when the env keys are unset', () => {
    const limits = resolveSoakMemoryLimits({});
    expect(limits.memoryMaxMiB).toBe(12288);
    expect(limits.memoryHighMiB).toBe(10240);
  });

  it('honours a valid override (the E2a-1 8G/6G binding)', () => {
    const limits = resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: '8192', HEAP_SOAK_MEMORY_HIGH_MIB: '6144' });
    expect(limits.memoryMaxMiB).toBe(8192);
    expect(limits.memoryHighMiB).toBe(6144);
    // the admission arithmetic fields are carried through unchanged
    expect(limits.rssAtHeapCapMiB).toBe(A1_RSS_AT_HEAP_CAP_MIB);
    expect(admissionThrottleThresholdMiB(limits)).toBe(8192 - 512 - 8 * 512);
  });

  it('refuses an override above the host-safety cap, below the floor, or non-integer', () => {
    expect(() => resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: String(SOAK_MEMORY_SAFETY_CAP_MIB + 1) })).toThrow(/SOAK_MEMORY_SAFETY_CAP|safety cap/i);
    expect(() => resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: '512' })).toThrow(/at least|floor|>= 1024/i);
    expect(() => resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: '12.5' })).toThrow(/whole number|integer/i);
    expect(() => resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: 'abc' })).toThrow(/whole number|integer/i);
  });

  it('refuses a MemoryHigh that is not below MemoryMax', () => {
    expect(() => resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: '8192', HEAP_SOAK_MEMORY_HIGH_MIB: '8192' })).toThrow(/below/);
    expect(() => resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_HIGH_MIB: '12288' })).toThrow(/below/);
  });

  it('leaves heapCapBindsFirst readable under an override (it may legitimately be false at 8G)', () => {
    const limits = resolveSoakMemoryLimits({ HEAP_SOAK_MEMORY_MAX_MIB: '8192', HEAP_SOAK_MEMORY_HIGH_MIB: '6144' });
    expect(typeof heapCapBindsFirst(limits)).toBe('boolean');
  });
});

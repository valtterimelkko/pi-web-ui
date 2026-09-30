import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PER_CHILD, MEASURED_SIZING, GiB } from '../../../src/placement/defaults.js';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('D0 deploy unit arithmetic (amendment A)', () => {
  it('tools slice: high 14G, max 18G, swap 4G, CPUWeight 100, Delegate yes', () => {
    const slice = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-tools.slice'), 'utf8');
    expect(slice).toMatch(/^MemoryHigh=14G$/m);
    expect(slice).toMatch(/^MemoryMax=18G$/m);
    expect(slice).toMatch(/^MemorySwapMax=4G$/m);
    expect(slice).toMatch(/^CPUWeight=100$/m);
    expect(slice).toMatch(/^Delegate=yes$/m);
  });

  it('control plane drop-in: max 8G, low 2G, and NO MemoryHigh (throttling the server stalls the loop)', () => {
    const dropin = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-control-plane.conf'), 'utf8');
    expect(dropin).toMatch(/^MemoryMax=8G$/m);
    expect(dropin).toMatch(/^MemoryLow=2G$/m);
    expect(dropin).not.toMatch(/^MemoryHigh=/m);
  });

  it('slice budget exceeds the control plane so neither starves the other of memory', () => {
    const slice = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-tools.slice'), 'utf8');
    const sliceMax = Number(slice.match(/^MemoryMax=(\d+)G$/m)?.[1]);
    const dropin = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-control-plane.conf'), 'utf8');
    const controlMax = Number(dropin.match(/^MemoryMax=(\d+)G$/m)?.[1]);
    expect(sliceMax).toBeGreaterThanOrEqual(controlMax);
    expect(sliceMax + controlMax).toBeLessThanOrEqual(26); // host has 30G; leaves room for other tenants
  });

  it('answer-04 drop-ins: OOMPolicy=continue and OOMScoreAdjust=-500, order-constrained', () => {
    const policy = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-oom-policy.conf'), 'utf8');
    expect(policy).toMatch(/^OOMPolicy=continue$/m);
    expect(policy).not.toMatch(/^OOMPolicy=stop$/m);
    const score = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-oom-score.conf'), 'utf8');
    expect(score).toMatch(/^OOMScoreAdjust=-500$/m);
    // Binding rollout order: the -500 score drop-in is installed only together with
    // PI_TOOLS_PLACEMENT=on (otherwise unplaced children inherit -500).
    expect(score).toMatch(/PI_TOOLS_PLACEMENT=on/);
    expect(score).toMatch(/order/i);
  });

  it('the placement wrapper resets placed commands to oom_score_adj 0 (wrapper test asserts it live)', () => {
    // The behavioural assertion lives in placement-wrapper.test.ts
    // ("OOM SCORE (answer 04)") — this pin documents the pairing.
    const wrapper = readFileSync(path.join(repoRoot, 'server/src/placement/wrapper.ts'), 'utf8');
    expect(wrapper).toContain('/proc/self/oom_score_adj');
    expect(wrapper).toContain('oom-score-reset-failed');
  });

  it('per-child defaults follow the amendment-A decision rule from the measured sizing run', () => {
    expect(MEASURED_SIZING.memoryPeakBytes).toBeGreaterThan(0);
    expect(MEASURED_SIZING.pidsPeak).toBeGreaterThan(0);
    expect(DEFAULT_PER_CHILD.memoryMaxBytes).toBe(Math.max(8 * GiB, Math.ceil(1.5 * MEASURED_SIZING.memoryPeakBytes)));
    expect(DEFAULT_PER_CHILD.memoryHighBytes).toBe(Math.max(6 * GiB, Math.ceil(1.2 * MEASURED_SIZING.memoryPeakBytes)));
    expect(DEFAULT_PER_CHILD.pidsMax).toBe(Math.max(2048, 2 * MEASURED_SIZING.pidsPeak));
    // Ordinary heavy work never meets a limit: measured peak far under the high.
    expect(MEASURED_SIZING.memoryPeakBytes).toBeLessThan(DEFAULT_PER_CHILD.memoryHighBytes);
    // 12 children of ordinary work fit under the slice high without throttling.
    // Anon memory is the honest no-figure-fudging basis (memory.peak includes page cache).
    expect(12 * MEASURED_SIZING.anonPeakBytes).toBeLessThan(14 * GiB);
  });
});

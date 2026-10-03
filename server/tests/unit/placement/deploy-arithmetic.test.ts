import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PER_CHILD, MEASURED_SIZING, GiB } from '../../../src/placement/defaults.js';

const repoRoot = path.resolve(__dirname, '../../../..');

describe('D0 deploy unit arithmetic (amendment A)', () => {
  // L3 (2026-10-03, owner decision): the control plane went 8G -> 12G for the
  // admission arithmetic, so the tools slice went 18G/14G -> 14G/12G to keep
  // the joint budget at 26G on the 30G host (observed tools peak 8.3 GiB).
  it('tools slice: high 12G, max 14G, swap 4G, CPUWeight 100, and no (ignored) Delegate', () => {
    const slice = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-tools.slice'), 'utf8');
    expect(slice).toMatch(/^MemoryHigh=12G$/m); // 12 GiB = 12884901888 bytes
    expect(slice).not.toMatch(/^MemoryHigh=256M/m); // no stale 256 MiB expectations
    expect(slice).toMatch(/^MemoryMax=14G$/m);
    expect(slice).toMatch(/^MemorySwapMax=4G$/m);
    expect(slice).toMatch(/^CPUWeight=100$/m);
    // Rollout finding 2026-09-30: systemd 255 ignores Delegate= on slice units ("not
    // supported for this unit type"), so it never stopped daemon-reload clearing
    // subtree_control. Delegation lives on the anchor service below.
    expect(slice).not.toMatch(/^Delegate=/m);
  });

  it('tools root anchor: a delegated service in the slice that survives per-child OOM kills', () => {
    const anchor = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-tools-anchor.service'), 'utf8');
    expect(anchor).toMatch(/^Slice=pi-web-ui-tools\.slice$/m);
    expect(anchor).toMatch(/^Delegate=cpu memory pids$/m);
    // No internal processes: the anchor's own process sits in a subgroup so the
    // server may enable controllers in the anchor's subtree_control.
    expect(anchor).toMatch(/^DelegateSubgroup=supervisor$/m);
    // Proven on a disposable anchor: with the default OOMPolicy=stop one per-child OOM
    // kill fails the anchor and systemd kills every placed command inside it.
    expect(anchor).toMatch(/^OOMPolicy=continue$/m);
    expect(anchor).not.toMatch(/^Memory(Max|High)=/m); // the slice is the bound
    // Luna D0 live re-run finding 3 (proven on disposable units): the anchor's own
    // process dying must not take the placed commands with it. ExitType=cgroup keeps
    // the unit active while any placed command remains; -1000 keeps the kernel off
    // the sleeper; a restart re-enables the controllers itself.
    expect(anchor).toMatch(/^ExitType=cgroup$/m);
    expect(anchor).toMatch(/^OOMScoreAdjust=-1000$/m);
    const exec = anchor.match(/^ExecStart=(.*)$/m)?.[1] ?? '';
    expect(exec).toContain('cgroup.subtree_control');
    expect(exec).toContain('+cpu +memory +pids');
    // systemd expands ${…} and % in ExecStart: shell variables must be written $$.
    expect(exec).not.toMatch(/(^|[^$])\$\{/);
    expect(exec).not.toMatch(/(^|[^$])\$[a-z(]/);
  });

  it('control plane drop-in: max 12G, low 2G, and NO effective MemoryHigh (throttling the server stalls the loop)', () => {
    const dropin = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-control-plane.conf'), 'utf8');
    expect(dropin).toMatch(/^MemoryMax=12G$/m);
    expect(dropin).toMatch(/^MemoryLow=2G$/m);
    // Omitting the key is not enough: the base unit sets MemoryHigh=3G, which a drop-in
    // that stays silent inherits (rollout finding, 2026-09-30). Clear it explicitly.
    const base = readFileSync(path.join(repoRoot, 'deploy/systemd/pi-web-ui.service'), 'utf8');
    expect(base).toMatch(/^MemoryHigh=/m);
    const highs = dropin.match(/^MemoryHigh=.*$/gm) ?? [];
    expect(highs).toEqual(['MemoryHigh=infinity']);
  });

  it('slice budget exceeds the control plane so neither starves the other of memory', () => {
    const slice = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-tools.slice'), 'utf8');
    const sliceMax = Number(slice.match(/^MemoryMax=(\d+)G$/m)?.[1]);
    const dropin = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-control-plane.conf'), 'utf8');
    const controlMax = Number(dropin.match(/^MemoryMax=(\d+)G$/m)?.[1]);
    expect(sliceMax).toBeGreaterThanOrEqual(controlMax);
    expect(sliceMax + controlMax).toBeLessThanOrEqual(26); // host has 30G; leaves room for other tenants
  });

  it('answer-04 + correction-06 finding 6: placement + OOM score are ONE drop-in', () => {
    const placement = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-placement.conf'), 'utf8');
    expect(placement).toMatch(/^Environment=PI_TOOLS_PLACEMENT=on$/m);
    expect(placement).toMatch(/^Environment=PI_TOOLS_SLICE=pi-web-ui-tools-anchor\.service$/m);
    // The root is resolved once at start-up, so the anchor must be up first.
    expect(placement).toMatch(/^Wants=pi-web-ui-tools-anchor\.service$/m);
    expect(placement).toMatch(/^After=pi-web-ui-tools-anchor\.service$/m);
    expect(placement).toMatch(/^OOMScoreAdjust=-500$/m);
    // The pairing is pinned: one file, one rollback (delete file + drain-restart).
    expect(placement).toMatch(/ROLLBACK/i);
    // The separate OOM-score file must NOT exist (superseded by the merged drop-in).
    expect(existsSync(path.join(repoRoot, 'deploy/pi-web-ui-oom-score.conf'))).toBe(false);
    // OOMPolicy stays its own independent drop-in.
    const policy = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-oom-policy.conf'), 'utf8');
    expect(policy).toMatch(/^OOMPolicy=continue$/m);
    expect(policy).not.toMatch(/^OOMPolicy=stop$/m);
  });

  it('correction-06 finding 5: system.slice ancestor MemoryLow for hierarchical protection', () => {
    const sysLow = readFileSync(path.join(repoRoot, 'deploy/system-slice-memory-low.conf'), 'utf8');
    expect(sysLow).toMatch(/^MemoryLow=2G$/m);
    // The service's own MemoryLow must equal the ancestor grant (2G) for the
    // protection to be fully effective down the hierarchy.
    const dropin = readFileSync(path.join(repoRoot, 'deploy/pi-web-ui-control-plane.conf'), 'utf8');
    expect(dropin).toMatch(/^MemoryLow=2G$/m);
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

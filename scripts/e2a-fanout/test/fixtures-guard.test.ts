/**
 * Guard test for the 2026-10-03 incident root cause (03-blocked.md): the arm-B
 * fixture step ran `npm ci` with an INHERITED working directory (the worktree
 * root, whose node_modules symlinked into production) and emptied production's
 * node_modules. The guard must refuse to run npm inside anything that is not a
 * fixture clone under the lane's run root, and refuse a fixture whose
 * node_modules is (or resolves through) a symlink.
 *
 * All FS access is injected — the tests are pure and never touch real run dirs.
 */
import { describe, expect, it } from 'vitest';
import { assertSafeNpmCwd } from '../lib/fixtures.ts';

const EXISTING_DIR = { isSymbolicLink: () => false, isDirectory: () => true };
const fs = {
  lstatTarget: () => EXISTING_DIR,
  realpathSync: (p: string) => (p === '/root/e2a-runs/a4/escape-fixture' ? '/root/pi-web-ui' : p),
};

describe('assertSafeNpmCwd (incident guard)', () => {
  it('accepts a fixture clone under the lane run root', () => {
    expect(() => assertSafeNpmCwd('/root/e2a-runs/a4/fixtures-child', '/root/e2a-runs/a4', fs)).not.toThrow();
  });

  it('refuses a cwd outside /root/e2a-runs/a4 (the inherited-cwd class)', () => {
    for (const bad of [
      '/root/.worktrees/orch-scaling/e2-a4-pi-web-ui',
      '/root/pi-web-ui',
      '/root/pi-orch',
      '/tmp',
      '/root/e2a-runs/a4-something-else/fixtures-child', // prefix lookalike, different run root
    ]) {
      expect(() => assertSafeNpmCwd(bad, '/root/e2a-runs/a4', fs), `refuses ${bad}`).toThrow(/run root/);
    }
  });

  it('refuses when the cwd itself is missing (nothing to install into)', () => {
    expect(() =>
      assertSafeNpmCwd('/root/e2a-runs/a4/missing-fixture', '/root/e2a-runs/a4', {
        ...fs,
        lstatTarget: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      }),
    ).toThrow(/does not exist/);
  });

  it('refuses when the target node_modules is a symlink (the production-emptying path)', () => {
    expect(() =>
      assertSafeNpmCwd('/root/e2a-runs/a4/fixtures-child', '/root/e2a-runs/a4', {
        ...fs,
        lstatTarget: (p: string) => (p.endsWith('node_modules') ? { isSymbolicLink: () => true, isDirectory: () => true } : EXISTING_DIR),
      }),
    ).toThrow(/symlink/);
  });

  it('refuses when the resolved real path escapes the run root (symlinked parent)', () => {
    expect(() => assertSafeNpmCwd('/root/e2a-runs/a4/escape-fixture', '/root/e2a-runs/a4', fs)).toThrow(/run root/);
  });
});

/**
 * 06-answer (2026-10-03T08:46Z): the arm-B fixture step must not run npm at
 * all when the cloned repository has no runtime dependencies — `/root/pi-orch`
 * has none, and its test script (`node --test`) needs no install. The decision
 * is a pure function so the driver can skip the step and the guard
 * (`assertSafeNpmCwd`) stays for any future npm use.
 */
import { describe, expect, it } from 'vitest';
import { fixtureInstallDecision } from '../lib/fixtures.ts';

describe('fixtureInstallDecision (06-answer: no npm for dep-free clones)', () => {
  it('says skip for a package.json without dependencies (pi-orch)', () => {
    expect(fixtureInstallDecision({ name: 'pi-orch', devDependencies: { '@types/node': '^20', typescript: '^5' } })).toEqual({
      install: false,
      reason: 'no runtime dependencies',
    });
  });

  it('says skip for a package.json without any dependency fields', () => {
    expect(fixtureInstallDecision({ name: 'bare' })).toEqual({ install: false, reason: 'no runtime dependencies' });
  });

  it('says ci when a lockfile exists alongside runtime dependencies', () => {
    expect(
      fixtureInstallDecision({ name: 'locked', dependencies: { express: '^4' } }, { hasLockfile: true }),
    ).toEqual({ install: true, command: 'ci' });
  });

  it('says install (no package-lock) when runtime dependencies exist but no lockfile', () => {
    expect(
      fixtureInstallDecision({ name: 'unlocked', dependencies: { 'left-pad': '^1' } }, { hasLockfile: false }),
    ).toEqual({ install: true, command: 'install' });
  });
});

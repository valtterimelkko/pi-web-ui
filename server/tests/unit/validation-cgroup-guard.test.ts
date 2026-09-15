import { describe, expect, it } from 'vitest';
import {
  CGROUP_OVERRIDE_ENV,
  PRODUCTION_SERVICE_CGROUP,
  checkValidationCgroup,
  parseSelfCgroupPath,
  validationCgroupRecipe,
} from '../../src/live-validation/validation-cgroup-guard.js';

/**
 * Disposable-validation cgroup hygiene (2026-09-15).
 *
 * The document that describes `npm run validate:server` already warns that a
 * disposable validation server must not run inside the production service's
 * control group — but a warning is not a guard. On 2026-09-15 at 08:30 systemd
 * SIGKILLed `/system.slice/pi-web-ui.service` with `KillMode=control-group`, and
 * the process list shows it taking `npm run validate:server`, `npm exec tsx`,
 * three `esbuild` processes and four mid-turn orchestration children with it.
 * The validation server is the one of those that the repo can refuse to start
 * in the wrong place.
 *
 * The check is deliberately a pure function over `/proc/self/cgroup` so that
 * the refusal is testable without being inside the production cgroup.
 */
describe('validation cgroup guard', () => {
  it('parses the unified cgroup path out of /proc/self/cgroup', () => {
    expect(parseSelfCgroupPath('0::/system.slice/pi-web-ui.service\n')).toBe('/system.slice/pi-web-ui.service');
    expect(parseSelfCgroupPath('0::/\n')).toBe('/');
    // v1-style multi-controller lines: the last path wins.
    expect(parseSelfCgroupPath('4:cpu:/system.slice/foo.service\n3:memory:/system.slice/bar.service\n'))
      .toBe('/system.slice/bar.service');
    expect(parseSelfCgroupPath('')).toBeNull();
  });

  it('refuses to start inside the production service cgroup', () => {
    const verdict = checkValidationCgroup({ cgroupPath: PRODUCTION_SERVICE_CGROUP });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('inside-production-cgroup');
    expect(verdict.message).toContain(PRODUCTION_SERVICE_CGROUP);
    // The message must be actionable, not just a refusal.
    expect(verdict.message).toContain(CGROUP_OVERRIDE_ENV);
  });

  it('refuses for a nested cgroup beneath the production service', () => {
    const verdict = checkValidationCgroup({
      cgroupPath: `${PRODUCTION_SERVICE_CGROUP}/validate-scope`,
    });
    expect(verdict.allowed).toBe(false);
  });

  it('does not refuse a sibling cgroup that merely shares a prefix', () => {
    const verdict = checkValidationCgroup({ cgroupPath: '/system.slice/pi-web-ui-validate.service' });
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('outside-production-cgroup');
  });

  it('allows an explicit, deliberate override', () => {
    const verdict = checkValidationCgroup({
      cgroupPath: PRODUCTION_SERVICE_CGROUP,
      overrideEnv: '1',
    });
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('override');
  });

  it('does not treat a falsey override value as consent', () => {
    for (const value of ['', '0', 'no', 'false']) {
      expect(checkValidationCgroup({
        cgroupPath: PRODUCTION_SERVICE_CGROUP,
        overrideEnv: value,
      }).allowed).toBe(false);
    }
  });

  it('stays permissive when the cgroup cannot be read at all', () => {
    const verdict = checkValidationCgroup({ cgroupPath: null });
    expect(verdict.allowed).toBe(true);
    if (!verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('undetectable');
  });

  it('offers the systemd-run scope recipe, including a unique unit suggestion', () => {
    const recipe = validationCgroupRecipe('pi-web-ui-validate-abc123');
    expect(recipe).toContain('systemd-run --scope --collect');
    expect(recipe).toContain('--unit=pi-web-ui-validate-abc123');
    expect(recipe).toContain('npm run validate:server');
  });

  /**
   * Regression, found by live-checking the wrapper rather than by unit tests.
   *
   * The verdict originally accepted the *contents* of /proc/self/cgroup and
   * re-parsed it, while `readSelfCgroup` returned an already-parsed path. Wiring
   * the two together therefore silently produced `undetectable` — the guard
   * allowed precisely the thing it exists to refuse, and the unit tests passed
   * because they happened to feed file contents. The field is now named
   * `cgroupPath` and takes the parsed value; this pins that contract.
   */
  it('consumes a parsed path, not raw /proc/self/cgroup text', () => {
    // A path is what the wrapper passes, and it must refuse.
    expect(checkValidationCgroup({ cgroupPath: PRODUCTION_SERVICE_CGROUP }).allowed).toBe(false);
    // Raw file text is NOT a path and must not be mistaken for one: it can only
    // ever compare unequal, which would be a silent allow.
    const asText = `0::${PRODUCTION_SERVICE_CGROUP}\n`;
    expect(checkValidationCgroup({ cgroupPath: asText }).allowed).toBe(true);
  });

  it('never suggests running the validation server inside the production unit', () => {
    const recipe = validationCgroupRecipe();
    expect(recipe).not.toContain(PRODUCTION_SERVICE_CGROUP);
  });
});

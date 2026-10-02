/**
 * J6: a disposable server can never sweep production's tools root.
 *
 * Production's unit environment carries `PI_TOOLS_PLACEMENT=on` and
 * `PI_TOOLS_SLICE=pi-web-ui-tools-anchor.service`, and production's placement
 * wrapper additionally exports the whole `PI_TOOLS_*` family (`PI_TOOLS_ROOT`,
 * `PI_TOOLS_CG`, `PI_TOOLS_GROUP`, `PI_TOOLS_MEM_*`, `PI_TOOLS_DEGRADE_FILE`,
 * …) into every placed shell. Any launcher process inside the production
 * service inherits all of it, and the validation launcher used to pass it
 * through to the disposable server child, so the child resolved PRODUCTION's
 * tools root and its startup/shutdown `sweepAllGroups` SIGKILLed every other
 * session's live commands under it (Hb5 host hazard, 2026-10-02; reproduced
 * for the child environment in proof phaseA-run-20261002T125926Z).
 *
 * These tests pin the launcher-side fix: inherited `PI_TOOLS_*` keys never
 * reach the disposable server unless the caller explicitly requested that key
 * for this run (the `--env-file`/`--env-key` channel), and the per-run
 * placement runtime dir is always pinned inside the validation directory.
 */
import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_ENV_PREFIX,
  buildValidationIsolationEnv,
  stripInheritedPlacementEnv,
} from '../../../src/live-validation/validation-server-env.js';

function isolationInput() {
  return {
    validationDir: '/tmp/pi-validation',
    port: '3091',
    claudeWsPort: '43110',
    claudeHookPort: '43111',
    opencodePort: '44097',
  };
}

describe('J6: inherited placement env is stripped from the disposable server environment', () => {
  it('strips by the PI_TOOLS_ prefix — the wrapper exports the whole family', () => {
    expect(PLACEMENT_ENV_PREFIX).toBe('PI_TOOLS_');
  });

  it('strips every inherited PI_TOOLS_* key', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_SLICE: 'pi-web-ui-tools-anchor.service',
      PI_TOOLS_RUNTIME_DIR: '/root/.pi-web-ui/placement',
      PI_TOOLS_ROOT: '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service',
      PI_TOOLS_CG: '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service/pi-test',
      PI_TOOLS_GROUP: 'pi-test',
      PI_TOOLS_MEM_MAX: '8589934592',
      PI_TOOLS_PIDS_MAX: '2048',
      PI_TOOLS_DEGRADE_FILE: '/root/.pi-web-ui/placement/degrade.log',
    };
    const dropped = stripInheritedPlacementEnv(env);
    expect(dropped).toContain('PI_TOOLS_PLACEMENT');
    expect(dropped).toContain('PI_TOOLS_SLICE');
    expect(dropped).toContain('PI_TOOLS_RUNTIME_DIR');
    expect(dropped).toContain('PI_TOOLS_ROOT');
    expect(dropped).toContain('PI_TOOLS_GROUP');
    expect(dropped).toContain('PI_TOOLS_DEGRADE_FILE');
    expect(dropped).toHaveLength(9);
    expect(env.PI_TOOLS_PLACEMENT).toBeUndefined();
    expect(env.PI_TOOLS_SLICE).toBeUndefined();
    expect(env.PI_TOOLS_ROOT).toBeUndefined();
    expect(env.PI_TOOLS_CG).toBeUndefined();
    expect(env.PI_TOOLS_DEGRADE_FILE).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.PI_WEB_UI_VALIDATION_MODE).toBeUndefined();
  });

  it('strips even a key the caller will re-request — the env file, not the ambient env, is the source', () => {
    // The env-file loader only FILLS MISSING keys, so an ambient value that
    // survived the strip would silently override the caller's explicit file
    // value (found live in proof phaseB-run-20261002T133739Z arm2: the child
    // got production's anchor instead of the run's own unit). The launcher
    // therefore strips ALL inherited PI_TOOLS_* keys; --env-key only decides
    // which keys the env file must then provide.
    const env: NodeJS.ProcessEnv = {
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_SLICE: 'pi-web-ui-tools-anchor.service',
    };
    const dropped = stripInheritedPlacementEnv(env);
    expect(dropped.sort()).toEqual(['PI_TOOLS_PLACEMENT', 'PI_TOOLS_SLICE'].sort());
    expect(env.PI_TOOLS_PLACEMENT).toBeUndefined();
    expect(env.PI_TOOLS_SLICE).toBeUndefined();
  });

  it('reports nothing dropped when the environment carries no placement keys', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/root' };
    expect(stripInheritedPlacementEnv(env)).toEqual([]);
  });

  it('always pins the placement runtime dir inside the validation directory', () => {
    const isolation = buildValidationIsolationEnv(isolationInput());
    expect(isolation.PI_TOOLS_RUNTIME_DIR).toBe('/tmp/pi-validation/placement');
  });

  it('never re-enables placement from the isolation env itself', () => {
    const isolation = buildValidationIsolationEnv(isolationInput());
    expect(isolation.PI_TOOLS_PLACEMENT).toBeUndefined();
    expect(isolation.PI_TOOLS_SLICE).toBeUndefined();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PRODUCTION_SERVICE_CGROUP, readSelfCgroup } from '../../src/live-validation/validation-cgroup-guard.js';

/**
 * The guard is binding, not advisory (2026-09-15).
 *
 * `docs/LIVE-VALIDATION.md` warning that a disposable validation server must not
 * live inside the production control group was not enough: on 2026-09-15 08:30
 * systemd SIGKILLed `/system.slice/pi-web-ui.service` with
 * `KillMode=control-group` and took one with it, along with four mid-turn
 * orchestration children. This asserts the wrapper actually refuses — the pure
 * decision is covered in validation-cgroup-guard.test.ts, but a guard nothing
 * calls is not a guard.
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDirectory(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

const script = fileURLToPath(new URL('../../../scripts/validation-server.ts', import.meta.url));

function runWithCgroupFile(cgroupFile: string, extraArgs: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync('npx', ['tsx', script, ...extraArgs], {
    encoding: 'utf8',
    timeout: 90_000,
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    env: {
      ...process.env,
      PI_WEB_UI_VALIDATION_CGROUP_FILE: cgroupFile,
      PI_WEB_UI_VALIDATION_ALLOW_PRODUCTION_CGROUP: '',
    },
  });
}

describe('validation-server cgroup guard', () => {
  it('reads a cgroup file and reports the parsed path', () => {
    const dir = fixtureDirectory('pi-web-ui-cgroup-');
    const file = path.join(dir, 'cgroup');
    writeFileSync(file, `0::${PRODUCTION_SERVICE_CGROUP}\n`);
    expect(readSelfCgroup(file)).toBe(PRODUCTION_SERVICE_CGROUP);
    expect(readSelfCgroup(path.join(dir, 'does-not-exist'))).toBeNull();
  });

  it('refuses to start inside the production service cgroup, with the scope recipe', () => {
    const dir = fixtureDirectory('pi-web-ui-cgroup-');
    const file = path.join(dir, 'cgroup');
    writeFileSync(file, `0::${PRODUCTION_SERVICE_CGROUP}\n`);

    const result = runWithCgroupFile(file);

    // EX_CONFIG: refused before any directory, lock or port was taken.
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(78);
    expect(result.stderr).toContain('Refusing to start a disposable validation server');
    expect(result.stderr).toContain('systemd-run --scope --collect');
    expect(result.stderr).not.toContain('Pi Web UI Server running on port');
  }, 120_000);
});

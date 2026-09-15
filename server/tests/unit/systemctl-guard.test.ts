import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSystemctlGuard,
  SYSTEMCTL_GUARD_LOG_ENV,
  SYSTEMCTL_GUARD_MARKER_ENV,
} from '../../tests/systemctl-guard.js';

/**
 * The test harness must be unable to restart production (2026-09-15).
 *
 * Production was restarted for real at 2026-09-15T14:27:05Z by an *early Vitest
 * run of restart-drainage.test.ts*: a red-proof command `git stash`-ed
 * scripts/restart-pi-web-ui.sh back to its pre-guard revision, which calls a
 * bare `systemctl restart pi-web-ui`. The suite's only interception was
 * `PI_WEB_UI_RESTART_SYSTEMCTL` — an env seam honoured BY THE SCRIPT UNDER TEST
 * — so reverting the implementation removed the guard and its interception
 * together, and the suite really restarted production.
 *
 * The durable repair (commit d921ac7) put a `systemctl` stub on PATH *inside
 * that one suite*. This file generalises it to the whole test workspace: the
 * guard is installed by the test environment (`tests/setup-env.ts`), so it is
 * NOT part of the code under test and cannot be reverted alongside it. Any
 * suite — or any script a suite runs, at any revision — that reaches for
 * `systemctl` gets a refusal instead of the host service manager.
 *
 * The guard is exercised here against a *sentinel* real binary, so these tests
 * cannot touch production even by accident, and a positive control proves the
 * pass-through route really reaches the binary it was pointed at.
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

/** A stand-in for the host's real systemctl: it records and never acts. */
function writeSentinelBinary(dir: string): { binPath: string; calls: () => string[] } {
  const binPath = path.join(dir, 'real-systemctl');
  const logPath = path.join(dir, 'real-systemctl.calls');
  writeFileSync(binPath, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`);
  chmodSync(binPath, 0o755);
  return {
    binPath,
    calls: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []),
  };
}

describe('the test-harness systemctl guard', () => {
  it('is installed in this process by the test environment, not by the code under test', () => {
    // If this canary fails, setup-env.ts was unwired or reordered and every
    // suite that runs a repo-owned restart script is dangerous again.
    expect(process.env.PATH?.split(path.delimiter)[0]).toBe(process.env[SYSTEMCTL_GUARD_MARKER_ENV]);
    expect(process.env[SYSTEMCTL_GUARD_MARKER_ENV]).toBeTruthy();
    expect(existsSync(path.join(process.env[SYSTEMCTL_GUARD_MARKER_ENV] as string, 'systemctl'))).toBe(true);
  });

  it('refuses a bare `systemctl restart pi-web-ui` — the exact 14:27 reverted-revision call', () => {
    const dir = fixtureDirectory('pi-web-ui-guard-');
    const sentinel = writeSentinelBinary(dir);
    const guard = createSystemctlGuard({ dir, realBinary: sentinel.binPath, logPath: path.join(dir, 'guard.log') });

    const result = spawnSync('bash', ['-c', 'systemctl restart pi-web-ui'], {
      encoding: 'utf8',
      env: { PATH: `${guard.dir}:/usr/bin:/bin`, [SYSTEMCTL_GUARD_LOG_ENV]: guard.logPath },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing');
    expect(result.stderr).toContain('restart');
    // The service manager was never reached: production was not restarted.
    expect(sentinel.calls()).toEqual([]);
    // And the attempt is recorded, so a future incident can name the caller.
    expect(readFileSync(guard.logPath, 'utf8')).toContain('restart pi-web-ui');
  });

  it('refuses every state-changing verb, not just restart', () => {
    const dir = fixtureDirectory('pi-web-ui-guard-');
    const sentinel = writeSentinelBinary(dir);
    const guard = createSystemctlGuard({ dir, realBinary: sentinel.binPath, logPath: path.join(dir, 'guard.log') });

    for (const verb of ['stop', 'start', 'kill', 'daemon-reload', 'mask', 'reboot', 'poweroff']) {
      const result = spawnSync('bash', ['-c', `systemctl ${verb} pi-web-ui.service`], {
        encoding: 'utf8',
        env: { PATH: `${guard.dir}:/usr/bin:/bin`, [SYSTEMCTL_GUARD_LOG_ENV]: guard.logPath },
      });
      expect(result.status, verb).not.toBe(0);
    }
    expect(sentinel.calls()).toEqual([]);
  });

  it('passes read-only verbs through to the real binary with identical arguments', () => {
    const dir = fixtureDirectory('pi-web-ui-guard-');
    const sentinel = writeSentinelBinary(dir);
    const guard = createSystemctlGuard({ dir, realBinary: sentinel.binPath, logPath: path.join(dir, 'guard.log') });

    const result = spawnSync('bash', ['-c', 'systemctl show pi-web-ui.service -p NRestarts -p ActiveState'], {
      encoding: 'utf8',
      env: { PATH: `${guard.dir}:/usr/bin:/bin`, [SYSTEMCTL_GUARD_LOG_ENV]: guard.logPath },
    });

    expect(result.status).toBe(0);
    expect(sentinel.calls()).toEqual(['show pi-web-ui.service -p NRestarts -p ActiveState']);
  });

  it('leaves a caller that supplies its own stub seam untouched', () => {
    // The suites' own PI_WEB_UI_RESTART_SYSTEMCTL stub keeps working exactly as
    // before: the guard is a backstop for the route that bypasses it.
    const dir = fixtureDirectory('pi-web-ui-guard-');
    const sentinel = writeSentinelBinary(dir);
    const guard = createSystemctlGuard({ dir, realBinary: sentinel.binPath, logPath: path.join(dir, 'guard.log') });
    const ownStub = path.join(dir, 'own-stub');
    writeFileSync(ownStub, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(ownStub, 0o755);

    const result = spawnSync('bash', ['-c', `"${ownStub}" restart pi-web-ui`], {
      encoding: 'utf8',
      env: { PATH: `${guard.dir}:/usr/bin:/bin` },
    });

    expect(result.status).toBe(0);
    expect(sentinel.calls()).toEqual([]);
  });
});

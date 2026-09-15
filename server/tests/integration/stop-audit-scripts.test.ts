import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The stop-audit instruments must work when they are the only thing left
 * (2026-09-15).
 *
 * Between 2026-09-14 15:26 and 2026-09-15 08:30 the service was SIGKILLed after
 * `TimeoutStopSec=30` seven times with no `Stopping ...` line and no app-side
 * record. These scripts are the fallback that has to work when the app cannot
 * speak, so they are exercised here as real processes rather than as units.
 *
 * They are shell, they run inside `ExecStopPre`/`ExecStopPost`, and a non-zero
 * exit marks the unit failed — so "always exits 0" is a behavioural requirement,
 * not a nicety.
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

const auditScript = fileURLToPath(new URL('../../../scripts/systemd-stop-audit.sh', import.meta.url));
const restartScript = fileURLToPath(new URL('../../../scripts/restart-pi-web-ui.sh', import.meta.url));

function runAudit(
  phase: string,
  env: Record<string, string>,
  auditFile: string,
): ReturnType<typeof spawnSync> {
  return spawnSync('bash', [auditScript, phase], {
    encoding: 'utf8',
    env: { ...process.env, PI_WEB_UI_STOP_AUDIT_FILE: auditFile, ...env },
  });
}

describe('systemd-stop-audit.sh', () => {
  it('records every field the 08:30 incident could not answer', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    const auditFile = path.join(dir, 'stop-audit.log');

    const result = runAudit('pre', { INVOCATION_ID: 'inv-1', MAINPID: '4242' }, auditFile);

    expect(result.status).toBe(0);
    const line = result.stdout.trim();
    for (const field of [
      'phase=pre',
      'ts=',
      'invocation=inv-1',
      'service_result=',
      'exit_code=',
      'exit_status=',
      'mainpid=4242',
      'main_alive=',
      'active_state=',
      'sub_state=',
      'unit_result=',
      'nrestarts=',
      'cgroup_procs=',
    ]) {
      expect(line, `missing ${field} in: ${line}`).toContain(field);
    }
    // The census is what makes KillMode=control-group's cost visible before it
    // is paid again.
    expect(line).toContain('procs=');
  });

  it('writes the same line to the durable file, not only the journal', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    const auditFile = path.join(dir, 'nested', 'stop-audit.log');
    const result = runAudit('pre', { INVOCATION_ID: 'inv-2', MAINPID: '1' }, auditFile);

    expect(result.status).toBe(0);
    expect(existsSync(auditFile)).toBe(true);
    expect(readFileSync(auditFile, 'utf8').trim()).toBe(result.stdout.trim());
  });

  it('carries SERVICE_RESULT/EXIT_CODE/EXIT_STATUS through on the post hook', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    const auditFile = path.join(dir, 'stop-audit.log');
    const result = runAudit(
      'post',
      {
        INVOCATION_ID: 'inv-3',
        MAINPID: '999999',
        SERVICE_RESULT: 'timeout',
        EXIT_CODE: 'killed',
        EXIT_STATUS: 'KILL',
      },
      auditFile,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('phase=post');
    expect(result.stdout).toContain('service_result=timeout');
    expect(result.stdout).toContain('exit_code=killed');
    expect(result.stdout).toContain('exit_status=KILL');
    // MAINPID 999999 is not running, so liveness is reported honestly.
    expect(result.stdout).toContain('main_alive=no');
  });

  it('derives the stop duration from the matching pre hook — the timing a SIGKILLed app cannot report', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    const auditFile = path.join(dir, 'stop-audit.log');
    // Hand-written pre line so the elapsed value is deterministic (no sleep).
    const preTs = new Date(Date.now() - 7_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(
      auditFile,
      `STOP-AUDIT phase=pre ts=${preTs} invocation=inv-4 service_result=unset exit_code=unset exit_status=unset mainpid=1 main_alive=yes\n`,
    );

    const result = runAudit('post', { INVOCATION_ID: 'inv-4', MAINPID: '1' }, auditFile);

    expect(result.status).toBe(0);
    const elapsed = /elapsed_s=(\d+)/.exec(result.stdout);
    expect(elapsed?.[1]).toBeDefined();
    // 7s ago, allowing for rounding across the second boundary.
    expect(Number(elapsed![1])).toBeGreaterThanOrEqual(6);
    expect(Number(elapsed![1])).toBeLessThanOrEqual(9);
  });

  it('reports elapsed as unset rather than guessing when there is no matching pre line', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    const auditFile = path.join(dir, 'stop-audit.log');
    const result = runAudit('post', { INVOCATION_ID: 'no-such-invocation', MAINPID: '1' }, auditFile);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('elapsed_s=unset');
  });

  it('never fails the stop, even with a hostile environment', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    // An audit path whose parent cannot be created plus empty systemd variables:
    // the hook must still succeed, because a failing ExecStopPre marks the unit
    // failed.
    writeFileSync(path.join(dir, 'not-a-directory'), '');
    const result = runAudit(
      'pre',
      { INVOCATION_ID: '', MAINPID: '' },
      path.join(dir, 'not-a-directory', 'stop-audit.log'),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STOP-AUDIT phase=pre');
    expect(result.stdout).toContain('invocation=unset');
  });

  it('keeps the durable file bounded', () => {
    const dir = fixtureDirectory('pi-web-ui-stop-audit-');
    const auditFile = path.join(dir, 'stop-audit.log');
    writeFileSync(auditFile, Array.from({ length: 2_000 }, (_, i) => `old line ${i}`).join('\n') + '\n');

    const result = spawnSync('bash', [auditScript, 'pre'], {
      encoding: 'utf8',
      env: { ...process.env, PI_WEB_UI_STOP_AUDIT_FILE: auditFile, PI_WEB_UI_STOP_AUDIT_MAX_LINES: '100' },
    });

    expect(result.status).toBe(0);
    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(101);
    expect(lines[lines.length - 1]).toContain('STOP-AUDIT phase=pre');
  });
});

describe('restart-pi-web-ui.sh', () => {
  it('names the requester before restarting, and supports a dry run', () => {
    const dir = fixtureDirectory('pi-web-ui-restart-');
    const auditFile = path.join(dir, 'stop-audit.log');

    const result = spawnSync(
      'bash',
      [restartScript, '--reason', 'child-S evidence run', '--dry-run'],
      // Pin a socket that cannot exist so the capacity pre-flight is skipped:
      // these tests cover the requester record, not drainage (which
      // restart-drainage.test.ts covers). Without the pin, a host with a live
      // production socket makes this test query it and refuse on busy days.
      { encoding: 'utf8', env: { ...process.env, PI_WEB_UI_STOP_AUDIT_FILE: auditFile, PI_WEB_UI_INTERNAL_API_SOCKET: path.join(dir, 'no-such.sock') } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RESTART-REQUESTED');
    expect(result.stdout).toContain('uid=');
    expect(result.stdout).toContain('pid=');
    expect(result.stdout).toContain('ppid=');
    expect(result.stdout).toContain('cwd=');
    expect(result.stdout).toContain('reason=');
    expect(result.stdout).toContain('argv=');
    // The ancestor chain is what usually identifies the session that asked.
    expect(result.stdout).toContain('ancestors=');
    expect(result.stderr).toContain('dry run');
    // It really did not restart anything.
    expect(result.stderr).not.toContain('systemctl restart');
  });

  it('writes the requester record to the durable file too', () => {
    const dir = fixtureDirectory('pi-web-ui-restart-');
    const auditFile = path.join(dir, 'stop-audit.log');
    spawnSync('bash', [restartScript, '--reason', 'durable', '--dry-run'], {
      encoding: 'utf8',
      // See the dry-run test above: no live capacity queries in this suite.
      env: { ...process.env, PI_WEB_UI_STOP_AUDIT_FILE: auditFile, PI_WEB_UI_INTERNAL_API_SOCKET: path.join(dir, 'no-such.sock') },
    });
    expect(readFileSync(auditFile, 'utf8')).toContain('RESTART-REQUESTED');
    expect(readFileSync(auditFile, 'utf8')).toContain('reason=durable');
  });

  it('rejects an unknown argument instead of silently restarting', () => {
    const dir = fixtureDirectory('pi-web-ui-restart-');
    const result = spawnSync('bash', [restartScript, '--nonsense'], {
      encoding: 'utf8',
      env: { ...process.env, PI_WEB_UI_STOP_AUDIT_FILE: path.join(dir, 'stop-audit.log') },
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('unknown argument');
    expect(existsSync(path.join(dir, 'stop-audit.log'))).toBe(false);
  });

  it('ships the audit hook executable, so systemd can actually run it', () => {
    // A non-executable ExecStopPre is a silently missing instrument.
    for (const script of [auditScript, restartScript]) {
      expect(statSync(script).mode & 0o111, `${script} is not executable`).not.toBe(0);
    }
  });
});

describe('the systemd drop-in declares only real directives', () => {
  /**
   * The drop-in originally declared `ExecStopPre=` to record a pre-SIGTERM line.
   * **systemd has no such directive** — `systemd-analyze verify` reports
   * "Unknown key name 'ExecStopPre' in section 'Service', ignoring" — so the hook
   * never ran during a real stop and the phase=pre evidence its decision table
   * relied on could only be produced by running the script by hand. The conductor
   * found this on the first production install (2026-09-15 10:15Z); the
   * signal-arrival record now comes from the app's synchronous
   * `[Shutdown] event=stop_signal` line instead.
   *
   * A typo in a unit directive fails silently, which is exactly the class of
   * defect this whole workstream exists to remove, so it is pinned here.
   */
  const dropIn = fileURLToPath(
    new URL('../../../deploy/systemd/pi-web-ui.service.d/10-stop-audit.conf', import.meta.url),
  );

  /** Real systemd [Service] directives this drop-in is allowed to use. */
  const ALLOWED_SERVICE_KEYS = new Set(['ExecStopPost']);

  it('uses only directives systemd actually implements', () => {
    const lines = readFileSync(dropIn, 'utf8').split('\n');
    let inServiceSection = false;
    const declared: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inServiceSection = trimmed === '[Service]';
        continue;
      }
      if (!inServiceSection || trimmed.startsWith('#') || trimmed === '') continue;
      const match = /^([A-Za-z][A-Za-z0-9]*)=/.exec(trimmed);
      if (match?.[1]) declared.push(match[1]);
    }

    expect(declared.length, 'the drop-in declares no directives at all').toBeGreaterThan(0);
    for (const key of declared) {
      expect(
        ALLOWED_SERVICE_KEYS.has(key),
        `${key}= is not a real systemd [Service] directive (systemd ignores unknown keys silently)`,
      ).toBe(true);
    }
  });

  it('does not resurrect ExecStopPre, and says why in the file itself', () => {
    const text = readFileSync(dropIn, 'utf8');
    // The comment must mention it (so a future reader learns the trap) …
    expect(text).toContain('ExecStopPre');
    expect(text.toLowerCase()).toContain('unknown key');
    // … but no active directive may declare it.
    const active = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .some((line) => /^\s*ExecStopPre\s*=/.test(line));
    expect(active, 'ExecStopPre= is ignored by systemd; it must not be declared').toBe(false);
  });
});

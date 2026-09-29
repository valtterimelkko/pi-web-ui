import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeInternalApiCurl, type FakeInternalApiCurl } from '../helpers/fake-internal-api-curl.js';

/**
 * B4 drain-then-restart deploy scripts.
 *
 * - scripts/restart-production.sh drains by default: POST /api/v1/drain, wait
 *   for the verdict, record it in the stop audit, then restart the (injectable)
 *   unit. Restarting WITHOUT a drain needs --force plus a --reason, recorded.
 * - scripts/with-production-lock.sh routes a bare `[sudo] systemctl restart
 *   <unit>` through that drain-restart path, and is re-entrant for a command
 *   that already holds the lock (npm run production:drain-restart inside a
 *   locked deploy block).
 *
 * Every test injects the unit, socket, token, lock, audit file, notify hook and
 * systemctl; a PATH `systemctl` stub shares the call log, and the process-wide
 * systemctl guard (tests/setup-env.ts) refuses any mutating verb that escapes.
 */

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts');
const RESTART = path.join(SCRIPTS_DIR, 'restart-production.sh');
const LOCK = path.join(SCRIPTS_DIR, 'with-production-lock.sh');
const RESTART_PI_WEB_UI = path.join(SCRIPTS_DIR, 'restart-pi-web-ui.sh');
const TOKEN = 'b4-drain-test-bearer-token';
const UNIT = 'pi-web-ui-b4-disposable.service';

function recordingStub(dir: string, name: string, logPath: string): string {
  const stub = path.join(dir, name);
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

const settled = {
  state: 'settled', draining: true, reason: 'x', waitedMs: 1234,
  initial: { activeTurns: 3, nonterminalRuns: 3 },
  remaining: { activeTurns: 0, quarantinedTurns: 0, nonterminalRuns: 0, runs: [] },
  completedDuringDrain: 3, cutOffRunIds: [], retryAfterSeconds: 30, joined: false,
};
const timedOut = {
  ...settled, state: 'timed_out', waitedMs: 600000, completedDuringDrain: 1,
  remaining: { activeTurns: 2, quarantinedTurns: 0, nonterminalRuns: 2, runs: [] },
  cutOffRunIds: ['run-b', 'run-c'],
};

describe('drain-then-restart deploy scripts (B4)', () => {
  let dir: string;
  let holder: net.Server;
  let socketPath: string;
  let tokenPath: string;
  let curl: FakeInternalApiCurl;
  let systemctlLog: string;
  let systemctlStub: string;
  let notifyLog: string;
  let notifyStub: string;
  let auditFile: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pi-b4-scripts-'));
    socketPath = path.join(dir, 'internal-api.sock');
    tokenPath = path.join(dir, 'internal-api-token');
    writeFileSync(tokenPath, TOKEN);
    holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(socketPath, resolve));
    curl = installFakeInternalApiCurl(dir, { socketPath, token: TOKEN });
    systemctlLog = path.join(dir, 'systemctl.calls.log');
    systemctlStub = recordingStub(dir, 'systemctl-stub', systemctlLog);
    // PATH shim shares the log: whatever route a script takes to systemctl is seen.
    recordingStub(curl.binDir, 'systemctl', systemctlLog);
    // `sudo` in a routed argv just runs the rest (never the real sudo).
    writeFileSync(path.join(curl.binDir, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n');
    chmodSync(path.join(curl.binDir, 'sudo'), 0o755);
    notifyLog = path.join(dir, 'notify.calls.log');
    notifyStub = recordingStub(dir, 'notify-stub', notifyLog);
    auditFile = path.join(dir, 'stop-audit.log');
    lockPath = path.join(dir, 'locks', 'production-control.lock');
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    ...curl.env,
    PATH: `${curl.binDir}:${process.env.PATH}`,
    PI_WEB_UI_SERVICE_UNIT: UNIT,
    PI_WEB_UI_INTERNAL_API_SOCKET: socketPath,
    PI_WEB_UI_INTERNAL_API_TOKEN_FILE: tokenPath,
    PI_WEB_UI_RESTART_SYSTEMCTL: systemctlStub,
    PI_WEB_UI_NOTIFY_SCRIPT: notifyStub,
    PI_WEB_UI_STOP_AUDIT_FILE: auditFile,
    PI_WEB_UI_SYSTEMD_CAT: path.join(dir, 'no-such-systemd-cat'),
    PI_WEB_UI_PRODUCTION_LOCK: lockPath,
    ...extra,
  });
  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 30_000, env: env(extra) });

  describe('restart-production.sh', () => {
    it('drains by default: POSTs the drain, records the verdict, then restarts the injected unit', () => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: settled });
      const result = run(RESTART, ['--reason', 'deploy b4']);
      expect(result.status, result.stderr).toBe(0);

      const [drain] = curl.requests();
      expect(drain).toMatchObject({ method: 'POST', path: '/api/v1/drain', socket: socketPath, authorization: `Bearer ${TOKEN}` });
      expect(JSON.parse(drain.body ?? '{}')).toEqual({ reason: 'deploy b4', timeoutSeconds: 600 });
      // The HTTP wait is bounded above the drain timeout.
      expect(Number(drain.maxTime)).toBeGreaterThan(600);

      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
      const audit = readFileSync(auditFile, 'utf8');
      expect(audit).toContain('RESTART-REQUESTED');
      expect(audit).toMatch(/drain=settled,waited_ms=1234,initial_runs=3,initial_turns=3,completed=3,cut_off=0/);
      expect(lines(notifyLog).join('\n')).toContain('settled');
    });

    it('restarts after a timed-out drain and records which runs it cut off', () => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: timedOut });
      const result = run(RESTART, ['--reason', 'deploy b4']);
      expect(result.status, result.stderr).toBe(0);
      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
      expect(readFileSync(auditFile, 'utf8')).toMatch(/drain=timed_out,waited_ms=600000,initial_runs=3,initial_turns=3,completed=1,cut_off=2,cut_off_runs=run-b\+run-c/);
      expect(result.stderr).toMatch(/cut off 2 run/);
    });

    it('--on-timeout abort cancels the drain and restarts nothing', () => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: timedOut });
      curl.setRoute('DELETE /api/v1/drain', { status: 200, body: { state: 'idle', draining: false } });
      const result = run(RESTART, ['--reason', 'careful deploy', '--on-timeout', 'abort']);
      expect(result.status).toBe(1);
      expect(curl.requests().map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/v1/drain', 'DELETE /api/v1/drain']);
      expect(lines(systemctlLog)).toEqual([]);
      expect(existsSync(auditFile)).toBe(false);
      expect(result.stderr).toContain('--on-timeout');
    });

    it('passes --drain-timeout through and bounds the wait above it', () => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: settled });
      const result = run(RESTART, ['--reason', 'r', '--drain-timeout', '5']);
      expect(result.status, result.stderr).toBe(0);
      const [drain] = curl.requests();
      expect(JSON.parse(drain.body ?? '{}').timeoutSeconds).toBe(5);
      expect(Number(drain.maxTime)).toBe(65);
    });

    it.each([['-1'], ['3601'], ['abc'], ['']])('rejects --drain-timeout %j with exit 64', (value) => {
      const result = run(RESTART, ['--reason', 'r', '--drain-timeout', value]);
      expect(result.status).toBe(64);
      expect(curl.requests()).toEqual([]);
      expect(lines(systemctlLog)).toEqual([]);
    });

    it('falls back to the legacy active-turn pre-flight against a server without /drain (404)', () => {
      curl.setRoute('POST /api/v1/drain', { status: 404, body: { error: 'Unknown endpoint', code: 'NOT_FOUND' } });
      curl.setRoute('GET /api/v1/capacity', { status: 200, body: { activeTurns: 2 } });
      const refused = run(RESTART, ['--reason', 'first deploy of B4']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('Refusing');
      expect(refused.stderr).toContain('2 active');
      expect(refused.stderr).toContain('--force');
      // The legacy pre-flight queries the authenticated capacity endpoint over the socket.
      expect(curl.requests()[1]).toMatchObject({ method: 'GET', path: '/api/v1/capacity', socket: socketPath, authorization: `Bearer ${TOKEN}` });
      expect(lines(systemctlLog)).toEqual([]);
      expect(lines(notifyLog)).toEqual([]);
      expect(existsSync(auditFile)).toBe(false);

      curl.setRoute('GET /api/v1/capacity', { status: 200, body: { activeTurns: 0 } });
      const ok = run(RESTART, ['--reason', 'first deploy of B4']);
      expect(ok.status, ok.stderr).toBe(0);
      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
      expect(readFileSync(auditFile, 'utf8')).toContain('drain=legacy_preflight,active_turns=0');
    });

    it('refuses when the drain request times out: an unanswered drain is never restarted past', () => {
      curl.setRoute('POST /api/v1/drain', { curlExit: 28 });
      const result = run(RESTART, ['--reason', 'r']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--force');
      expect(lines(systemctlLog)).toEqual([]);
      expect(existsSync(auditFile)).toBe(false);
    });

    it('refuses on an unexpected HTTP answer from the drain endpoint', () => {
      curl.setRoute('POST /api/v1/drain', { status: 500, body: { code: 'INTERNAL_ERROR' } });
      const result = run(RESTART, ['--reason', 'r']);
      expect(result.status).toBe(1);
      expect(lines(systemctlLog)).toEqual([]);
    });

    it('proceeds when the socket refuses connections (a dead daemon has no children) and records it', () => {
      curl.setRoute('POST /api/v1/drain', { curlExit: 7 });
      const result = run(RESTART, ['--reason', 'r']);
      expect(result.status, result.stderr).toBe(0);
      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
      expect(readFileSync(auditFile, 'utf8')).toContain('drain=skipped_unreachable');
    });

    it('proceeds without a drain when there is no socket, and records it', () => {
      const result = run(RESTART, ['--reason', 'r'], { PI_WEB_UI_INTERNAL_API_SOCKET: path.join(dir, 'absent.sock') });
      expect(result.status, result.stderr).toBe(0);
      expect(curl.requests()).toEqual([]);
      expect(readFileSync(auditFile, 'utf8')).toContain('drain=skipped_no_daemon');
    });

    it('--force without --reason is refused: an undrained restart must say why', () => {
      const result = run(RESTART, ['--force']);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('--reason');
      expect(lines(systemctlLog)).toEqual([]);
      expect(existsSync(auditFile)).toBe(false);
    });

    it('--force --reason restarts without draining and records the override and its reason', () => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: settled });
      const result = run(RESTART, ['--force', '--reason', 'wedged daemon, owner approved']);
      expect(result.status, result.stderr).toBe(0);
      expect(curl.requests()).toEqual([]);
      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
      const audit = readFileSync(auditFile, 'utf8');
      expect(audit).toContain('drain=forced');
      expect(audit).toContain('reason=wedged');
    });

    it('refuses unknown arguments rather than ignoring them', () => {
      const result = run(RESTART, ['--dry-run']);
      expect(result.status).toBe(64);
      expect(lines(systemctlLog)).toEqual([]);
    });

    it('--show-targets prints the production defaults (unchanged apart from drain-by-default) and does nothing', () => {
      const clean: NodeJS.ProcessEnv = { PATH: `${curl.binDir}:${process.env.PATH}`, HOME: process.env.HOME ?? '/root' };
      const result = spawnSync('bash', [RESTART, '--show-targets'], { encoding: 'utf8', env: clean });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('unit=pi-web-ui.service');
      expect(result.stdout).toContain('socket=/root/.pi-web-ui/internal-api.sock');
      expect(result.stdout).toContain('token_file=/root/.pi-web-ui/internal-api-token');
      expect(result.stdout).toContain('systemctl=systemctl');
      expect(result.stdout).toContain('notify=/root/pi-web-ui/scripts/notify.sh');
      expect(result.stdout).toContain('stop_audit=/root/.pi-web-ui/stop-audit.log');
      expect(result.stdout).toContain('drain=default');
      expect(result.stdout).toContain('drain_timeout_seconds=600');
      expect(result.stdout).toContain('on_timeout=restart');
      expect(curl.requests()).toEqual([]);
      expect(lines(systemctlLog)).toEqual([]);
    });
  });

  describe('npm run production:drain-restart', () => {
    it('is the lock-held drain-restart entry point', () => {
      const pkg = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      expect(pkg.scripts['production:drain-restart']).toBe('bash scripts/with-production-lock.sh bash scripts/restart-production.sh');
      // The plain lock wrapper stays a generic argv runner.
      expect(pkg.scripts['production:lock']).toBe('bash scripts/with-production-lock.sh');
    });
  });

  describe('with-production-lock.sh', () => {
    it.each([
      [['systemctl', 'restart', UNIT]],
      [['systemctl', 'restart', UNIT.replace(/\.service$/, '')]],
      [['sudo', 'systemctl', 'restart', UNIT]],
      [['systemctl', 'try-restart', UNIT]],
    ])('routes a bare service restart %j through drain-then-restart', (argv) => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: settled });
      const result = run(LOCK, argv);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('drain-then-restart');
      expect(curl.requests().map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/v1/drain']);
      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
      expect(readFileSync(auditFile, 'utf8')).toMatch(/reason=production:lock/);
    });

    it('leaves other commands (including other units and read-only verbs) untouched', () => {
      const status = run(LOCK, ['systemctl', 'status', UNIT]);
      expect(status.status).toBe(0);
      const other = run(LOCK, ['systemctl', 'restart', 'some-other.service']);
      expect(other.status).toBe(0);
      expect(lines(systemctlLog)).toEqual([`status ${UNIT}`, 'restart some-other.service']);
      expect(curl.requests()).toEqual([]);
    });

    it('is re-entrant for a command that already holds the same lock', () => {
      curl.setRoute('POST /api/v1/drain', { status: 200, body: settled });
      // A locked deploy block that calls production:drain-restart inside it.
      const nested = run(LOCK, ['bash', LOCK, 'bash', RESTART, '--reason', 'nested deploy']);
      expect(nested.status, nested.stderr).toBe(0);
      expect(lines(systemctlLog)).toEqual([`restart ${UNIT}`]);
    });

    it('still refuses a second, independent holder of the lock', async () => {
      // A genuinely concurrent holder (separate process, no inherited marker).
      const ready = path.join(dir, 'holder.ready');
      const holderProcess = spawn('bash', [LOCK, 'bash', '-c', `touch '${ready}'; sleep 2`], { env: env(), stdio: 'ignore' });
      const exited = new Promise<void>((resolve) => holderProcess.once('exit', () => resolve()));
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 20));
      const second = spawnSync('bash', [LOCK, 'true'], { encoding: 'utf8', env: env() });
      expect(second.status).toBe(75);
      await exited;
    });

    it('restart-pi-web-ui.sh (its own active-turn pre-flight) is not routed a second time', () => {
      curl.setRoute('GET /api/v1/capacity', { status: 200, body: { activeTurns: 0 } });
      // Production argv: the bare systemctl call on the default unit, under the lock.
      const result = run(RESTART_PI_WEB_UI, ['--reason', 'weekly refresh'], {
        PI_WEB_UI_SERVICE_UNIT: 'pi-web-ui.service',
        PI_WEB_UI_RESTART_SYSTEMCTL: '',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(curl.requests().map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/capacity']);
      expect(lines(systemctlLog)).toEqual(['restart pi-web-ui']);
      expect(lines(auditFile).filter((l) => l.startsWith('RESTART-REQUESTED'))).toHaveLength(1);
    });
  });
});

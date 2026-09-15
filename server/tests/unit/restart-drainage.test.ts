import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Restart drainage (2026-09-15).
 *
 * `systemctl restart pi-web-ui.service` uses KillMode=control-group: every
 * process inside the unit — including mid-turn orchestration children — is
 * killed with it. A restart issued while children still have active turns is
 * therefore a silent mass-abort of delegated work, and it has already happened
 * once (2026-09-15 08:30).
 *
 * Both restart paths the repository owns must therefore run the same
 * capacity pre-flight before restarting:
 *
 *   * query GET /api/v1/capacity on the Internal API socket;
 *   * refuse with exit code 1 while `.activeTurns > 0`;
 *   * proceed only when it is zero (or when the caller passes `--force`,
 *     the explicit, named override).
 *
 * The scripts are exercised for real — real bash, a real unix socket file,
 * real jq — because the refusal lives in the glue, not in pure logic. One
 * seam exists because of THIS agent-sandbox environment, not production:
 * connect() from any process spawned below the vitest worker is blackholed
 * here (TCP and unix socket alike), so neither spawned `curl` nor a spawned
 * HTTP client can reach the fake API. The tests therefore put a `curl` shim
 * first on PATH: it logs its verbatim argument vector, answers ONLY the exact
 * expected capacity query (right socket, right bearer token, right URL) with
 * a canned response file, and otherwise fails like curl would. The real
 * `curl --unix-socket` transport is production behaviour and was verified
 * live outside this sandbox (a detached curl run delivered the same request
 * to the same kind of fake API during this test's development).
 *
 * Everything else stays hermetic by the seams the scripts expose
 * (`PI_WEB_UI_INTERNAL_API_SOCKET`, `PI_WEB_UI_INTERNAL_API_TOKEN_FILE`,
 * `PI_WEB_UI_RESTART_SYSTEMCTL`, …): the stub `systemctl` only appends to a
 * log, so no test can restart anything real.
 */

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts');
const restartProductionScript = path.join(SCRIPTS_DIR, 'restart-production.sh');
const restartScript = path.join(SCRIPTS_DIR, 'restart-pi-web-ui.sh');

const TOKEN = 'drainage-test-bearer-token';

interface CapacityApi {
  /** Real AF_UNIX socket file, so the scripts' `-S` check is exercised. */
  socketPath: string;
  tokenPath: string;
  /** Every capacity query the scripts attempted, as captured by the shim. */
  requests: string[][];
  setActiveTurns(activeTurns: number): void;
  close(): Promise<void>;
}

/**
 * A stand-in for the production Internal API capacity endpoint. The socket is
 * real; the HTTP conversation is served by the PATH curl shim, which only
 * answers the exact query the scripts are supposed to build.
 */
async function startCapacityApi(dir: string): Promise<CapacityApi> {
  const socketPath = path.join(dir, 'internal-api.sock');
  const tokenPath = path.join(dir, 'internal-api-token');
  const responseFile = path.join(dir, 'capacity-response.json');
  writeFileSync(tokenPath, TOKEN);
  const active = { turns: 0 };
  const writeResponse = (): void =>
    writeFileSync(
      responseFile,
      JSON.stringify({ available: active.turns === 0, activeTurns: active.turns, maxActiveTurns: 6 }),
    );
  writeResponse();

  const logPath = path.join(dir, 'curl-shim.args.log');
  const shim = path.join(dir, 'curl');
  writeFileSync(
    shim,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      "const { appendFileSync } = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      'const log = process.env.PI_WEB_UI_CURL_SHIM_LOG;',
      "if (log) appendFileSync(log, JSON.stringify(args) + '\\n');",
      "const expectedSocket = process.env.PI_WEB_UI_FAKE_CAPACITY_SOCKET;",
      "const expectedToken = process.env.PI_WEB_UI_FAKE_CAPACITY_TOKEN;",
      "const responseFile = process.env.PI_WEB_UI_FAKE_CAPACITY_RESPONSE;",
      'const socketIndex = args.indexOf(\'--unix-socket\');',
      'const headerIndex = args.indexOf(\'-H\');',
      'const url = args[args.length - 1];',
      'const socket = socketIndex >= 0 ? args[socketIndex + 1] : undefined;',
      "const authorization = headerIndex >= 0 ? args[headerIndex + 1].replace(/^Authorization:\\s*/i, '') : undefined;",
      'if (',
      '  socket === expectedSocket &&',
      "  url.endsWith('/api/v1/capacity') &&",
      "  authorization === 'Bearer ' + expectedToken",
      ') {',
      '  process.stdout.write(require(\'node:fs\').readFileSync(responseFile));',
      '  process.exit(0);',
      '}',
      "console.error('curl-shim: query did not match the expected capacity request');",
      'process.exit(7);',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);

  // Holds the unix socket file open so the scripts' `-S` check sees a socket.
  const holder = net.createServer();
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject);
    holder.listen(socketPath, resolve);
  });

  return {
    socketPath,
    tokenPath,
    get requests(): string[][] {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
    setActiveTurns(next: number): void {
      active.turns = next;
      writeResponse();
    },
    close: (): Promise<void> =>
      new Promise<void>((resolve) =>
        holder.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        }),
      ),
  };
}

/** An executable stub that appends its argument vector to a log, nothing else. */
function writeRecordingStub(dir: string, name: string): { stubPath: string; logPath: string } {
  const logPath = path.join(dir, `${name}.calls.log`);
  const stubPath = path.join(dir, name);
  writeFileSync(stubPath, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`);
  chmodSync(stubPath, 0o755);
  return { stubPath, logPath };
}

function readLog(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0);
}

/**
 * A `systemctl` stub at the FRONT of PATH, sharing the env-var stub's call log.
 *
 * This is deliberately independent of the script under test. The env-var seam
 * (`PI_WEB_UI_RESTART_SYSTEMCTL`) is honoured by the implementation, so it
 * disappears exactly when that implementation is reverted for a red-proof run —
 * which is how production was restarted for real at 2026-09-15T14:27:05Z. A
 * PATH shim is supplied by the test environment, not by the code under test,
 * so it cannot be reverted along with it.
 */
function writeSystemctlPathStub(dir: string, logPath: string): string {
  const stubPath = path.join(dir, 'systemctl');
  writeFileSync(stubPath, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`);
  chmodSync(stubPath, 0o755);
  return stubPath;
}

/**
 * A bound on each script run so a pathological hang fails the test instead of
 * wedging the whole suite. Healthy runs finish in well under a second.
 */
const RUN_TIMEOUT_MS = 30_000;

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env });
}

describe('restart drainage — capacity pre-flight before production restarts', () => {
  let dir: string;
  let api: CapacityApi;
  let systemctl: { stubPath: string; logPath: string };
  let notify: { stubPath: string; logPath: string };
  let auditFile: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pi-restart-drainage-'));
    api = await startCapacityApi(dir);
    systemctl = writeRecordingStub(dir, 'systemctl-stub');
    // Defence in depth: the PATH shim shares the same call log, so every
    // assertion below holds whichever route a script takes to `systemctl`.
    writeSystemctlPathStub(dir, systemctl.logPath);
    notify = writeRecordingStub(dir, 'notify-stub');
    auditFile = path.join(dir, 'stop-audit.log');
  });

  afterEach(async () => {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('restart-production.sh', () => {
    const productionEnv = (): NodeJS.ProcessEnv => ({
      PI_WEB_UI_INTERNAL_API_SOCKET: api.socketPath,
      PI_WEB_UI_INTERNAL_API_TOKEN_FILE: api.tokenPath,
      PI_WEB_UI_RESTART_SYSTEMCTL: systemctl.stubPath,
      PI_WEB_UI_NOTIFY_SCRIPT: notify.stubPath,
      PI_WEB_UI_CURL_SHIM_LOG: path.join(dir, 'curl-shim.args.log'),
      PI_WEB_UI_FAKE_CAPACITY_SOCKET: api.socketPath,
      PI_WEB_UI_FAKE_CAPACITY_TOKEN: TOKEN,
      PI_WEB_UI_FAKE_CAPACITY_RESPONSE: path.join(dir, 'capacity-response.json'),
      PATH: `${dir}:${process.env.PATH}`,
    });

    it('queries capacity and refuses with exit code 1 while active turns are in progress', () => {
      api.setActiveTurns(3);

      const result = runScript(restartProductionScript, [], {
        ...process.env,
        ...productionEnv(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('3');
      expect(result.stderr).toContain('active');
      // The refusal must name its own escape hatch.
      expect(result.stderr).toContain('--force');
      // Nothing was restarted and nothing was announced as restarting.
      expect(readLog(systemctl.logPath)).toEqual([]);
      expect(readLog(notify.logPath)).toEqual([]);
    });

    it('queries the authenticated capacity endpoint over the unix socket', () => {
      api.setActiveTurns(0);

      runScript(restartProductionScript, [], { ...process.env, ...productionEnv() });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]).toContain('--unix-socket');
      expect(api.requests[0]).toContain(api.socketPath);
      expect(api.requests[0]).toContain('-H');
      expect(api.requests[0]).toContain('Authorization: Bearer drainage-test-bearer-token');
      expect(api.requests[0]).toContain('http://localhost/api/v1/capacity');
    });

    it('proceeds to restart when active turns are zero', () => {
      api.setActiveTurns(0);

      const result = runScript(restartProductionScript, [], {
        ...process.env,
        ...productionEnv(),
      });

      expect(result.status).toBe(0);
      expect(readLog(systemctl.logPath)).toEqual(['restart pi-web-ui.service']);
    });

    it('treats --force as the explicit override and restarts despite active turns', () => {
      api.setActiveTurns(2);

      const result = runScript(restartProductionScript, ['--force'], {
        ...process.env,
        ...productionEnv(),
      });

      expect(result.status).toBe(0);
      expect(readLog(systemctl.logPath)).toEqual(['restart pi-web-ui.service']);
    });
  });

  describe('restart-pi-web-ui.sh', () => {
    const scriptEnv = (): NodeJS.ProcessEnv => ({
      PI_WEB_UI_INTERNAL_API_SOCKET: api.socketPath,
      PI_WEB_UI_INTERNAL_API_TOKEN_FILE: api.tokenPath,
      PI_WEB_UI_RESTART_SYSTEMCTL: systemctl.stubPath,
      // Keep unit runs out of the production journal and stop-audit file: the
      // fake systemd-cat and the temp audit path are test seams, the audit
      // behaviour itself is asserted separately below.
      PI_WEB_UI_SYSTEMD_CAT: notify.stubPath,
      PI_WEB_UI_STOP_AUDIT_FILE: auditFile,
      PI_WEB_UI_CURL_SHIM_LOG: path.join(dir, 'curl-shim.args.log'),
      PI_WEB_UI_FAKE_CAPACITY_SOCKET: api.socketPath,
      PI_WEB_UI_FAKE_CAPACITY_TOKEN: TOKEN,
      PI_WEB_UI_FAKE_CAPACITY_RESPONSE: path.join(dir, 'capacity-response.json'),
      PATH: `${dir}:${process.env.PATH}`,
    });

    it('queries capacity and refuses with exit code 1 while active turns are in progress', () => {
      api.setActiveTurns(4);

      const result = runScript(restartScript, ['--reason', 'drainage test', '--no-lock'], {
        ...process.env,
        ...scriptEnv(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('4');
      expect(result.stderr).toContain('active');
      expect(result.stderr).toContain('--force');
      // A refused restart never stops the service, so it must not write the
      // RESTART-REQUESTED record that stop-audit forensics reads.
      expect(existsSync(auditFile)).toBe(false);
      expect(readLog(systemctl.logPath)).toEqual([]);
    });

    it('proceeds to restart when active turns are zero', () => {
      api.setActiveTurns(0);

      const result = runScript(restartScript, ['--reason', 'drainage test', '--no-lock'], {
        ...process.env,
        ...scriptEnv(),
      });

      expect(result.status).toBe(0);
      expect(api.requests).toHaveLength(1);
      expect(readLog(systemctl.logPath)).toEqual(['restart pi-web-ui']);
    });

    it('treats --force as the explicit override and restarts despite active turns', () => {
      api.setActiveTurns(5);

      const result = runScript(restartScript, ['--reason', 'drainage test', '--force', '--no-lock'], {
        ...process.env,
        ...scriptEnv(),
      });

      expect(result.status).toBe(0);
      expect(readLog(systemctl.logPath)).toEqual(['restart pi-web-ui']);
      // The forced restart is still a restart: the requester record is written.
      expect(readFileSync(auditFile, 'utf8')).toContain('RESTART-REQUESTED');
      // The reason is recorded %q-quoted, so assert the stem, not the phrase.
      expect(readFileSync(auditFile, 'utf8')).toContain('reason=drainage');
    });

    it('intercepts a bare `systemctl` call through PATH, not only the env-var seam', () => {
      // The lesson of the 2026-09-15T14:27:05Z production restart, which this
      // suite caused: its only interception was PI_WEB_UI_RESTART_SYSTEMCTL, an
      // env seam honoured BY THE SCRIPT UNDER TEST. Reverting the implementation
      // for a red-proof run therefore removed the guard and the interception
      // together, the script fell through to a bare `systemctl restart
      // pi-web-ui`, and it restarted production for real — killing the session
      // that was running the test. A PATH shim cannot be stashed away with the
      // implementation, so a bare call is intercepted however the script under
      // test treats its env seams.
      //
      // Deliberately a READ-ONLY subcommand: this test must not be able to stop
      // the service even while it is red, which is the whole point of it.
      const naive = path.join(dir, 'naive-restart-script.sh');
      writeFileSync(naive, '#!/usr/bin/env bash\nsystemctl status pi-web-ui\n');
      chmodSync(naive, 0o755);
      const before = readLog(systemctl.logPath).length;

      const result = spawnSync('bash', [naive], { encoding: 'utf8', env: scriptEnv() });

      expect(result.status).toBe(0);
      expect(readLog(systemctl.logPath).slice(before)).toEqual(['status pi-web-ui']);
    });
  });
});

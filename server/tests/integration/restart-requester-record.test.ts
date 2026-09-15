import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Every repo-owned restart path must name its requester (2026-09-15).
 *
 * Two paths can restart production, and until now only one of them recorded who
 * asked:
 *
 *   * `scripts/restart-pi-web-ui.sh` wrote a `RESTART-REQUESTED` line to the
 *     journal and the durable stop-audit file;
 *   * `scripts/restart-production.sh` — the canonical pre-flight path an agent is
 *     told to use — restarted the unit and announced itself only through the
 *     notification hook.
 *
 * That gap is not theoretical. Production was restarted at 15:35:23Z that day,
 * the "Production restart initiated" notification was delivered at 15:35:23Z
 * (that script's own notify call), and the durable stop-audit file has no
 * requester record for it. A restart by the repository's own recommended path
 * looked, in the forensic record, exactly like an unexplained one — the one
 * question the record exists to answer.
 *
 * Every sink a restart path can reach is sealed below, deliberately. Seal only
 * the sink you assert on and the others are still live: during this file's first
 * run the refusal case skipped its pre-flight (a plain file is not a unix
 * socket), reached the real `notify.sh`, and then attempted a real
 * `systemctl restart pi-web-ui.service`, which the test-harness guard refused.
 */

const temporaryDirectories: string[] = [];
const temporaryServers: net.Server[] = [];
afterEach(() => {
  for (const server of temporaryServers.splice(0)) server.close();
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDirectory(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

const scriptsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts');

interface Fixture {
  auditFile: string;
  socketPath: string;
  /** The capacity answer the shim will serve. */
  setActiveTurns(activeTurns: number): void;
  /** Environment with every reachable sink sealed. */
  env(): Record<string, string>;
}

async function startFixture(dir: string): Promise<Fixture> {
  const socketPath = path.join(dir, 'internal-api.sock');
  // A REAL listening socket: the pre-flight's own guard is `[ -S "$SOCKET" ]`,
  // so a plain file would silently skip the check the test means to exercise.
  const server = net.createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  temporaryServers.push(server);
  writeFileSync(path.join(dir, 'internal-api-token'), 'token');

  const responseFile = path.join(dir, 'capacity-response.json');
  const writeResponse = (activeTurns: number): void =>
    writeFileSync(responseFile, JSON.stringify({ available: activeTurns === 0, activeTurns, maxActiveTurns: 6 }));
  writeResponse(0);

  // The sandbox blackholes connect() from processes below the vitest worker, so
  // the capacity answer is served by a PATH curl that logs and answers exactly
  // the expected query — the same technique restart-drainage.test.ts uses.
  const binDir = path.join(dir, 'bin');
  chmodSync(dir, 0o755);
  spawnSync('mkdir', ['-p', binDir]);
  const curl = path.join(binDir, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash\ncat '${responseFile}'\n`);
  chmodSync(curl, 0o755);

  const auditFile = path.join(dir, 'stop-audit.log');
  const systemctlStub = path.join(dir, 'systemctl');
  writeFileSync(systemctlStub, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(systemctlStub, 0o755);
  const notifyStub = path.join(dir, 'notify.sh');
  writeFileSync(notifyStub, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(notifyStub, 0o755);

  return {
    auditFile,
    socketPath,
    setActiveTurns: writeResponse,
    env: () => ({
      ...process.env,
      PI_WEB_UI_INTERNAL_API_SOCKET: socketPath,
      PI_WEB_UI_INTERNAL_API_TOKEN_FILE: path.join(dir, 'internal-api-token'),
      PI_WEB_UI_RESTART_SYSTEMCTL: systemctlStub,
      PI_WEB_UI_NOTIFY_SCRIPT: notifyStub,
      PI_WEB_UI_SYSTEMD_CAT: path.join(dir, 'no-such-systemd-cat'),
      PI_WEB_UI_STOP_AUDIT_FILE: auditFile,
      PATH: `${binDir}:${process.env.PATH}`,
    }),
  };
}

describe('every repo-owned restart path names its requester', () => {
  for (const script of ['restart-pi-web-ui.sh', 'restart-production.sh']) {
    it(`${script} writes a RESTART-REQUESTED record to the durable audit file`, async () => {
      const dir = fixtureDirectory('pi-web-ui-requester-');
      const fixture = await startFixture(dir);

      const result = spawnSync(
        'bash',
        [path.join(scriptsDirectory, script), '--reason', 'requester-record-test'],
        { encoding: 'utf8', env: fixture.env() },
      );

      expect(result.status, `${script} stderr: ${result.stderr}`).toBe(0);
      expect(existsSync(fixture.auditFile)).toBe(true);
      const record = readFileSync(fixture.auditFile, 'utf8');
      expect(record).toContain('RESTART-REQUESTED');
      expect(record).toContain('requester-record-test');
      // The record must identify the caller well enough to be actionable.
      for (const field of ['uid=', 'pid=', 'ppid=', 'cwd=', 'argv=', 'ancestors=']) {
        expect(record, field).toContain(field);
      }
    });
  }

  it('a restart refused by the pre-flight writes no record', async () => {
    const dir = fixtureDirectory('pi-web-ui-requester-');
    const fixture = await startFixture(dir);
    fixture.setActiveTurns(2);

    const result = spawnSync('bash', [path.join(scriptsDirectory, 'restart-production.sh')], {
      encoding: 'utf8',
      env: fixture.env(),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing');
    expect(existsSync(fixture.auditFile)).toBe(false);
  });
});

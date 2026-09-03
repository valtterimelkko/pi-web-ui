import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const probeScript = path.resolve(process.cwd(), '../scripts/health-probe.sh');

function executable(file: string, body: string): string {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function runProbe(dir: string, curl: string): ReturnType<typeof spawnSync> {
  spawnSync('python3', ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', path.join(dir, 'api.sock')]);
  return spawnSync('bash', [probeScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PI_WEB_UI_HEALTH_CURL: curl,
      PI_WEB_UI_HEALTH_STATE_FILE: path.join(dir, 'failures'),
      PI_WEB_UI_HEALTH_NOTIFY: executable(path.join(dir, 'notify'), `printf '%s\\n' "$*" >> '${path.join(dir, 'notifications')}'`),
      PI_WEB_UI_HEALTH_LOGGER: executable(path.join(dir, 'logger'), `printf '%s\\n' "$*" >> '${path.join(dir, 'journal')}'`),
      PI_WEB_UI_INTERNAL_API_SOCKET: path.join(dir, 'api.sock'),
      PI_WEB_UI_INTERNAL_API_TOKEN_PATH: path.join(dir, 'token'),
    },
  });
}

describe('health-probe.sh', () => {
  it('ships alert-only systemd units with watchdog notification enabled', () => {
    const deployDir = path.resolve(process.cwd(), '../deploy/systemd');
    const webService = readFileSync(path.join(deployDir, 'pi-web-ui.service'), 'utf8');
    const probeService = readFileSync(path.join(deployDir, 'pi-web-ui-health-probe.service'), 'utf8');
    const probeTimer = readFileSync(path.join(deployDir, 'pi-web-ui-health-probe.timer'), 'utf8');

    expect(webService).toContain('Type=notify');
    expect(webService).toContain('NotifyAccess=all');
    expect(webService).toContain('WatchdogSec=45');
    expect(probeService).toContain('ExecStart=/root/pi-web-ui/scripts/health-probe.sh');
    expect(probeService).not.toMatch(/systemctl\s+restart/);
    expect(probeTimer).toContain('OnUnitActiveSec=1min');
  });

  it('accepts only a successful authenticated Internal API health response', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-health-probe-ok-'));
    writeFileSync(path.join(dir, 'token'), 'fixture-token');
    const curl = executable(path.join(dir, 'curl'), "printf '%s' '{\"status\":\"ok\",\"contract\":{\"contractVersion\":\"1.31.0\"}}'");

    const result = runProbe(dir, curl);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('rejects the SPA HTML false-positive even when curl succeeds', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-health-probe-html-'));
    writeFileSync(path.join(dir, 'token'), 'fixture-token');
    const curl = executable(path.join(dir, 'curl'), "printf '%s' '<!doctype html><title>Pi Web UI</title>'");

    expect(runProbe(dir, curl).status).toBe(1);
  });

  it('alerts once after three consecutive failures and never restarts the service', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-health-probe-fail-'));
    writeFileSync(path.join(dir, 'token'), 'fixture-token');
    const curl = executable(path.join(dir, 'curl'), 'exit 7');

    expect(runProbe(dir, curl).status).toBe(1);
    expect(runProbe(dir, curl).status).toBe(1);
    expect(runProbe(dir, curl).status).toBe(1);

    expect(readFileSync(path.join(dir, 'notifications'), 'utf8')).toContain('blocked Pi Web UI health probe failed');
    expect(readFileSync(path.join(dir, 'journal'), 'utf8')).toContain('consecutive_failures=3');
  });
});

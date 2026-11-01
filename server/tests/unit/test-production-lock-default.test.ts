import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The default test production-lock path (the /tmp 0700 incident).
 *
 * server/tests/setup-env.ts redirects PI_WEB_UI_PRODUCTION_LOCK so no test can
 * take production's real control lock. That default used to be a file directly
 * inside os.tmpdir(), and scripts/with-production-lock.sh repairs its lock
 * directory to 0700 — so any suite that ran a production-control script without
 * naming its own lock path turned the shared /tmp into 0700 (alerts 5, 16 and 21
 * Oct 2026, again 1 Nov 2026).
 */
describe('the test production-lock default', () => {
  const lockPath = process.env.PI_WEB_UI_PRODUCTION_LOCK ?? '';

  it('is set by the test environment', () => {
    expect(lockPath).not.toBe('');
  });

  it('does not live directly inside the shared temporary directory', () => {
    expect(path.dirname(lockPath)).not.toBe(tmpdir());
  });

  it('lives in a private per-run directory that no other process can enter', () => {
    const lockDir = path.dirname(lockPath);
    expect(lockDir.startsWith(`${tmpdir()}${path.sep}`)).toBe(true);
    expect(path.basename(lockDir).startsWith('pi-web-ui-test-production-lock-')).toBe(true);
    // A mkdtemp directory: 0700. The lock script's chmod 700 on it is then a
    // no-op instead of a host incident.
    expect(statSync(lockDir).mode & 0o777).toBe(0o700);
  });
});

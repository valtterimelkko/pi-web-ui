/**
 * W4 L5: the disposable lab server's isolated agent dir must carry the HOST
 * credential store. boot-disposable-server.sh starts the server with
 * PI_CODING_AGENT_DIR="$STATE_DIR/pi-agent" — a fresh empty dir — so the pi
 * runtime resolves no provider auth there and every worker model turn dies in
 * ~1 s with no assistant output (the C22 attempt-02/03/04 failure). The boot
 * script therefore seeds the store from ${HOME}/.pi/agent/auth.json (mode 600)
 * and surfaces a missing host store honestly — never silently, never invented.
 *
 * These tests exercise the script's `seed-auth` subcommand directly: a real
 * copy into a temp state dir, and the honest-missing notice.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'scripts', 'voice-live-lab', 'boot-disposable-server.sh');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runSeedAuth(homeDir: string, stateDir: string): { stdout: string; status: number } {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync('bash', [SCRIPT, 'seed-auth'], {
      env: { ...process.env, HOME: homeDir, VOICE_LAB_DIR: stateDir },
      encoding: 'utf8',
    });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  return { stdout, status };
}

describe('boot-disposable-server auth seeding (L5)', () => {
  it('seeds the isolated pi-agent dir from the host credential store with mode 600', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-home-'));
    const state = mkdtempSync(path.join(tmpdir(), 'seed-state-'));
    dirs.push(home, state);
    mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(path.join(home, '.pi', 'agent', 'auth.json'), JSON.stringify({ 'kimi-coding': { marker: 'host-store' } }));

    const { stdout, status } = runSeedAuth(home, state);

    expect(status).toBe(0);
    expect(stdout).toContain('auth-store=seeded');
    const seeded = path.join(state, 'pi-agent', 'auth.json');
    expect(existsSync(seeded)).toBe(true);
    expect(readFileSync(seeded, 'utf8')).toContain('host-store');
    expect((statSync(seeded).mode & 0o777).toString(8)).toBe('600');
  });

  it('surfaces a missing host store honestly — the seed is never silently skipped or invented', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'seed-empty-home-'));
    const state = mkdtempSync(path.join(tmpdir(), 'seed-empty-state-'));
    dirs.push(home, state);

    const { stdout, status } = runSeedAuth(home, state);

    expect(status).toBe(0);
    expect(stdout).toContain('auth-store=missing');
    expect(existsSync(path.join(state, 'pi-agent', 'auth.json'))).toBe(false);
  });

  it('boot declares the seeding contract in its own text (the copy cannot be dropped silently)', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain('seed-auth');
    expect(script).toContain('auth.json');
    expect(script).toContain('chmod 600');
  });
});

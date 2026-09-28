import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkSessionsDirSafety,
  isDisposableValidationDir,
  protectedSessionRoots,
} from '../../../../scripts/watcher-churn/safety.js';

/**
 * B1.1 correction 03, review minor 7: the churn harness writes synthetic session
 * files and persistent directories into `--sessions-dir`, so the CLI must fail
 * closed on a protected (production) sessions root and require evidence that the
 * target is a disposable validation directory.
 */
describe('watcher-churn sessions-dir safety guard', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('always refuses the protected production sessions roots', () => {
    const home = '/home/tester';
    for (const root of protectedSessionRoots(home)) {
      expect(checkSessionsDirSafety({ sessionsDir: root, homeDir: home, hasDisposableMarker: true }).ok).toBe(false);
      expect(checkSessionsDirSafety({ sessionsDir: path.join(root, 'nested'), homeDir: home, hasDisposableMarker: true }).ok).toBe(false);
    }
  });

  it('refuses a non-protected path with no disposable marker, and allows it with an explicit override', () => {
    const dir = '/tmp/b1-1-not-a-validation-dir';
    const refused = checkSessionsDirSafety({ sessionsDir: dir, homeDir: '/home/tester', hasDisposableMarker: false });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/no disposable-validation marker/);

    expect(checkSessionsDirSafety({ sessionsDir: dir, homeDir: '/home/tester', hasDisposableMarker: false, allowUnsafe: true }).ok).toBe(true);
  });

  it('allows a non-protected path once a disposable marker is present', () => {
    expect(checkSessionsDirSafety({ sessionsDir: '/tmp/validation/pi-sessions', homeDir: '/home/tester', hasDisposableMarker: true }).ok).toBe(true);
  });

  it('detects a disposable-validation marker in an ancestor', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'churn-safety-'));
    const validationDir = path.join(tempDir, 'validation');
    const sessionsDir = path.join(validationDir, 'pi-sessions');
    await mkdir(sessionsDir, { recursive: true });

    expect(isDisposableValidationDir(sessionsDir)).toBe(false);
    await writeFile(path.join(validationDir, '.validation-server.lock'), '');
    expect(isDisposableValidationDir(sessionsDir)).toBe(true);
  });

  it('does not treat a marker in an excluded ancestor (root / temp root / $HOME) as disposable', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'churn-safety-excluded-'));
    const validationDir = path.join(tempDir, 'validation');
    const sessionsDir = path.join(validationDir, 'pi-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(tempDir, 'server-process.json'), '');

    // A stray marker in an excluded ancestor must not whitelist the target.
    expect(isDisposableValidationDir(sessionsDir, { excludedDirs: [tempDir] })).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSessionsDirSafe,
  checkSessionsDirSafety,
  isDisposableValidationDir,
  protectedSessionRoots,
} from '../../../../scripts/watcher-churn/safety.js';

/**
 * B1.1 corrections 03/04, review minors 7 and r2 major 2: the churn harness
 * writes synthetic session files and persistent directories into
 * `--sessions-dir`, so the CLI must fail closed on a protected (production)
 * sessions root, require a disposable-validation marker, keep the resolved
 * target inside the marked validation directory, and refuse a symlink that
 * resolves to a protected root.
 */
describe('watcher-churn sessions-dir safety guard', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('always refuses a resolved target inside a protected root, even with a marker', () => {
    for (const root of protectedSessionRoots('/home/tester')) {
      const verdict = checkSessionsDirSafety({
        realSessionsDir: path.join(root, 'nested'),
        realProtectedRoots: protectedSessionRoots('/home/tester'),
        realDisposableRoot: root,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/protected/);
    }
  });

  it('refuses a path with no disposable marker, and allows it with an explicit override', () => {
    const refused = checkSessionsDirSafety({
      realSessionsDir: '/tmp/not-validation/pi-sessions',
      realProtectedRoots: [],
      realDisposableRoot: undefined,
    });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/no disposable-validation marker/);

    expect(checkSessionsDirSafety({
      realSessionsDir: '/tmp/not-validation/pi-sessions',
      realProtectedRoots: [],
      realDisposableRoot: undefined,
      allowUnsafe: true,
    }).ok).toBe(true);
  });

  it('refuses a resolved target outside the marked disposable validation directory', () => {
    const verdict = checkSessionsDirSafety({
      realSessionsDir: '/tmp/elsewhere/pi-sessions',
      realProtectedRoots: [],
      realDisposableRoot: '/tmp/validation',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/outside the marked disposable validation directory/);
  });

  it('accepts a real sessions dir inside a marked validation directory', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'churn-safety-ok-'));
    const validationDir = path.join(tempDir, 'validation');
    const sessionsDir = path.join(validationDir, 'pi-sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(validationDir, '.validation-server.lock'), '');

    expect(() => assertSessionsDirSafe(sessionsDir, { protectedRoots: [] })).not.toThrow();
  });

  it('refuses a symlinked sessions dir that resolves to a protected root', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'churn-safety-symlink-'));
    const validationDir = path.join(tempDir, 'validation');
    await mkdir(validationDir, { recursive: true });
    await writeFile(path.join(validationDir, '.validation-server.lock'), '');
    const fixtureProtected = path.join(tempDir, 'fixture-protected-sessions');
    await mkdir(fixtureProtected, { recursive: true });
    const link = path.join(validationDir, 'pi-sessions');
    await symlink(fixtureProtected, link, 'dir');

    expect(() => assertSessionsDirSafe(link, { protectedRoots: [fixtureProtected] })).toThrow(/protected/);
  });

  it('refuses a symlinked sessions dir whose real target is outside the marked validation directory', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'churn-safety-symlink-outside-'));
    const validationDir = path.join(tempDir, 'validation');
    await mkdir(validationDir, { recursive: true });
    await writeFile(path.join(validationDir, '.validation-server.lock'), '');
    const elsewhere = path.join(tempDir, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const link = path.join(validationDir, 'pi-sessions');
    await symlink(elsewhere, link, 'dir');

    expect(() => assertSessionsDirSafe(link, { protectedRoots: [] })).toThrow(/no disposable-validation marker|outside the marked/);
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

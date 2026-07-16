import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireValidationDirectoryLock,
  assertSafeValidationDirectory,
  createDefaultValidationDirectory,
  findAvailablePorts,
  reserveAvailablePorts,
} from '../../../src/live-validation/validation-server-options.js';

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe('validation server concurrent launch options', () => {
  it('rejects using the production state root as a validation directory', () => {
    expect(() => assertSafeValidationDirectory('/root/.pi-web-ui', ['/root/.pi-web-ui/internal-api.sock']))
      .toThrow(/production state directory/i);
    expect(() => assertSafeValidationDirectory('/root/.pi-web-ui/validation/run-1', ['/root/.pi-web-ui/internal-api.sock']))
      .not.toThrow();
  });

  it('rejects a validation path whose existing ancestor resolves into production state', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-validation-symlink-'));
    cleanupPaths.push(root);
    const production = join(root, 'production');
    mkdirSync(production);
    const alias = join(root, 'alias');
    symlinkSync(production, alias, 'dir');

    expect(() => assertSafeValidationDirectory(join(alias, 'future-run'), [join(production, 'internal-api.sock')]))
      .toThrow(/production state directory/i);
  });

  it('creates a short unique directory for every default launch', () => {
    const parent = mkdtempSync(join(tmpdir(), 'pi-validation-options-'));
    cleanupPaths.push(parent);

    const first = createDefaultValidationDirectory(parent);
    const second = createDefaultValidationDirectory(parent);

    expect(first).not.toBe(second);
    expect(first.startsWith(parent)).toBe(true);
    expect(second.startsWith(parent)).toBe(true);
    expect(join(first, 'internal-api.sock').length).toBeLessThan(100);
    expect(join(second, 'internal-api.sock').length).toBeLessThan(100);
  });

  it('allocates distinct currently available ports for one launch', async () => {
    const ports = await findAvailablePorts(4);

    expect(new Set(ports).size).toBe(4);
    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    }
  });

  it('holds cross-process-style port reservations until the validation server exits', async () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'pi-validation-port-locks-'));
    cleanupPaths.push(lockDir);
    const first = await reserveAvailablePorts(4, lockDir);
    const second = await reserveAvailablePorts(4, lockDir);

    expect(first.ports).toHaveLength(4);
    expect(second.ports).toHaveLength(4);
    expect(first.ports.some((port) => second.ports.includes(port))).toBe(false);

    first.release();
    second.release();
  });

  it('refuses a second live owner of an explicit validation directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-validation-lock-'));
    cleanupPaths.push(dir);
    const first = acquireValidationDirectoryLock(dir);

    expect(() => acquireValidationDirectoryLock(dir)).toThrow(/already in use/i);

    first.release();
    const second = acquireValidationDirectoryLock(dir);
    second.release();
  });

  it('does not remove a replacement lock file when an old owner releases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-validation-lock-replace-'));
    cleanupPaths.push(dir);
    const first = acquireValidationDirectoryLock(dir);
    first.release();

    const second = acquireValidationDirectoryLock(dir);
    first.release();

    expect(() => acquireValidationDirectoryLock(dir)).toThrow(/already in use/i);
    second.release();
  });
});

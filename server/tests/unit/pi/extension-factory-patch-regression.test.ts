import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as sdk from '@earendil-works/pi-coding-agent';

/**
 * B1.2 guard for scripts/patch-pi-coding-agent-extension-factory.mjs.
 *
 * The patch is additive and lives inside node_modules, so it can silently
 * disappear on an install where the postinstall hook did not run — and the
 * runtime then falls back to the per-session re-transpile path with only a
 * warning. This test fails when the patch is missing so the fallback is never
 * mistaken for the fix.
 *
 * When the SDK is upgraded, re-evaluate the patch: if upstream exports a factory
 * accessor, delete the patch, the postinstall entry and this test; otherwise
 * update the anchors in the patch script for the new version.
 */
describe('pi-coding-agent extension-factory patch', () => {
  it('exposes importExtensionFactory and loadExtensionFromFactory from the package entry', () => {
    expect(typeof (sdk as unknown as { importExtensionFactory?: unknown }).importExtensionFactory).toBe('function');
    expect(typeof (sdk as unknown as { loadExtensionFromFactory?: unknown }).loadExtensionFromFactory).toBe('function');
  });

  it('does not invent exports that upstream did not have', () => {
    // loadExtensions stays private on the entry (the patch must not widen it).
    expect(typeof (sdk as unknown as { loadExtensions?: unknown }).loadExtensions).toBe('undefined');
    expect(typeof sdk.createExtensionRuntime).toBe('function');
    expect(typeof sdk.DefaultResourceLoader).toBe('function');
  });

  it('keeps the patch additive in the loader source (append-only export)', () => {
    const source = readFileSync(join(findSdkRoot(), 'dist', 'core', 'extensions', 'loader.js'), 'utf8');
    expect(source).toContain('export { loadExtensionModule as importExtensionFactory };');
    // The export must sit next to the existing definition, not replace it.
    expect(source).toContain('async function loadExtensionModule(extensionPath, cacheToken) {');
  });
});

/** Walk up from the workspace cwd to the physical SDK package (no exports-map dependence). */
function findSdkRoot(start = process.cwd()): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate @earendil-works/pi-coding-agent from ${start}`);
}

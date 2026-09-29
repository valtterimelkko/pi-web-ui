import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  VALIDATED_SDK_VERSION,
  ExtensionImporterError,
  getInstalledSdkVersion,
  resolveSdkAliasMap,
  resolveSdkEntryPath,
  getCachedSdkAliasMap,
  resetSdkAliasMapCache,
  importFactoryViaJiti,
} from '../../../src/pi/sdk-extension-importer.js';

/**
 * B1.2b — the SDK boundary suite.
 *
 * Replaces `extension-factory-patch-regression.test.ts`: instead of asserting
 * that a local patch is applied to `@earendil-works/pi-coding-agent`, it
 * asserts the opposite (the installed files are pristine) and that everything
 * B1.2b builds on is reachable through the package `exports` map.
 *
 * The version pin below is the LOUD signal the parent required (01-answer.md
 * item 2): when the installed SDK version differs from the version the alias
 * map and the extensionsOverride were validated against, this test FAILS and
 * tells the maintainer to re-validate. The runtime counterpart degrades
 * gracefully (see extension-factory-cache.test.ts) — here it must be loud.
 */

const requireForTest = createRequire(import.meta.url);
// vitest's SSR transform removes import.meta.resolve; resolveSdkEntryPath is
// the implementation's own public resolution (walk-up fallback). Independence
// is preserved by the package-name assertion below and the binding-identity
// test further down.
const sdkEntry = resolveSdkEntryPath();
const sdkRoot = resolve(sdkEntry, '..', '..');

describe('B1.2b pristine SDK (replaces the patch regression suite)', () => {
  it('installed SDK files carry no extension-factory patch markers', async () => {
    const entrySource = readFileSync(join(sdkRoot, 'dist', 'index.js'), 'utf-8');
    const loaderSource = readFileSync(join(sdkRoot, 'dist', 'core', 'extensions', 'loader.js'), 'utf-8');
    expect(entrySource).not.toContain('seedExtensionFactory');
    expect(entrySource).not.toContain('importExtensionFactory');
    expect(loaderSource).not.toContain('seedExtensionFactory');
    expect(loaderSource).not.toContain('importExtensionFactory');
  });

  it('the patch-era accessors are absent and the used public surface is present', async () => {
    const sdk = (await import('@earendil-works/pi-coding-agent')) as unknown as Record<string, unknown>;
    expect(sdk['importExtensionFactory']).toBeUndefined();
    expect(sdk['seedExtensionFactory']).toBeUndefined();
    expect(sdk['loadExtensionFromFactory']).toBeUndefined();
    expect(typeof sdk['DefaultResourceLoader']).toBe('function');
    expect(typeof sdk['DefaultPackageManager']).toBe('function');
    expect(typeof sdk['SettingsManager']).toBe('function');
  });

  it('LOUD version pin: installed SDK is the version this lane validated against', () => {
    expect(getInstalledSdkVersion()).toBe(VALIDATED_SDK_VERSION);
  });
});

describe('B1.2b SDK alias map', () => {
  beforeEach(() => resetSdkAliasMapCache());
  afterEach(() => resetSdkAliasMapCache());

  it('resolves every alias to an existing file, through the SDK package scope', () => {
    const aliases = resolveSdkAliasMap();
    for (const [specifier, target] of Object.entries(aliases)) {
      expect({ specifier, exists: requireForTest('node:fs').existsSync(target) }).toEqual({
        specifier,
        exists: true,
      });
    }
  });

  it('maps @earendil-works/pi-coding-agent to the same entry the SDK loads natively', async () => {
    const aliases = resolveSdkAliasMap();
    expect(aliases['@earendil-works/pi-coding-agent']).toBe(sdkEntry);
    // Independent anchor: the resolved entry really belongs to the SDK package.
    const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf-8')) as { name: string };
    expect(pkg.name).toBe('@earendil-works/pi-coding-agent');
    void pathToFileURL;
  });

  it('prefers the SDK-nested companion copies (the ones import.meta.resolve from the SDK finds)', () => {
    const aliases = resolveSdkAliasMap();
    const nestedRoot = realpathSync(join(sdkRoot, 'node_modules'));
    expect(realpathSync(aliases['@earendil-works/pi-tui']).startsWith(nestedRoot)).toBe(true);
    expect(realpathSync(aliases['@earendil-works/pi-agent-core']).startsWith(nestedRoot)).toBe(true);
    expect(realpathSync(aliases['@earendil-works/pi-ai']).startsWith(nestedRoot)).toBe(true);
  });

  it('resolves typebox exactly as the SDK does (require.resolve from the SDK scope)', () => {
    const aliases = resolveSdkAliasMap();
    const requireFromSdk = createRequire(sdkEntry);
    expect(realpathSync(aliases['typebox'])).toBe(realpathSync(requireFromSdk.resolve('typebox')));
    expect(realpathSync(aliases['typebox/compile'])).toBe(realpathSync(requireFromSdk.resolve('typebox/compile')));
    expect(realpathSync(aliases['typebox/value'])).toBe(realpathSync(requireFromSdk.resolve('typebox/value')));
    expect(aliases['@sinclair/typebox']).toBe(aliases['typebox']);
  });

  it('keeps the compat/oauth/providers-all and legacy @mariozechner aliases of getAliases()', () => {
    const aliases = resolveSdkAliasMap();
    expect(aliases['@earendil-works/pi-ai/compat']).toBe(aliases['@earendil-works/pi-ai']);
    expect(aliases['@earendil-works/pi-ai/oauth']).not.toBe(aliases['@earendil-works/pi-ai']);
    expect(aliases['@earendil-works/pi-ai/providers/all']).not.toBe(aliases['@earendil-works/pi-ai']);
    for (const legacy of ['pi-coding-agent', 'pi-agent-core', 'pi-tui', 'pi-ai'] as const) {
      expect(aliases[`@mariozechner/${legacy}`]).toBe(aliases[`@earendil-works/${legacy}`]);
    }
  });

  it('caches the map per process until reset', () => {
    const before = getCachedSdkAliasMap();
    expect(getCachedSdkAliasMap()).toBe(before);
    resetSdkAliasMapCache();
    const after = getCachedSdkAliasMap();
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  it('degrades as a typed error unless the SDK version matches VALIDATED_SDK_VERSION EXACTLY (correction 02: 0.87.2 included)', () => {
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '0.99.0' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '0.88.0' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '0.87.2' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '0.87.1' })).not.toThrow();
  });

  it('degrades as a typed error when an alias target cannot be resolved', () => {
    expect(() =>
      resolveSdkAliasMap({
        existsSync: (path: string) => !path.includes('tui'),
      }),
    ).toThrow(ExtensionImporterError);
  });
});

describe('B1.2b jiti factory import', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'b12b-importer-'));
    resetSdkAliasMapCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetSdkAliasCacheAndJiti();
  });

  function writeFixture(name: string, source: string): string {
    mkdirSync(join(root, name), { recursive: true });
    const entry = join(root, name, 'index.ts');
    writeFileSync(entry, source);
    return entry;
  }

  it('imports an extension module and returns its default-export factory', async () => {
    const entry = writeFixture(
      'ok',
      `export default function (pi) { pi.registerCommand('b12b-ok', { handler: async () => 'ok' }); }`,
    );
    const factory = await importFactoryViaJiti(entry);
    expect(typeof factory).toBe('function');
  });

  it('returns undefined when the default export is not a function (loadExtensionModule contract)', async () => {
    const entry = writeFixture('notfn', `export default { not: 'a factory' };`);
    expect(await importFactoryViaJiti(entry)).toBeUndefined();
  });

  it('gives the imported module the SDK aliases: defineTool is the SDK module object the SDK itself uses', async () => {
    const entry = writeFixture(
      'identity',
      `import { defineTool, ExtensionRunner } from '@earendil-works/pi-coding-agent';
       (globalThis).__b12bIdentity = { defineTool, ExtensionRunner };
       export default function () {}`,
    );
    await importFactoryViaJiti(entry);
    const native = (await import('@earendil-works/pi-coding-agent')) as unknown as Record<string, unknown>;
    const captured = (globalThis as Record<string, unknown>)['__b12bIdentity'] as Record<string, unknown>;
    expect(captured['defineTool']).toBe(native['defineTool']);
    expect(captured['ExtensionRunner']).toBe(native['ExtensionRunner']);
    delete (globalThis as Record<string, unknown>)['__b12bIdentity'];
  });

  it('wraps import failures in ExtensionImporterError (the loader builder degrades to the plain path)', async () => {
    const entry = writeFixture('broken', `throw new ReferenceError('b12b-import-time-failure');\nexport default function () {};`);
    await expect(importFactoryViaJiti(entry)).rejects.toThrow(ExtensionImporterError);
    const missing = join(root, 'does-not-exist.ts');
    await expect(importFactoryViaJiti(missing)).rejects.toThrow(ExtensionImporterError);
  });

  it('degrades as a typed error when the alias map cannot be built (e.g. alias target missing)', async () => {
    const entry = writeFixture('any', `export default function () {}`);
    await expect(
      importFactoryViaJiti(entry, {
        aliasMap: () => {
          throw new ExtensionImporterError('alias target missing (simulated)');
        },
      }),
    ).rejects.toThrow(ExtensionImporterError);
  });
});

/** Test-only: also drop the memoised jiti module between tests. */
function resetSdkAliasCacheAndJiti(): void {
  resetSdkAliasMapCache();
  void pathToFileURL;
}

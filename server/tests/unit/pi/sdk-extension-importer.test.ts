import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
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
  });

  it('resolves companions to the copy the SDK scope finds (nested when one exists, else hoisted)', () => {
    const aliases = resolveSdkAliasMap();
    // pi-ai's companion check uses /models: since 1.5.0 the pi-ai root is the extension view.
    for (const [name, key] of [['pi-tui', 'pi-tui'], ['pi-agent-core', 'pi-agent-core'], ['pi-ai', 'pi-ai/models']] as const) {
      const nested = join(sdkRoot, 'node_modules', '@earendil-works', name);
      const hoisted = join(dirname(sdkRoot), name);
      const expectedRoot = realpathSync(existsSync(nested) ? nested : hoisted);
      expect(realpathSync(aliases[`@earendil-works/${key}`]).startsWith(expectedRoot)).toBe(true);
    }
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

  /**
   * 1.4.0 (#11156) added the `pi-ai/models` subpath to getAliases() and to the
   * virtual modules, so extensions importing `clampThinkingLevel` from
   * `@earendil-works/pi-ai/models` load again. The SDK's `getAliases()` is not
   * exported, so the alias SURFACE is read from the loader source text (the
   * same public-file technique the pristine-SDK test above uses) and compared
   * with ours: a future SDK that adds or drops an alias fails here until the
   * map is re-validated.
   */
  function sdkAliasKeys(): string[] {
    const loaderSource = readFileSync(join(sdkRoot, 'dist', 'core', 'extensions', 'loader.js'), 'utf-8');
    const start = loaderSource.indexOf('_aliases = {');
    expect(start).toBeGreaterThan(-1);
    const block = loaderSource.slice(start, loaderSource.indexOf('};', start));
    const keys: string[] = [];
    for (const line of block.split('\n')) {
      const match = /^\s+(?:"([^"]+)"|([A-Za-z@][\w@./-]*)):/u.exec(line);
      if (match) keys.push(match[1] ?? match[2]);
    }
    return keys.sort();
  }

  it('covers exactly the alias keys the installed SDK loader defines', () => {
    const expected = sdkAliasKeys();
    expect(expected.length).toBeGreaterThan(15);
    expect(Object.keys(resolveSdkAliasMap()).sort()).toEqual(expected);
  });

  it('maps the pi-ai/models subpath (1.4.0) to pi-ai models, not the compat entrypoint', () => {
    const aliases = resolveSdkAliasMap();
    expect(aliases['@earendil-works/pi-ai/models']).toBe(aliases['@mariozechner/pi-ai/models']);
    expect(aliases['@earendil-works/pi-ai/models']).not.toBe(aliases['@earendil-works/pi-ai']);
    expect(aliases['@earendil-works/pi-ai/models'].endsWith(join('ai', 'dist', 'models.js'))).toBe(true);
  });

  /**
   * 1.5.0: pi-ai's main entry no longer re-exports TypeBox, so the SDK maps the
   * pi-ai root (and /compat, and the @mariozechner twins) to its own
   * `pi-ai-extension-view.js` (compat + TypeBox `Type` + a TypeBox
   * `StringEnum`). That file is not in the SDK `exports` map, so Pi Web UI
   * carries its own equivalent view instead of importing it (owner rule: no
   * deep private imports); the export SURFACE is checked against the SDK's
   * view below.
   */
  it('maps the pi-ai root and compat (1.5.0) to the extension view, not to pi-ai compat.js', () => {
    const aliases = resolveSdkAliasMap();
    const view = aliases['@earendil-works/pi-ai'];
    expect(existsSync(view)).toBe(true);
    expect(/pi-ai-extension-view\.(cjs|cts)$/u.test(view)).toBe(true);
    expect(view.includes(`${join('node_modules', '@earendil-works')}`)).toBe(false);
    for (const key of ['@earendil-works/pi-ai/compat', '@mariozechner/pi-ai', '@mariozechner/pi-ai/compat']) {
      expect(aliases[key]).toBe(view);
    }
  });

  it('the SDK itself still points the pi-ai root at its extension view (re-validate if this changes)', () => {
    const loaderSource = readFileSync(join(sdkRoot, 'dist', 'core', 'extensions', 'loader.js'), 'utf-8');
    expect(loaderSource).toContain('"pi-ai-extension-view.js"');
  });

  it('caches the map per process until reset', () => {
    const before = getCachedSdkAliasMap();
    expect(getCachedSdkAliasMap()).toBe(before);
    resetSdkAliasMapCache();
    const after = getCachedSdkAliasMap();
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });

  it('degrades as a typed error unless the SDK version matches VALIDATED_SDK_VERSION EXACTLY (correction 02: 1.5.1 included)', () => {
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '0.87.1' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '0.99.2' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.0.0' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.2.0' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.3.0' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.4.0' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.4.1' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.5.1' })).toThrow(ExtensionImporterError);
    expect(() => resolveSdkAliasMap({ sdkVersion: () => '1.5.0' })).not.toThrow();
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

  it('gives the imported module the pi-ai/models alias: an extension can import clampThinkingLevel (1.4.0 #11156)', async () => {
    const entry = writeFixture(
      'pi-ai-models',
      `import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
       (globalThis).__b12bModels = clampThinkingLevel;
       export default function () {}`,
    );
    await importFactoryViaJiti(entry);
    const clamp = (globalThis as Record<string, unknown>)['__b12bModels'] as (model: unknown, level: string) => string;
    expect(typeof clamp).toBe('function');
    // Behaves like the real function (not a stub or interop wrapper): a model
    // without the xhigh/max levels clamps a request for max down to high.
    expect(clamp({ reasoning: true }, 'max')).toBe('high');
    expect(clamp({ reasoning: true }, 'low')).toBe('low');
    delete (globalThis as Record<string, unknown>)['__b12bModels'];
  });

  it('gives extensions TypeBox Type and StringEnum through @earendil-works/pi-ai (1.5.0 extension view)', async () => {
    const entry = writeFixture(
      'pi-ai-type',
      `import { Type, StringEnum, complete } from '@earendil-works/pi-ai';
       import { Type as LegacyType } from '@mariozechner/pi-ai';
       import { Type as DirectType } from 'typebox';
       (globalThis).__b12bType = { Type, StringEnum, complete, LegacyType, DirectType };
       export default function () {}`,
    );
    await importFactoryViaJiti(entry);
    const captured = (globalThis as Record<string, unknown>)['__b12bType'] as Record<string, any>;
    expect(typeof captured['Type']?.Object).toBe('function');
    // One TypeBox for everyone: the same module the `typebox` alias (the SDK's own) gives.
    expect(captured['Type']).toBe(captured['DirectType']);
    expect(captured['LegacyType']).toBe(captured['Type']);
    // The compat surface is still there (module-object identity with the SDK's
    // own view is asserted in the fresh-process test: vitest's module graph
    // gives a dynamic import() its own instance).
    expect(typeof captured['complete']).toBe('function');
    // StringEnum is the TypeBox-typed one: a plain string enum schema.
    const schema = captured['StringEnum'](['a', 'b'], { description: 'd' });
    expect(schema).toMatchObject({ type: 'string', enum: ['a', 'b'], description: 'd' });
    delete (globalThis as Record<string, unknown>)['__b12bType'];
  });

  it('the view exports the same names as the SDK extension view', async () => {
    const aliases = resolveSdkAliasMap();
    const sdkViewPath = join(sdkRoot, 'dist', 'core', 'extensions', 'pi-ai-extension-view.js');
    const sdkView = (await import(pathToFileURL(sdkViewPath).href)) as Record<string, unknown>;
    const entry = writeFixture(
      'pi-ai-names',
      `import * as view from '@earendil-works/pi-ai';
       (globalThis).__b12bNames = Object.keys(view).filter((k) => k !== 'default' && k !== '__esModule');
       export default function () {}`,
    );
    await importFactoryViaJiti(entry);
    const names = ((globalThis as Record<string, unknown>)['__b12bNames'] as string[]).sort();
    expect(names).toEqual(Object.keys(sdkView).sort());
    expect(aliases['@earendil-works/pi-ai']).not.toBe(sdkViewPath);
    delete (globalThis as Record<string, unknown>)['__b12bNames'];
  });

  it('imports several Type-using extensions in parallel in a fresh process (no require(esm) race on typebox)', () => {
    // The view loads typebox and pi-ai compat with Node's require(); while a
    // parallel import() of typebox is still in flight Node refuses that
    // ("not yet fully loaded"), which is exactly what the factory cache's
    // parallel scan did on a fresh 1.5.0 server. Needs a fresh process: the
    // test worker has typebox loaded already.
    const fixtures: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      fixtures.push(
        writeFixture(
          `parallel-${i}`,
          `import { Type } from '@earendil-works/pi-ai';
           import { Type as T2 } from 'typebox';
           import { complete } from '@earendil-works/pi-ai';
           const schema = Type.Object({ n: T2.Number() });
           (globalThis).__b12bParallel = { Type, T2, complete };
           export default function () { return schema; }`,
        ),
      );
    }
    const importer = pathToFileURL(resolve(__dirname, '../../../src/pi/sdk-extension-importer.ts')).href;
    const script = `
      const { importFactoryViaJiti } = await import(${JSON.stringify(importer)});
      const results = await Promise.allSettled(${JSON.stringify(fixtures)}.map((f) => importFactoryViaJiti(f)));
      const failed = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message ?? r.reason));
      const sdkView = await import(${JSON.stringify(pathToFileURL(join(sdkRoot, 'dist', 'core', 'extensions', 'pi-ai-extension-view.js')).href)});
      const seen = globalThis.__b12bParallel ?? {};
      const identity = {
        type: seen.Type === sdkView.Type,
        typeboxAlias: seen.T2 === sdkView.Type,
        complete: typeof seen.complete === 'function' && seen.complete === sdkView.complete,
      };
      console.log(JSON.stringify({ ok: results.length - failed.length, failed, identity }));
      process.exit(0);
    `;
    // Plain Node (type stripping loads the importer's .ts and the view's .cts
    // source); the importer imports only node: builtins and jiti.
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: resolve(__dirname, '../../..'),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const summary = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
      ok: number;
      failed: string[];
      identity: Record<string, boolean>;
    };
    expect(summary.failed).toEqual([]);
    expect(summary.ok).toBe(6);
    // Same module objects as the SDK's own extension view: one TypeBox, one pi-ai.
    expect(summary.identity).toEqual({ type: true, typeboxAlias: true, complete: true });
  }, 90_000);

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

import { createRequire } from 'node:module';
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * B1.2b — imports extension **factories** with jiti using the same module
 * aliasing the SDK applies, without touching `@earendil-works/pi-coding-agent`
 * (owner rule: no changes to upstream pi-core of any kind — no dist edits, no
 * patches, no deep private imports; the package `exports` map is the boundary).
 *
 * `resolveSdkAliasMap()` replicates the SDK's private `getAliases()`
 * (`dist/core/extensions/loader.js`, 0.87.1): every alias target is resolved
 * to the SAME absolute file the SDK itself uses, so an extension imported here
 * shares module instances with SDK-loaded extensions (measured: aliased ESM
 * entries load through Node's native ESM registry, so exported bindings like
 * `defineTool` are the identical module objects — see the identity test).
 *
 * Failure contract (parent, 01-answer.md item 2 — degrade at runtime, alarm in
 * CI): every failure inside this module throws the typed
 * `ExtensionImporterError`; the loader builder in
 * `extension-factory-cache.ts` catches it and falls back to the plain uncached
 * SDK path for that session, with a rate-limited warning and a diagnostics
 * counter. The loud signal lives in the tests
 * (`sdk-extension-importer.test.ts`), including the version pin that fails CI
 * when the installed SDK is not the validated one.
 */

/** The only SDK minor this module's alias map and override were validated against. */
export const VALIDATED_SDK_VERSION = '0.87.1';

export class ExtensionImporterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ExtensionImporterError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Minimal seams so every failure class is testable without mocking the SDK. */
export interface SdkResolutionDeps {
  /** Resolves the SDK package entry (default: `import.meta.resolve`). */
  resolveSdkEntry?: () => string;
  /** Installed SDK version reader (default: the SDK package.json). */
  sdkVersion?: () => string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: 'utf-8') => string;
  /** CJS-style resolution FROM a path inside the SDK package (default: createRequire). */
  requireFrom?: (fromPath: string) => { resolve: (specifier: string) => string };
}

interface PackageJsonLike {
  version?: string;
  main?: string;
  exports?: unknown;
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new ExtensionImporterError(String(error));

function readPackageJson(path: string, deps: Required<SdkResolutionDeps>): PackageJsonLike {
  try {
    return JSON.parse(deps.readFileSync(path, 'utf-8')) as PackageJsonLike;
  } catch (error) {
    throw new ExtensionImporterError(`Cannot read package.json at ${path}`, { cause: error });
  }
}

/**
 * Canonicalise a resolved target: the SDK's own `import.meta.resolve` returns
 * realpaths (Node ESM resolves symlinks), so worktree-symlinked node_modules
 * must not produce alias targets that differ from the SDK's files.
 */
function canonicalTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve one exports-map subpath to an absolute file. Supports the subset the
 * SDK family uses: plain string targets and condition objects
 * (`import` > `node` > `default`), exact keys then `*` wildcards.
 */
function resolveExportsTarget(pkg: PackageJsonLike, pkgDir: string, subpath: string, deps: Required<SdkResolutionDeps>): string {
  const fail = (): never => {
    throw new ExtensionImporterError(`No exports target for "${subpath}" under ${pkgDir}`);
  };
  const exportsField = pkg.exports;
  if (exportsField === undefined && subpath === '.') {
    // Legacy resolution (e.g. pi-tui ships `main`, no exports field).
    const target = join(pkgDir, pkg.main ?? 'index.js');
    if (!deps.existsSync(target)) fail();
    return target;
  }
  let table: unknown = exportsField;
  let wildcard: string | undefined;
  if (typeof table === 'string' || Array.isArray(table)) {
    if (subpath !== '.') fail();
  } else if (table !== null && typeof table === 'object') {
    const map = table as Record<string, unknown>;
    if (!(subpath in map)) {
      let substituted: string | undefined;
      const key = Object.keys(map).find((candidate) => {
        if (!candidate.includes('*')) return false;
        const [prefix, suffix] = candidate.split('*');
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return false;
        substituted = subpath.slice(prefix.length, subpath.length - suffix.length);
        return true;
      });
      if (key !== undefined && substituted !== undefined) {
        table = map[key];
        wildcard = substituted;
      } else {
        fail();
      }
    } else {
      table = map[subpath];
    }
  } else {
    fail();
  }
  let target: unknown = table;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof target === 'string') {
      const resolvedPath = join(pkgDir, wildcard !== undefined ? target.replace('*', wildcard) : target);
      if (!deps.existsSync(resolvedPath)) fail();
      return resolvedPath;
    }
    if (Array.isArray(target)) {
      target = target[0];
      continue;
    }
    if (target !== null && typeof target === 'object') {
      const conditions = target as Record<string, unknown>;
      target = conditions['import'] ?? conditions['node'] ?? conditions['default'];
      continue;
    }
    fail();
  }
  return fail();
}

/**
 * Resolve a companion `@earendil-works/*` package directory from the SDK's own
 * scope, mirroring Node's resolution order (nearest node_modules first), so the
 * nested copies the SDK itself uses win over hoisted duplicates.
 */
function findCompanionPackageDir(name: string, sdkRoot: string, deps: Required<SdkResolutionDeps>): string {
  let current = sdkRoot;
  // Bounded walk (64 levels) — deep directories cannot spin the resolution.
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(current, 'node_modules', name);
    if (deps.existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ExtensionImporterError(`Companion package ${name} not found from SDK scope ${sdkRoot}`);
}

/**
 * Resolve the SDK package entry (`dist/index.js`) through normal resolution.
 * `import.meta.resolve` when the runtime provides it (real Node ESM); otherwise
 * the same node_modules walk-up Node performs, using public file reads only
 * (vitest's SSR transform replaces import.meta with a shim without resolve).
 */
export function resolveSdkEntryPath(): string {
  try {
    const resolved = (import.meta as { resolve?: (specifier: string) => string }).resolve?.('@earendil-works/pi-coding-agent');
    if (resolved) return fileURLToPath(resolved);
  } catch {
    // fall through to the walk-up
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bounded walk (64 levels) — deep directories cannot spin the resolution.
  for (let depth = 0; depth < 64; depth += 1) {
    const pkgDir = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent');
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (defaultExistsSync(pkgJsonPath)) {
      const pkg = JSON.parse(defaultReadFileSync(pkgJsonPath, 'utf-8')) as PackageJsonLike;
      const entry = resolveExportsTarget(pkg, pkgDir, '.', {
        resolveSdkEntry: () => pkgDir,
        sdkVersion: () => pkg.version ?? '0',
        existsSync: defaultExistsSync,
        readFileSync: (path, encoding) => defaultReadFileSync(path, encoding),
        requireFrom: (fromPath) => createRequire(fromPath),
      });
      try {
        return realpathSync(entry);
      } catch {
        return entry;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ExtensionImporterError('@earendil-works/pi-coding-agent not found from module location');
}

/** Default version reader: derive the SDK package root from the resolved entry. */
function defaultSdkVersion(): string {
  // The SDK exports no ./package.json subpath, so read the package root file.
  return (JSON.parse(defaultReadFileSync(join(dirname(resolveSdkEntryPath()), '..', 'package.json'), 'utf-8')) as PackageJsonLike).version ?? 'unknown';
}

/**
 * Build the jiti alias map: the SDK's `getAliases()` replicated through public
 * resolution. Targets are absolute files shared with the SDK's own module graph.
 */
export function resolveSdkAliasMap(deps: SdkResolutionDeps = {}): Record<string, string> {
  const full: Required<SdkResolutionDeps> = {
    resolveSdkEntry: deps.resolveSdkEntry ?? resolveSdkEntryPath,
    sdkVersion: deps.sdkVersion ?? defaultSdkVersion,
    existsSync: deps.existsSync ?? defaultExistsSync,
    readFileSync: deps.readFileSync ?? ((path, encoding) => defaultReadFileSync(path, encoding)),
    requireFrom: deps.requireFrom ?? ((fromPath) => createRequire(fromPath)),
  };

  // Version guard — correction 02 (minor): EXACT match against the validated
  // version. A same-minor bump (0.87.2) can change the alias surface, so any
  // other version degrades to the plain uncached path at runtime; the CI pin
  // test tells the maintainer to re-validate.
  const version = full.sdkVersion();
  if (version !== VALIDATED_SDK_VERSION) {
    throw new ExtensionImporterError(
      `@earendil-works/pi-coding-agent ${version} is not the validated version (${VALIDATED_SDK_VERSION}); ` +
      'the extension factory alias map and override must be re-validated for this SDK version. ' +
      'Falling back to the plain uncached SDK path.',
    );
  }

  let sdkEntry: string;
  try {
    sdkEntry = full.resolveSdkEntry();
  } catch (error) {
    throw new ExtensionImporterError('Cannot resolve @earendil-works/pi-coding-agent entry', { cause: error });
  }
  if (!isAbsolute(sdkEntry) || !full.existsSync(sdkEntry)) {
    throw new ExtensionImporterError(`SDK entry does not exist: ${sdkEntry}`);
  }
  const sdkRoot = resolve(dirname(sdkEntry), '..');

  // getAliases(): packagesRoot is two levels above the package's dist entry
  // (installed: the @earendil-works scope dir; workspace monorepo: packages/).
  const packagesRoot = resolve(dirname(sdkEntry), '..', '..');
  const preferWorkspace = (relative: string): string | undefined => {
    const workspacePath = join(packagesRoot, relative);
    return full.existsSync(workspacePath) ? workspacePath : undefined;
  };

  const resolveCompanion = (workspaceRelative: string, name: string, subpath: string): string => {
    const workspace = preferWorkspace(workspaceRelative);
    if (workspace) return workspace;
    // Preferred: Node's own resolution of the exported package.json subpath
    // from the SDK's scope (lands on the nested copy when one exists).
    if (subpath === '.') {
      try {
        const pkgJsonPath = full.requireFrom(sdkEntry).resolve(`${name}/package.json`);
        if (full.existsSync(pkgJsonPath)) {
          const pkgDir = dirname(pkgJsonPath);
          const pkg = readPackageJson(pkgJsonPath, full);
          return resolveExportsTarget(pkg, pkgDir, '.', full);
        }
      } catch {
        // fall through to the walk-up exports-map read
      }
    }
    const pkgDir = findCompanionPackageDir(name, sdkRoot, full);
    const pkg = readPackageJson(join(pkgDir, 'package.json'), full);
    return resolveExportsTarget(pkg, pkgDir, subpath, full);
  };

  const requireFromSdk = (specifier: string): string => {
    const target = full.requireFrom(sdkEntry).resolve(specifier);
    if (!full.existsSync(target)) {
      throw new ExtensionImporterError(`Resolved alias target for ${specifier} does not exist: ${target}`);
    }
    return canonicalTarget(target);
  };

  const piCodingAgentEntry = canonicalTarget(sdkEntry);
  const piAgentCoreEntry = canonicalTarget(resolveCompanion('agent/dist/index.js', '@earendil-works/pi-agent-core', '.'));
  const piTuiEntry = canonicalTarget(resolveCompanion('tui/dist/index.js', '@earendil-works/pi-tui', '.'));
  // Extensions resolve the pi-ai root to the compat entrypoint, as the SDK does.
  const piAiCompatEntry = canonicalTarget(resolveCompanion('ai/dist/compat.js', '@earendil-works/pi-ai', './compat'));
  const piAiOauthEntry = canonicalTarget(resolveCompanion('ai/dist/oauth.js', '@earendil-works/pi-ai', './oauth'));
  const piAiProvidersEntry = canonicalTarget(resolveCompanion('ai/dist/providers/all.js', '@earendil-works/pi-ai', './providers/all'));
  const typeboxEntry = requireFromSdk('typebox');
  const typeboxCompileEntry = requireFromSdk('typebox/compile');
  const typeboxValueEntry = requireFromSdk('typebox/value');

  return {
    '@earendil-works/pi-coding-agent': piCodingAgentEntry,
    '@earendil-works/pi-agent-core': piAgentCoreEntry,
    '@earendil-works/pi-tui': piTuiEntry,
    '@earendil-works/pi-ai/providers/all': piAiProvidersEntry,
    '@earendil-works/pi-ai/compat': piAiCompatEntry,
    '@earendil-works/pi-ai/oauth': piAiOauthEntry,
    '@earendil-works/pi-ai': piAiCompatEntry,
    '@mariozechner/pi-coding-agent': piCodingAgentEntry,
    '@mariozechner/pi-agent-core': piAgentCoreEntry,
    '@mariozechner/pi-tui': piTuiEntry,
    '@mariozechner/pi-ai/providers/all': piAiProvidersEntry,
    '@mariozechner/pi-ai/compat': piAiCompatEntry,
    '@mariozechner/pi-ai/oauth': piAiOauthEntry,
    '@mariozechner/pi-ai': piAiCompatEntry,
    typebox: typeboxEntry,
    'typebox/compile': typeboxCompileEntry,
    'typebox/value': typeboxValueEntry,
    '@sinclair/typebox': typeboxEntry,
    '@sinclair/typebox/compile': typeboxCompileEntry,
    '@sinclair/typebox/value': typeboxValueEntry,
  };
}

export function getInstalledSdkVersion(): string {
  const pkgJsonPath = join(dirname(resolveSdkEntryPath()), '..', 'package.json');
  return (JSON.parse(defaultReadFileSync(pkgJsonPath, 'utf-8')) as PackageJsonLike).version ?? 'unknown';
}

let cachedAliasMap: Record<string, string> | undefined;

/** The process-wide alias map (resolved once; `resetSdkAliasMapCache` for tests). */
export function getCachedSdkAliasMap(): Record<string, string> {
  cachedAliasMap ??= resolveSdkAliasMap();
  return cachedAliasMap;
}

/** Test seam. */
export function resetSdkAliasMapCache(): void {
  cachedAliasMap = undefined;
}

export interface JitiImportDeps {
  /** Overrides the alias map source (tests simulate resolution failure here). */
  aliasMap?: () => Record<string, string>;
  /** Overrides the jiti factory (tests inject a failing loader). */
  createJiti?: (id: string, options: { moduleCache: boolean; alias: Record<string, string> }) => {
    import: (path: string, options: { default: boolean }) => Promise<unknown>;
  };
}

/**
 * Import an extension module and return its default-export factory — the same
 * contract as the SDK's private `loadExtensionModule`: `undefined` when the
 * default export is not a function, a thrown `ExtensionImporterError` on any
 * failure (the caller degrades to the plain uncached SDK path).
 */
export async function importFactoryViaJiti(extensionPath: string, deps: JitiImportDeps = {}): Promise<unknown | undefined> {
  let alias: Record<string, string>;
  try {
    alias = deps.aliasMap ? deps.aliasMap() : getCachedSdkAliasMap();
  } catch (error) {
    throw error instanceof ExtensionImporterError ? error : new ExtensionImporterError('SDK alias map unavailable', { cause: error });
  }
  let jitiInstance: { import: (path: string, options: { default: boolean }) => Promise<unknown> };
  try {
    if (deps.createJiti) {
      jitiInstance = deps.createJiti(import.meta.url, { moduleCache: false, alias });
    } else {
      const jitiModule = (await import('jiti')) as unknown as {
        createJiti: (id: string, options: { moduleCache: boolean; alias: Record<string, string> }) => {
          import: (path: string, options: { default: boolean }) => Promise<unknown>;
        };
      };
      // Same construction as the SDK's loadExtensionModule: fresh instance,
      // moduleCache disabled, alias map to the SDK's own files.
      jitiInstance = (jitiModule.createJiti ?? jitiModule)(import.meta.url, { moduleCache: false, alias });
    }
  } catch (error) {
    throw new ExtensionImporterError(`jiti unavailable for extension import (${extensionPath})`, { cause: error });
  }
  try {
    const mod = await jitiInstance.import(extensionPath, { default: true });
    return typeof mod === 'function' ? mod : undefined;
  } catch (error) {
    const cause = toError(error);
    // Correction 03 (minor): the MESSAGE is the underlying cause message so a
    // failed re-import surfaces exactly like the uncached path
    // (`Failed to load extension: <cause>`); the module context stays on the
    // `cause` chain.
    throw new ExtensionImporterError(cause.message, { cause });
  }
}

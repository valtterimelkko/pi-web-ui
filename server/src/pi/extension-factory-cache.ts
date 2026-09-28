import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLogger } from '../logging/logger.js';

/**
 * B1.2 — process-level extension **factory** cache.
 *
 * Why: `PiService.createSession` builds a fresh `DefaultResourceLoader` and
 * `await loader.reload()` for every session. The SDK's extension module cache is
 * a single-slot, cwd-keyed Map that is cleared whenever the cwd differs
 * (`useExtensionCacheCwd()`), so nearly every session open re-imports ~780 KB of
 * TypeScript across the global extensions with jiti `moduleCache: false` — a
 * measured 0.3–1.7 s synchronous block on the event loop.
 *
 * What this does: import each **global** extension's default-export factory once
 * per process, watch it for changes, and hand the factory back to the SDK's own
 * module cache for the session's real cwd (via the additive
 * `seedExtensionFactory` accessor from
 * `scripts/patch-pi-coding-agent-extension-factory.mjs`). `loadExtensionsCached`
 * then reuses the factory while still calling `initializeExtension` per load, so
 * every session keeps its **own** Extension objects and its own runtime — the
 * isolation property the rejected per-cwd-loader cache broke.
 *
 * Deliberately NOT cached: project-local extensions (`<cwd>/.pi/extensions`),
 * configured extensions and packages. Those are cwd-dependent and are still
 * discovered, imported and initialised per real cwd by the loader itself; only
 * the cwd-independent global set is cached here. Discovery therefore stays with
 * the SDK (paths, order, metadata and project-local handling are unchanged); we
 * only supply the factory for the paths we recognise.
 *
 * Freshness (requirement 3): a cached factory is re-imported when the entry
 * file changes, or — for directory-shaped extensions (`…/<name>/index.ts`) —
 * when any file inside that directory changes. Loose-file extensions
 * (`…/extensions/<name>.ts`) fingerprint the entry file only, because their
 * containing directory is shared with every other extension.
 *
 * Bounded (requirement 4): one entry per discovered path, a bounded directory
 * scan, and no per-cwd or per-session state.
 */

const logger = createLogger('ExtensionFactoryCache');
const DEFAULT_MAX_SCAN_ENTRIES = 512;

export interface ExtensionDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface ExtensionFactoryCacheDeps {
  /** Import an extension module and return its default-export factory. */
  importFactory?: (extensionPath: string) => Promise<unknown | undefined>;
  /** Place an already-imported factory into the SDK module cache for `cwd`. */
  seedFactory?: (extensionPath: string, factory: unknown, cwd: string) => boolean;
  readdir?: (dir: string) => Promise<ExtensionDirEntry[]>;
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number } | undefined>;
  readFile?: (path: string) => Promise<string>;
  /** Bound on how many files a single extension directory fingerprint reads. */
  maxScanEntries?: number;
}

export interface CachedExtensionFactory {
  path: string;
  factory: unknown;
  fingerprint: string;
}

export interface ExtensionFactoryCacheStats {
  discovered: number;
  cached: number;
  imports: number;
  reimports: number;
  pruned: number;
}

interface CacheEntry {
  factory: unknown;
  fingerprint: string;
}

const extensionName = (name: string): boolean => name.endsWith('.ts') || name.endsWith('.js');

async function defaultReaddir(dir: string): Promise<ExtensionDirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymbolicLink: entry.isSymbolicLink(),
  }));
}

async function defaultStat(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

/**
 * Resolve a directory entry's extension entry points, mirroring the SDK's
 * `resolveExtensionEntries`: a package.json `pi.extensions` list wins, then
 * index.ts, then index.js. No recursion beyond one level.
 */
async function resolveExtensionEntries(dir: string, deps: Required<Pick<ExtensionFactoryCacheDeps, 'stat' | 'readFile'>>): Promise<string[]> {
  const packageJsonPath = join(dir, 'package.json');
  if (await deps.stat(packageJsonPath)) {
    try {
      const parsed = JSON.parse(await deps.readFile(packageJsonPath)) as { pi?: { extensions?: unknown } };
      const declared = parsed?.pi?.extensions;
      if (Array.isArray(declared) && declared.every((entry) => typeof entry === 'string') && declared.length > 0) {
        const entries: string[] = [];
        for (const relative of declared) {
          const candidate = resolve(dir, relative);
          if (await deps.stat(candidate)) entries.push(candidate);
        }
        if (entries.length > 0) return entries;
      }
    } catch {
      // fall through to index.ts/index.js, as the SDK does
    }
  }
  for (const name of ['index.ts', 'index.js']) {
    const candidate = join(dir, name);
    if (await deps.stat(candidate)) return [candidate];
  }
  return [];
}

/**
 * The SDK's global extension discovery for `<agentDir>/extensions`
 * (`discoverExtensionsInDir`): direct `.ts`/`.js` files, plus subdirectories
 * with a package.json `pi.extensions` list, an index.ts or an index.js.
 */
export async function discoverGlobalExtensionPaths(agentDir: string, overrides: ExtensionFactoryCacheDeps = {}): Promise<string[]> {
  const deps = {
    stat: overrides.stat ?? defaultStat,
    readFile: overrides.readFile ?? ((path: string) => readFile(path, 'utf-8')),
  };
  const dir = join(agentDir, 'extensions');
  let entries: ExtensionDirEntry[];
  try {
    entries = await (overrides.readdir ?? defaultReaddir)(dir);
  } catch {
    return [];
  }
  const discovered: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if ((entry.isFile || entry.isSymbolicLink) && extensionName(entry.name)) {
      discovered.push(entryPath);
      continue;
    }
    if (entry.isDirectory || entry.isSymbolicLink) {
      discovered.push(...(await resolveExtensionEntries(entryPath, deps)));
    }
  }
  return discovered;
}

/**
 * A change-detecting fingerprint for one extension. Directory-shaped extensions
 * fingerprint every file inside their directory (bounded); loos-file extensions
 * fingerprint the entry file only.
 */
export async function extensionFingerprint(
  extensionPath: string,
  overrides: ExtensionFactoryCacheDeps = {},
  maxScanEntries = DEFAULT_MAX_SCAN_ENTRIES,
): Promise<string> {
  const statFn = overrides.stat ?? defaultStat;
  const readdirFn = overrides.readdir ?? defaultReaddir;
  const parts: string[] = [];
  const entryStat = await statFn(extensionPath);
  parts.push(`entry:${entryStat?.mtimeMs ?? 'missing'}:${entryStat?.size ?? 0}`);
  const isDirectoryShaped = /[/\\]index\.(ts|js)$/.test(extensionPath);
  if (!isDirectoryShaped) return parts.join('|');

  const dir = extensionPath.replace(/[/\\][^/\\]+$/, '');
  const queue = [dir];
  let scanned = 0;
  while (queue.length > 0 && scanned < maxScanEntries) {
    const current = queue.shift();
    if (current === undefined) break;
    let entries: ExtensionDirEntry[];
    try {
      entries = await readdirFn(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory) {
        queue.push(full);
        continue;
      }
      if (scanned >= maxScanEntries) break;
      const info = await statFn(full);
      parts.push(`${full}:${info?.mtimeMs ?? 'missing'}:${info?.size ?? 0}`);
      scanned += 1;
    }
  }
  parts.sort();
  return parts.join('|');
}

export class ExtensionFactoryCache {
  private readonly deps: ExtensionFactoryCacheDeps;
  private readonly maxScanEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private importFactory?: (extensionPath: string) => Promise<unknown | undefined>;
  private seedFactory?: (extensionPath: string, factory: unknown, cwd: string) => boolean;
  private counters: ExtensionFactoryCacheStats = { discovered: 0, cached: 0, imports: 0, reimports: 0, pruned: 0 };
  private scanEntryCount = 0;
  constructor(deps: ExtensionFactoryCacheDeps = {}) {
    this.deps = deps;
    this.maxScanEntries = deps.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES;
    this.importFactory = deps.importFactory;
    this.seedFactory = deps.seedFactory;
  }

  /**
   * Test seam and runtime fallback: when the SDK accessors are absent the cache
   * stays inert (it will never import or seed), and the caller keeps today's
   * per-session loader path.
   */
  setAccessors(accessors: { importFactory?: (extensionPath: string) => Promise<unknown | undefined>; seedFactory?: (extensionPath: string, factory: unknown, cwd: string) => boolean } | undefined): void {
    this.importFactory = accessors?.importFactory;
    this.seedFactory = accessors?.seedFactory;
  }

  get statsSnapshot(): ExtensionFactoryCacheStats {
    return { ...this.counters };
  }

  /** Bounded counters (a copy; callers can never mutate the cache through it). */
  get stats(): ExtensionFactoryCacheStats {
    return { ...this.counters };
  }

  /** Entries read by the most recent fingerprint scan (bounded, for tests). */
  get lastScanEntryCount(): number {
    return this.scanEntryCount;
  }

  /** Discover global extensions and return their (possibly cached) factories. */
  async load(agentDir: string): Promise<CachedExtensionFactory[]> {
    const paths = await discoverGlobalExtensionPaths(agentDir, this.deps);
    this.counters.discovered = paths.length;
    const result: CachedExtensionFactory[] = [];
    const seen = new Set(paths);
    for (const path of paths) {
      const fingerprint = await extensionFingerprint(path, this.deps, this.maxScanEntries);
      this.scanEntryCount = fingerprint.split('|').filter((part) => !part.startsWith('entry:')).length;
      const cached = this.entries.get(path);
      if (cached && cached.fingerprint === fingerprint) {
        result.push({ path, factory: cached.factory, fingerprint });
        continue;
      }
      const factory = await this.importFactoryFor(path);
      if (factory === undefined) continue;
      if (cached) this.counters.reimports += 1;
      this.counters.imports += 1;
      this.entries.set(path, { factory, fingerprint });
      result.push({ path, factory, fingerprint });
    }
    for (const path of [...this.entries.keys()]) {
      if (seen.has(path)) continue;
      this.entries.delete(path);
      this.counters.pruned += 1;
    }
    this.counters.cached = this.entries.size;
    return result;
  }

  private async importFactoryFor(path: string): Promise<unknown | undefined> {
    if (!this.importFactory) return undefined;
    try {
      return await this.importFactory(path);
    } catch (error) {
      // A broken extension must not fail session creation; the loader will
      // report the same failure itself if the path is requested.
      logger.warn(`[ExtensionFactoryCache] import failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Place every cached global factory into the SDK module cache for `cwd`, so
   * the next `DefaultResourceLoader.reload()` reuses it instead of re-importing.
   */
  async seed(cwd: string, agentDir: string): Promise<{ available: boolean; seeded: number }> {
    if (!this.importFactory || !this.seedFactory) return { available: false, seeded: 0 };
    const factories = await this.load(agentDir);
    const resolvedCwd = resolve(cwd);
    let seeded = 0;
    for (const entry of factories) {
      try {
        if (this.seedFactory(entry.path, entry.factory, resolvedCwd)) seeded += 1;
      } catch (error) {
        logger.warn(`[ExtensionFactoryCache] seed failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { available: true, seeded };
  }

  reset(): void {
    this.entries.clear();
    this.counters = { discovered: 0, cached: 0, imports: 0, reimports: 0, pruned: 0 };
    this.scanEntryCount = 0;
  }
}

// ── SDK accessors (patch-present detection) ─────────────────────────────────

interface ExtensionFactorySdk {
  importExtensionFactory?: (extensionPath: string) => Promise<unknown | undefined>;
  seedExtensionFactory?: (extensionPath: string, factory: unknown, cwd: string) => boolean;
}

let sdkModulePromise: Promise<ExtensionFactorySdk> | undefined;

async function loadSdkModule(): Promise<ExtensionFactorySdk> {
  sdkModulePromise ??= import('@earendil-works/pi-coding-agent') as unknown as Promise<ExtensionFactorySdk>;
  return sdkModulePromise;
}

/** True when the additive patch is applied and both accessors are callable. */
export async function isExtensionFactorySeedingAvailable(): Promise<boolean> {
  const sdk = await loadSdkModule();
  return typeof sdk.importExtensionFactory === 'function' && typeof sdk.seedExtensionFactory === 'function';
}

let warningLogged = false;
let globalCache: ExtensionFactoryCache | undefined;

/** The process-wide cache, wired to the SDK accessors when the patch is present. */
export async function getExtensionFactoryCache(): Promise<ExtensionFactoryCache> {
  if (!globalCache) {
    const sdk = await loadSdkModule();
    const importFactory = sdk.importExtensionFactory;
    const seedFactory = sdk.seedExtensionFactory;
    const patched = typeof importFactory === 'function' && typeof seedFactory === 'function';
    globalCache = new ExtensionFactoryCache({
      importFactory: patched ? importFactory.bind(sdk) : undefined,
      seedFactory: patched ? seedFactory.bind(sdk) : undefined,
    });
    if (!patched && !warningLogged) {
      warningLogged = true;
      logger.warn(
        '[ExtensionFactoryCache] extension-factory accessors are absent (scripts/patch-pi-coding-agent-extension-factory.mjs not applied); ' +
        'falling back to the unpatched per-session extension import path. Sessions are unaffected; session opens remain slow.',
      );
    }
  }
  return globalCache;
}

/** Test seam. */
export function resetExtensionFactoryCache(): void {
  globalCache?.reset();
  globalCache = undefined;
  warningLogged = false;
  sdkModulePromise = undefined;
}

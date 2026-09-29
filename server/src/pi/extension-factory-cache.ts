import { opendir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
  type ExtensionAPI,
  type LoadExtensionsResult,
  type Extension as SdkExtension,
} from '@earendil-works/pi-coding-agent';
import { createLogger } from '../logging/logger.js';
import { ExtensionImporterError, importFactoryViaJiti } from './sdk-extension-importer.js';

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
 * per process with jiti and the SDK's own module aliasing (see
 * `sdk-extension-importer.ts`), and hand the factories to each session's
 * `DefaultResourceLoader` through the **public** `extensionFactories` option —
 * together with `noExtensions` + `additionalExtensionPaths` so every non-cached
 * extension (subagent, symlinked, over-budget, project-local, configured,
 * packages) still loads through the SDK's own discovery at the real cwd. The
 * loader initialises each factory per session (fresh Extension objects and
 * runtime) and `extensionsOverride` restores the exact paths, order and error
 * labels the discovered path would have produced.
 *
 * Failure contract (parent 01-answer.md item 2 — degrade at runtime, alarm in
 * CI): any failure in the factory pipeline (SDK version outside the validated
 * range, unresolvable alias target, jiti import failure, override hitting
 * frozen/changed result objects, parity self-check mismatch) degrades THAT
 * session to the plain uncached SDK loader with a rate-limited warning and a
 * diagnostics counter. The loud signal lives in the tests.
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
const DEFAULT_MAX_SCAN_ENTRIES = 2048;
const DEFAULT_MAX_SCAN_DIRS = 128;
const IMPORT_WARN_INTERVAL_MS = 5_000;

/**
 * Extensions whose module may be cached and reused across sessions.
 *
 * Caching an evaluated module also shares its **module-scope** state across
 * every session initialisation (fresh `Extension` objects and runtimes do not
 * isolate module state). The independent review found this concretely in the
 * global `subagent` extension (`backgroundManager`, `backgroundPiRef`,
 * `backgroundSessionFile`, `backgroundStatusCtx`) and required an explicit,
 * audited allowlist rather than caching everything.
 *
 * Audit rule: an extension is share-safe only if no module-scope mutable
 * binding exists in any file it loads — no top-level `let`/`var`, no
 * `const` bound to a `Map`/`Set`/`WeakMap`/array/object/class instance, no
 * `process.on/once`, no module-level timer. Findings (file:line):
 *
 *   made share-safe by B1.3s (pi-enhancement b046a8a, owner option B):
 *     subagent              the per-session `let`s are gone; index.ts:169
 *                           BackgroundTaskManager is ONE deliberately process-wide
 *                           registry keyed by session (delivery routed to the owning
 *                           session); runtime.ts:142 mutationQueues is keyed by run
 *                           record path (process-safe)
 *   refactored to per-session scope and now cached (B1.3, pi-enhancement 8a4b768 / 9ad45d2):
 *     enhanced-plan-mode    `state` + `piRef` moved into the factory closure
 *     memory                `let state` moved into the factory closure
 *     goal-engine           auto-continue.ts error/overflow maps moved into
 *                           registerAutoContinueHooks (status-ui.ts:6 WeakMap is
 *                           keyed by the per-session UI object)
 *     web-tools             index.ts:43 request-keyed TTL content cache (class c)
 *     parallel-orchestrator index.ts:49/50 registries keyed by global
 *                           orchestration/worktree id (class c)
 *   share-safe (cached): everything else — agent-discovery, agent-os-inject,
 *     auto-compact-75, background-shell, cli-anything, commandcode-provider,
 *     compact-observability, subagent-evaluator, watch-wake, todo.
 *
 * The full audit table is in docs/plans/execution-reports/orchestration-scaling/B1.2.md.
 * The pre-existing same-cwd sharing of these modules is a follow-up for the
 * extension-store owner (pi-enhancement); this lane must not widen it.
 */
export const DEFAULT_SHARE_SAFE_EXTENSIONS: readonly string[] = [
  'agent-discovery',
  'agent-os-inject',
  'auto-compact-75',
  'background-shell',
  'cli-anything',
  'commandcode-provider',
  'compact-observability',
  'enhanced-plan-mode',
  'goal-engine',
  'memory',
  'parallel-orchestrator',
  'subagent',
  'subagent-evaluator',
  'watch-wake',
  'todo',
  'web-tools',
];

/** Process-wide serialisation of seed → loader.reload() (review major 2). */
let extensionLoadChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with exclusive access to the SDK's single process-global extension
 * cwd slot. Seeding and the loader's `loadExtensionsCached()` must form one
 * critical section: a concurrent open in another cwd would change the slot
 * between the two, clearing the first session's seeded entries and forcing both
 * to re-import on the event loop. A rejection never breaks the chain.
 */
export function runExtensionLoadCriticalSection<T>(fn: () => Promise<T>): Promise<T> {
  const run = extensionLoadChain.then(fn, fn);
  extensionLoadChain = run.then(() => undefined, () => undefined);
  return run;
}

export interface ExtensionDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface ExtensionFactoryCacheDeps {
  /** Import an extension module and return its default-export factory. Defaults to the public jiti importer. */
  importFactory?: (extensionPath: string) => Promise<unknown | undefined>;
  readdir?: (dir: string) => Promise<ExtensionDirEntry[]>;
  /** Streaming enumeration seam (preferred): lets the scanner stop at the budget. */
  opendir?: (dir: string) => Promise<AsyncIterable<ExtensionDirEntry>>;
  stat?: (path: string) => Promise<{ mtimeMs: number; size: number } | undefined>;
  readFile?: (path: string) => Promise<string>;
  /** Bound on files visited by the shared freshness scan. */
  maxScanEntries?: number;
  /** Bound on directories visited by the shared freshness scan. */
  maxScanDirs?: number;
  /**
   * Extension ids whose modules may be cached. Defaults to the audited
   * share-safe set; anything absent keeps the per-load import.
   */
  allowlist?: readonly string[];
}

export interface CachedExtensionFactory {
  path: string;
  factory: unknown;
  fingerprint: string;
}

/** What a scan produced, beyond the plain factory list (correction 02). */
export interface ExtensionFactoryLoadOutcome {
  factories: CachedExtensionFactory[];
  /** Resolved paths whose (re-)import failed on THIS scan; stale entries dropped. */
  failedPaths: string[];
  /** failure message per failed resolved path. */
  failureMessages: Map<string, string>;
  overBudget: boolean;
}

/**
 * One open loader's own `path → factory` snapshot (correction 02 major). The
 * loader's wrappers read ONLY this map — never the process cache — so cache
 * pruning or clearing cannot break an open session. `failed` entries make a
 * subsequent initialisation surface the import failure exactly like the
 * uncached path would (error entry, real path).
 */
export interface LoaderFactorySnapshot {
  readonly entries: Map<string, LoaderFactoryEntry>;
}

export type LoaderFactoryEntry =
  | { kind: 'factory'; factory: unknown }
  | { kind: 'failed'; message: string };

export interface ExtensionFactoryCacheStats {
  discovered: number;
  allowlisted: number;
  skipped: number;
  cached: number;
  imports: number;
  reimports: number;
  pruned: number;
  overBudget: boolean;
  unfingerprintable: number;
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

function toDirEntry(entry: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ExtensionDirEntry {
  return {
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
    isSymbolicLink: entry.isSymbolicLink(),
  };
}

/** Stream a directory with fs.opendir, closing the handle even on early break. */
async function defaultOpendir(dir: string): Promise<AsyncIterable<ExtensionDirEntry>> {
  const handle = await opendir(dir);
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const entry of handle) yield toDirEntry(entry);
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

/** Wrap a materialised listing as an async iterable (test seam only). */
function iterableFrom(entries: ExtensionDirEntry[]): AsyncIterable<ExtensionDirEntry> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const entry of entries) yield entry;
    },
  };
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
async function resolveExtensionEntries(
  dir: string,
  deps: Required<Pick<ExtensionFactoryCacheDeps, 'stat' | 'readFile'>>,
  exhausted?: () => boolean,
): Promise<string[]> {
  const packageJsonPath = join(dir, 'package.json');
  if (await deps.stat(packageJsonPath)) {
    try {
      const parsed = JSON.parse(await deps.readFile(packageJsonPath)) as { pi?: { extensions?: unknown } };
      const declared = parsed?.pi?.extensions;
      if (Array.isArray(declared) && declared.every((entry) => typeof entry === 'string') && declared.length > 0) {
        const entries: string[] = [];
        for (const relative of declared) {
          // Every manifest candidate is debited against the SAME hard budget.
          if (exhausted && exhausted()) break;
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
    if (exhausted && exhausted()) return [];
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

/** Extension id: the top-level directory name (or loose file basename). */
export function extensionId(entryPath: string, extensionsDir: string): string {
  const relative = entryPath.startsWith(`${extensionsDir}/`)
    ? entryPath.slice(extensionsDir.length + 1)
    : entryPath;
  const first = relative.split('/')[0];
  return first.replace(/\.(ts|js)$/, '');
}

export interface ExtensionTreeScan {
  /** Resolved entry paths the SDK's discovery would load (fingerprintable only). */
  entryPaths: string[];
  /** One fingerprint over every fingerprintable file in the tree. */
  fingerprint: string;
  overBudget: boolean;
  dirsVisited: number;
  entriesVisited: number;
  /** Filesystem operations performed (readdir + stat), for budget tests. */
  fsOps: number;
  /** Extension ids excluded from caching because their subtree contains a symlink. */
  unfingerprintable: string[];
}

const fingerprintPart = (path: string, info: { mtimeMs: number; size: number } | undefined): string =>
  `${path}:${info?.mtimeMs ?? 'missing'}:${info?.size ?? 0}`;

/**
 * Walk the global extensions tree ONCE, under one shared budget, producing the
 * SDK's entry paths and a freshness fingerprint. Round-2 review fixes:
 *
 *  - discovery is integrated into the budgeted walk (it used to readdir/stat the
 *    whole top level before the budget was consulted), and every readdir/stat is
 *    counted (`fsOps`) so the bound is testable;
 *  - a directory symlink is never followed and its extension is excluded from
 *    caching (`unfingerprintable`), because a helper edited beneath an unchanged
 *    directory symlink would otherwise leave the fingerprint unchanged.
 *
 * Over budget the caller declines to cache at all rather than traversing an
 * unbounded tree.
 */
export async function scanExtensionsTree(
  agentDir: string,
  overrides: ExtensionFactoryCacheDeps = {},
  budget: { maxDirs: number; maxEntries: number } = { maxDirs: DEFAULT_MAX_SCAN_DIRS, maxEntries: DEFAULT_MAX_SCAN_ENTRIES },
): Promise<ExtensionTreeScan> {
  const statFn = overrides.stat ?? defaultStat;
  const readFileFn = overrides.readFile ?? ((path: string) => readFile(path, 'utf-8'));
  const extensionsDir = join(agentDir, 'extensions');
  const parts: string[] = [];
  const entryPaths: string[] = [];
  const unfingerprintable = new Set<string>();
  let dirsVisited = 0;
  let entriesVisited = 0;
  let fsOps = 0;
  let overBudget = false;

  const statB = async (path: string) => { fsOps += 1; return statFn(path); };

  /**
   * ONE shared hard budget: every consumed directory entry and every manifest
   * candidate debits it, and the scan stops the moment it is exhausted. Returns
   * true when exhausted (the caller must stop).
   */
  const debitEntry = (): boolean => {
    if (entriesVisited >= budget.maxEntries) {
      overBudget = true;
      return true;
    }
    entriesVisited += 1;
    return false;
  };

  /**
   * Streamed enumeration: prefer the streaming seam, then the materialised test
   * seam, then real `fs.opendir`. Directory listings are never materialised in
   * full on the production path (round-3 review).
   */
  const openStream = async (dir: string): Promise<AsyncIterable<ExtensionDirEntry> | undefined> => {
    fsOps += 1;
    try {
      if (overrides.opendir) return await overrides.opendir(dir);
      if (overrides.readdir) return iterableFrom(await overrides.readdir(dir));
      return await defaultOpendir(dir);
    } catch {
      return undefined;
    }
  };

  const empty: ExtensionTreeScan = {
    entryPaths: [], fingerprint: '', overBudget: false, dirsVisited: 0, entriesVisited: 0, fsOps: 1, unfingerprintable: [],
  };

  const rootStream = await openStream(extensionsDir);
  if (!rootStream) return empty;

  const queue: Array<{ dir: string; id: string }> = [];
  for await (const entry of rootStream) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (debitEntry()) break;
    const full = join(extensionsDir, entry.name);
    const info = await statB(full);
    parts.push(fingerprintPart(full, info));
    const id = entry.name.replace(/\.(ts|js)$/, '');
    if (entry.isSymbolicLink) {
      // Never follow a symlinked extension: its subtree cannot be fingerprinted.
      unfingerprintable.add(id);
      continue;
    }
    if (entry.isFile && extensionName(entry.name)) {
      entryPaths.push(full);
      continue;
    }
    if (entry.isDirectory) {
      const resolved = await resolveExtensionEntries(full, { stat: statB, readFile: readFileFn }, debitEntry);
      entryPaths.push(...resolved);
      queue.push({ dir: full, id });
    }
  }

  // Fingerprint walk over the same budget; directory symlinks are not followed.
  while (queue.length > 0) {
    if (dirsVisited >= budget.maxDirs) { overBudget = true; break; }
    const current = queue.shift();
    if (current === undefined) break;
    dirsVisited += 1;
    const stream = await openStream(current.dir);
    if (!stream) continue;
    for await (const entry of stream) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (debitEntry()) break;
      const full = join(current.dir, entry.name);
      const info = await statB(full);
      parts.push(fingerprintPart(full, info));
      if (entry.isSymbolicLink) {
        unfingerprintable.add(current.id);
        continue;
      }
      if (entry.isDirectory) queue.push({ dir: full, id: current.id });
    }
    if (overBudget) break;
  }

  parts.sort();
  return {
    entryPaths: entryPaths.filter((path) => !unfingerprintable.has(extensionId(path, extensionsDir))),
    fingerprint: parts.join('|'),
    overBudget,
    dirsVisited,
    entriesVisited,
    fsOps,
    unfingerprintable: [...unfingerprintable],
  };
}

export class ExtensionFactoryCache {
  private readonly deps: ExtensionFactoryCacheDeps;
  private readonly maxScanEntries: number;
  private readonly maxScanDirs: number;
  private readonly allowlist: ReadonlySet<string>;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly importFactory: (extensionPath: string) => Promise<unknown | undefined>;
  private counters: ExtensionFactoryCacheStats = { discovered: 0, allowlisted: 0, skipped: 0, cached: 0, imports: 0, reimports: 0, pruned: 0, overBudget: false, unfingerprintable: 0 };
  private scanEntryCount = 0;
  private overBudgetWarned = false;
  private lastImportWarnAt = 0;
  constructor(deps: ExtensionFactoryCacheDeps = {}) {
    this.deps = deps;
    this.maxScanEntries = deps.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES;
    this.maxScanDirs = deps.maxScanDirs ?? DEFAULT_MAX_SCAN_DIRS;
    this.allowlist = new Set(deps.allowlist ?? DEFAULT_SHARE_SAFE_EXTENSIONS);
    this.importFactory = deps.importFactory ?? importFactoryViaJiti;
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

  /** Discover global extensions and return the allowlisted, cached factories. */
  async load(agentDir: string): Promise<CachedExtensionFactory[]> {
    return (await this.loadWithOutcome(agentDir)).factories;
  }

  /**
   * `load()` plus the outcome a loader refresh needs: which allowlisted paths
   * FAILED to import on this scan (their stale entries are dropped — an open
   * session's snapshot decides what to do), and whether the scan was
   * over budget. Import failures are aggregated into ONE rate-limited warning
   * per scan (correction 02 minor: no per-extension warning flood).
   */
  async loadWithOutcome(agentDir: string): Promise<ExtensionFactoryLoadOutcome> {
    return this.loadOutcome(agentDir);
  }

  private async loadOutcome(agentDir: string): Promise<ExtensionFactoryLoadOutcome> {
    const extensionsDir = join(agentDir, 'extensions');
    const scan = await scanExtensionsTree(agentDir, this.deps, { maxDirs: this.maxScanDirs, maxEntries: this.maxScanEntries });
    this.scanEntryCount = Math.min(scan.entriesVisited, this.maxScanEntries);
    this.counters.unfingerprintable = scan.unfingerprintable.length;
    const allowed = scan.entryPaths.filter((path) => this.allowlist.has(extensionId(path, extensionsDir)));
    this.counters.discovered = scan.entryPaths.length;
    this.counters.allowlisted = allowed.length;
    this.counters.skipped = scan.entryPaths.length - allowed.length;
    if (scan.overBudget) {
      // Decline to cache at all: an unbounded tree must not be traversed, and a
      // partial fingerprint would silently freeze stale factories.
      this.counters.overBudget = true;
      this.counters.cached = 0;
      this.entries.clear();
      if (!this.overBudgetWarned) {
        this.overBudgetWarned = true;
        logger.warn(
          `[ExtensionFactoryCache] extension tree exceeds the scan budget (dirs ${scan.dirsVisited}, entries ${scan.entriesVisited}); ` +
          'falling back to the unpatched per-session import path for every extension (sessions are unaffected; opens stay slow).',
        );
      }
      return { factories: [], failedPaths: [], failureMessages: new Map(), overBudget: true };
    }
    this.counters.overBudget = false;

    const result: CachedExtensionFactory[] = [];
    const failedPaths = new Map<string, string>();
    for (const path of allowed) {
      const cached = this.entries.get(path);
      if (cached && cached.fingerprint === scan.fingerprint) {
        result.push({ path, factory: cached.factory, fingerprint: scan.fingerprint });
        continue;
      }
      const attempted = await this.importFactoryFor(path);
      if (attempted === undefined) {
        // Correction 02: a failed (re-)import drops any stale entry — the
        // module is NOT kept serving as if fresh. Open sessions keep their own
        // per-loader snapshot until their refresh marks the path failed.
        this.entries.delete(path);
        failedPaths.set(resolve(path), this.lastImportError ?? 'import failed');
        continue;
      }
      if (cached) this.counters.reimports += 1;
      this.counters.imports += 1;
      this.entries.set(path, { factory: attempted, fingerprint: scan.fingerprint });
      result.push({ path, factory: attempted, fingerprint: scan.fingerprint });
    }
    if (failedPaths.size > 0) this.warnImportFailures(failedPaths);
    const keep = new Set(allowed);
    for (const path of [...this.entries.keys()]) {
      if (keep.has(path)) continue;
      this.entries.delete(path);
      this.counters.pruned += 1;
    }
    this.counters.cached = this.entries.size;
    return {
      factories: result,
      failedPaths: [...failedPaths.keys()],
      failureMessages: failedPaths,
      overBudget: false,
    };
  }

  private lastImportError: string | undefined;

  private async importFactoryFor(path: string): Promise<unknown | undefined> {
    try {
      const factory = await this.importFactory(path);
      this.lastImportError = undefined;
      return factory;
    } catch (error) {
      // A broken extension must not fail session creation; the loader reports
      // the failure per session, exactly like the uncached path. The per-scan
      // aggregate warning lives in warnImportFailures (rate-limited).
      this.lastImportError = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  }

  /**
   * ONE aggregated, rate-limited warning per scan for importer failures
   * (correction 02 minor: repeated opens must not flood the log).
   */
  private warnImportFailures(failedPaths: Map<string, string>): void {
    const now = Date.now();
    if (now - this.lastImportWarnAt < IMPORT_WARN_INTERVAL_MS) return;
    this.lastImportWarnAt = now;
    const paths = [...failedPaths.keys()];
    const shown = paths.slice(0, 10);
    logger.warn(
      `[ExtensionFactoryCache] ${paths.length} extension import(s) failed this scan: ${shown.join(', ')}` +
      `${paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : ''}; ` +
      'affected extensions stay uncached (per-session loads report the error).',
    );
  }

  reset(): void {
    this.entries.clear();
    this.counters = { discovered: 0, allowlisted: 0, skipped: 0, cached: 0, imports: 0, reimports: 0, pruned: 0, overBudget: false, unfingerprintable: 0 };
    this.overBudgetWarned = false;
    this.scanEntryCount = 0;
  }
}

// ── Factory delivery through the public SDK API (B1.2b) ─────────────────────

export interface ExtensionLoaderTelemetry {
  fallbacks: number;
  lastFallbackReason?: string;
  lastFallbackAt?: string;
}

const FALLBACK_WARN_INTERVAL_MS = 5_000;
const fallbackTelemetry: Required<Pick<ExtensionLoaderTelemetry, 'fallbacks'>> & {
  lastFallbackReason?: string;
  lastFallbackAt?: string;
  lastWarningAt: number;
} = { fallbacks: 0, lastWarningAt: 0 };

/** Bounded copy of the degradation counter (a fallback never blocks a session). */
export function getExtensionLoaderTelemetry(): ExtensionLoaderTelemetry {
  return {
    fallbacks: fallbackTelemetry.fallbacks,
    lastFallbackReason: fallbackTelemetry.lastFallbackReason,
    lastFallbackAt: fallbackTelemetry.lastFallbackAt,
  };
}

/** Test seam. */
export function resetExtensionLoaderTelemetry(): void {
  fallbackTelemetry.fallbacks = 0;
  fallbackTelemetry.lastFallbackReason = undefined;
  fallbackTelemetry.lastFallbackAt = undefined;
  fallbackTelemetry.lastWarningAt = 0;
}

function noteFallback(reason: string): void {
  fallbackTelemetry.fallbacks += 1;
  fallbackTelemetry.lastFallbackReason = reason;
  fallbackTelemetry.lastFallbackAt = new Date().toISOString();
  const now = Date.now();
  if (now - fallbackTelemetry.lastWarningAt >= FALLBACK_WARN_INTERVAL_MS) {
    fallbackTelemetry.lastWarningAt = now;
    logger.warn(
      `[ExtensionFactoryCache] extension factory loading degraded to the plain uncached SDK path (reason: ${reason}); ` +
      'sessions are unaffected — session opens stay slow until the cause is fixed.',
    );
  }
}

/** Strip the loader's single `<inline:name>` wrapper (name = the real path). */
const stripInlineLabel = (label: string): string | undefined =>
  label.startsWith('<inline:') && label.endsWith('>') ? label.slice('<inline:'.length, -1) : undefined;

export interface ExtensionLoaderDeps {
  /** The process cache (default: the singleton). */
  cache?: ExtensionFactoryCache;
  /** Test seam: force the extensionsOverride to throw (frozen/changed result objects). */
  forceOverrideFailure?: boolean;
  /** Test seam: tamper with the parity self-check so it reports a mismatch. */
  tamperParityCheck?: boolean;
  /** Test seam: replace the plain fallback loader construction. */
  createPlainLoader?: (cwd: string, agentDir: string) => DefaultResourceLoader;
}

/**
 * Restore full parity on the loader's extension result: real paths, real order,
 * rewritten error labels. Runs BEFORE the loader recomputes every sourceInfo
 * from `metadataByPath`, so sourceInfo comes out identical to the discovered
 * path. Throws on any structural surprise (frozen objects, missing entries) —
 * the caller degrades that session to the plain loader.
 */
export function applyExtensionFactoryParity(
  result: LoadExtensionsResult,
  enabledOrder: readonly string[],
  options: { tamperParityCheck?: boolean; generatedLabels?: readonly string[] } = {},
): LoadExtensionsResult {
  // Correction 02 (minor) + correction 03 (minor): normalise `<inline:…>`
  // labels in error paths AND in embedded message text (conflict diagnostics
  // name the conflicting owner path in the message) — but ONLY the exact
  // labels this loader generated (`<inline:${factory.path}>` for its known
  // factory paths). Extension-authored diagnostic text containing arbitrary
  // `<inline:…>` substrings must stay verbatim.
  const generatedLabels = options.generatedLabels ?? [];
  const labelRewrites = generatedLabels.map((path) => ({ label: `<inline:${path}>`, path }));
  const rewriteGeneratedLabels = (text: string): string => {
    let rewritten = text;
    for (const { label, path } of labelRewrites) {
      rewritten = rewritten.split(label).join(path);
    }
    return rewritten;
  };
  const isGeneratedLabel = (candidate: string | undefined): string | undefined => {
    if (candidate === undefined) return undefined;
    const inner = stripInlineLabel(candidate);
    return inner !== undefined && generatedLabels.includes(inner) ? inner : undefined;
  };
  const erroredRealPaths = new Set<string>();
  for (const error of result.errors) {
    const realPath = isGeneratedLabel(error.path);
    if (realPath !== undefined) error.path = realPath;
    if (typeof error.error === 'string' && labelRewrites.some(({ label }) => error.error.includes(label))) {
      error.error = rewriteGeneratedLabels(error.error);
    }
    if (typeof error.path === 'string') erroredRealPaths.add(resolve(error.path));
  }

  const loaded = [...result.extensions];
  const used = new Set<SdkExtension>();
  const ordered: SdkExtension[] = [];
  let erroredExpected = 0;
  for (const enabledPath of enabledOrder) {
    const resolvedPath = resolve(enabledPath);
    const match = loaded.find((extension) => {
      if (used.has(extension)) return false;
      const candidate = extension.path.startsWith('<inline:') ? stripInlineLabel(extension.path) : extension.path;
      return candidate !== undefined && resolve(candidate) === resolvedPath;
    });
    if (match !== undefined) {
      used.add(match);
      if (match.path.startsWith('<inline:')) {
        // Mutating public result fields; a future SDK that freezes these fails
        // loudly here and the session degrades to the plain loader.
        match.path = resolvedPath;
        match.resolvedPath = resolvedPath;
      }
      ordered.push(match);
      continue;
    }
    // Correction 02 (major): an extension whose re-import failed is absent from
    // `extensions` and present in `errors` with its real path — exactly what
    // the uncached path produces. Parity counts it as accounted for.
    if (erroredRealPaths.has(resolvedPath)) {
      erroredExpected += 1;
      continue;
    }
  }
  if (options.tamperParityCheck) ordered.splice(0, 1);
  if (ordered.length + erroredExpected !== enabledOrder.length || used.size !== loaded.length) {
    const missing = enabledOrder.length - ordered.length - erroredExpected;
    throw new ExtensionImporterError(
      `extension parity self-check failed: ${missing} expected extension(s) missing, ${loaded.length - used.size} unexpected loaded extension(s)`,
    );
  }
  result.extensions = ordered;
  return result;
}

/**
 * Build the session's resource loader with cached factories delivered through
 * the public API. Any failure inside the factory pipeline degrades to the
 * plain uncached SDK loader (normal discovery, no factories) — never throws
 * into session creation.
 */
export interface ExtensionFactoryLoaderResult {
  loader: DefaultResourceLoader;
  /** The loader's own factory snapshot; `undefined` for the plain fallback loader. */
  snapshot?: LoaderFactorySnapshot;
}

export async function createExtensionFactoryResourceLoader(
  cwd: string,
  agentDir: string,
  deps: ExtensionLoaderDeps = {},
  onLoaded?: (loader: DefaultResourceLoader) => void,
): Promise<ExtensionFactoryLoaderResult> {
  try {
    return await buildFactoryBackedLoader(cwd, agentDir, deps, onLoaded);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    noteFallback(reason);
    const loader = deps.createPlainLoader?.(cwd, agentDir) ?? new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload();
    onLoaded?.(loader);
    return { loader, snapshot: undefined };
  }
}

async function buildFactoryBackedLoader(
  cwd: string,
  agentDir: string,
  deps: ExtensionLoaderDeps,
  onLoaded?: (loader: DefaultResourceLoader) => void,
): Promise<ExtensionFactoryLoaderResult> {
  // Per-loader SettingsManager: the loader mutates project-trust state on it,
  // so it must never be shared across sessions. The pre-pass reload mirrors the
  // loader's own internal sequence (reload settings → resolve).
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload();
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolvedPaths = await packageManager.resolve();
  const enabledOrder = resolvedPaths.extensions.filter((resource) => resource.enabled).map((resource) => resource.path);

  const cache = deps.cache ?? (await getExtensionFactoryCache());
  const { factories } = await cache.loadWithOutcome(agentDir);
  const stats = cache.stats;
  // Systemic importer failure (SDK version out of range, alias map broken, jiti
  // unavailable): every allowlisted extension failed to import — degrade the
  // whole session to the plain uncached path. A single broken extension is NOT
  // systemic: it stays uncached and the loader reports it per session, exactly
  // like today's uncached path.
  if (!stats.overBudget && stats.allowlisted > 0 && factories.length === 0) {
    throw new ExtensionImporterError(
      `all ${stats.allowlisted} allowlisted extension factories failed to import (systemic importer failure)`,
    );
  }
  const factoryPaths = new Set(factories.map((factory) => resolve(factory.path)));
  const additionalPaths = enabledOrder.filter((path) => !factoryPaths.has(resolve(path)));

  // Correction 02 (major): the loader reads ONLY its own snapshot — never the
  // process cache — so cache pruning/clearing cannot break an open session.
  // refreshExtensionFactories swaps entries on this map atomically, only with
  // successful imports; a failed re-import marks the entry `failed`, which the
  // wrapper surfaces as the uncached path's load error.
  const snapshot: LoaderFactorySnapshot = {
    entries: new Map(factories.map((factory) => [resolve(factory.path), { kind: 'factory' as const, factory: factory.factory }])),
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: additionalPaths,
    extensionFactories: factories.map((factory) => ({
      // name = the real path: the loader labels the entry `<inline:${name}>`,
      // and applyExtensionFactoryParity strips exactly that one wrapper.
      name: factory.path,
      factory: (api: ExtensionAPI): void | Promise<void> => {
        const entry = snapshot.entries.get(resolve(factory.path));
        if (!entry || entry.kind !== 'factory' || typeof entry.factory !== 'function') {
          throw new Error(
            `Failed to load extension: ${entry && entry.kind === 'failed' ? entry.message : `cached factory unavailable for ${factory.path}`}`,
          );
        }
        return (entry.factory as (api: ExtensionAPI) => void | Promise<void>)(api);
      },
    })),
    extensionsOverride: (result: LoadExtensionsResult) => {
      if (deps.forceOverrideFailure) {
        throw new ExtensionImporterError('extensionsOverride hit frozen or changed result objects (simulated)');
      }
      return applyExtensionFactoryParity(result, enabledOrder, {
        tamperParityCheck: deps.tamperParityCheck,
        generatedLabels: factories.map((factory) => factory.path),
      });
    },
  });
  await loader.reload();
  onLoaded?.(loader);
  return { loader, snapshot };
}

/**
 * Refresh ONE loader's factory snapshot for its /reload (pi-service,
 * inside the extension-load critical section). Atomic and
 * successful-imports-only:
 *  - a changed extension whose re-import succeeds swaps the snapshot entry for
 *    the new factory (the next `.reload()` initialises the new code);
 *  - a failed re-import marks the entry `failed` — the next `.reload()`
 *    surfaces the import error exactly like the uncached path (no stale code);
 *  - a removed extension leaves the entry untouched — the open session keeps
 *    its snapshot (file-set changes take effect at the next open);
 *  - an over-budget scan leaves the whole snapshot untouched.
 * Without a snapshot (plain fallback loader) this is a no-op.
 */
export async function refreshExtensionFactories(
  agentDir: string,
  deps: { cache?: ExtensionFactoryCache; snapshot?: LoaderFactorySnapshot } = {},
): Promise<void> {
  const snapshot = deps.snapshot;
  if (!snapshot) return;
  const cache = deps.cache ?? (await getExtensionFactoryCache());
  const outcome = await cache.loadWithOutcome(agentDir);
  if (outcome.overBudget) return;
  const freshByPath = new Map(outcome.factories.map((factory) => [resolve(factory.path), factory]));
  const failedSet = new Set(outcome.failedPaths);
  // Atomic per-path swap on the snapshot: entries are only ever replaced or
  // newly set, never deleted — an open loader cannot lose a factory here.
  for (const [path, existing] of snapshot.entries) {
    if (failedSet.has(path)) {
      snapshot.entries.set(path, { kind: 'failed', message: outcome.failureMessages.get(path) ?? 'import failed' });
      continue;
    }
    const fresh = freshByPath.get(path);
    if (fresh) snapshot.entries.set(path, { kind: 'factory', factory: fresh.factory });
    if (!fresh && existing.kind === 'failed') {
      // The path is gone from discovery: the failure marker no longer applies
      // (a next open would simply not include the extension); leave the last
      // state — the loader keeps its snapshot either way.
    }
  }
}

// ── Process-wide cache ───────────────────────────────────────────────────────

let globalCache: ExtensionFactoryCache | undefined;

/** The process-wide cache (jiti importer by default — no patch, no accessors). */
export async function getExtensionFactoryCache(deps?: ExtensionFactoryCacheDeps): Promise<ExtensionFactoryCache> {
  globalCache ??= new ExtensionFactoryCache(deps);
  return globalCache;
}

/** Test seam. */
export function resetExtensionFactoryCache(): void {
  globalCache?.reset();
  globalCache = undefined;
}
